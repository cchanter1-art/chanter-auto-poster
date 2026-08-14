'use strict';

// YouTube provider adapter (Provider #2).
//
// Owns provider-specific behavior only: Google OAuth (server-side
// authorization-code flow with PKCE), credential refresh, safe channel
// resolution, resumable video upload, status lookup, and provider error
// normalization. Ownership, approval, queue creation, scheduling, and
// locking stay in the application service and worker exactly as they do
// for TikTok.
//
// Safety policy hard-wired here:
//   - privacyStatus is 'private' unless the job explicitly requested another
//     visibility AND the deployment authorizes it (config.youtube.privateOnly)
//   - notifySubscribers is ALWAYS false
//   - images are never accepted
//   - no publishAt / native scheduling (the product queue is the scheduler)
//
// Token custody: this module only handles plaintext tokens in memory
// between a Google response and tokenVault encryption (or between vault
// decryption and an Authorization header). Nothing here persists or logs a
// plaintext token.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHash, randomBytes, randomUUID } = require('crypto');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const config = require('./config');
const storage = require('./storage');
const tokenVault = require('./tokenVault');
const mediaPolicy = require('./mediaPolicy');
const providers = require('./providers');
const {
  RECEIPT_METHOD,
  canonicalSha256,
  completionStateForVisibility,
  providerUploadStatus,
  sanitizeProviderOperation,
  sanitizeRequestedVisibility
} = require('./youtubeProviderOperation');
const {
  approvedMediaMatches,
  inspectMp4File,
  sanitizeApprovedMediaIdentity
} = require('./approvedMediaIdentity');
const {
  safeDiagnosticText,
  sanitizeProviderMaterial
} = require('./forbiddenMaterial');

const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const UPLOAD_SCOPE = 'https://www.googleapis.com/auth/youtube.upload';
const READONLY_SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';
const MAX_TITLE_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 5000;
const UPLOAD_METHOD = 'resumable';
const VERIFICATION_ATTEMPTS = 3;
const VERIFICATION_BACKOFF_MS = Object.freeze([250, 1_000]);

const SENSITIVE_KEYS = new Set([
  'access_token', 'accessToken', 'refresh_token', 'refreshToken',
  'client_secret', 'clientSecret', 'code', 'id_token', 'idToken',
  'authorization', 'Authorization', 'codeVerifier', 'code_verifier',
  'credentialEnvelope', 'sessionUrl', 'sessionLocator', 'sessionLocatorEnvelope'
]);

function redactSensitive(value) {
  if (value == null) return value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redactSensitive);
  const result = {};
  for (const [key, val] of Object.entries(value)) {
    if (SENSITIVE_KEYS.has(key)) result[key] = '[REDACTED]';
    else if (val && typeof val === 'object') result[key] = redactSensitive(val);
    else result[key] = val;
  }
  return result;
}

function safeWarn(label, obj) {
  console.warn(label, JSON.stringify(sanitizeProviderMaterial(redactSensitive(obj))));
}

function requestSignal(timeoutMs = config.youtube.requestTimeoutMs) {
  return AbortSignal.timeout(Math.max(1, Number(timeoutMs) || 30_000));
}

/** Reads a response body as JSON, returning null for empty/non-JSON bodies. */
async function parseResponseBody(response) {
  let text = '';
  try {
    text = await response.text();
  } catch (error) {
    return null;
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    return null;
  }
}

// ── Configuration truth ────────────────────────────────────────────────────

// Single source: the provider registry owns configuration truth; the
// adapter re-exports it so callers that only know the adapter still get
// the same answer.
const { getYouTubeConfigStatus } = providers;

function isYouTubeConfigured() {
  return getYouTubeConfigStatus().configured;
}

// ── OAuth: authorize URL, PKCE, code exchange, refresh, revoke ─────────────

/** RFC 7636 S256 PKCE pair via Node stdlib. */
function createPkcePair() {
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function configuredScopes() {
  return String(config.youtube.scopes || '')
    .split(/[,\s]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
}

/**
 * Builds the Google authorize URL. `prompt=consent` is only sent when the
 * caller knows a refresh token must be (re)issued — never on every visit.
 */
function buildYouTubeAuthUrl(state, { codeChallenge, forceConsent = false } = {}) {
  const url = new URL(config.youtube.authUrl);
  const params = {
    client_id: config.youtube.clientId,
    response_type: 'code',
    redirect_uri: config.youtube.redirectUri,
    scope: configuredScopes().join(' '),
    access_type: 'offline',
    include_granted_scopes: 'true',
    state
  };
  if (codeChallenge) {
    params.code_challenge = codeChallenge;
    params.code_challenge_method = 'S256';
  }
  if (forceConsent) params.prompt = 'consent';
  url.search = new URLSearchParams(params).toString();
  return url.toString();
}

async function requestGoogleToken(params) {
  const status = getYouTubeConfigStatus();
  if (!status.configured) {
    const error = new Error(`YouTube OAuth is not configured (missing: ${status.missing.join(', ')}).`);
    error.code = 'youtube_not_configured';
    throw error;
  }
  const response = await fetch(config.youtube.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.youtube.clientId,
      client_secret: config.youtube.clientSecret,
      ...params
    }).toString(),
    signal: requestSignal()
  });
  const body = await parseResponseBody(response);
  if (!response.ok || (body && body.error)) {
    const error = new Error(normalizeGoogleOAuthErrorMessage(body, response.status));
    error.code = isInvalidGrant(body) ? 'reauthorization_required' : 'google_oauth_error';
    error.status = response.status;
    throw error;
  }
  return body || {};
}

async function exchangeCodeForToken(code, codeVerifier) {
  const body = await requestGoogleToken({
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.youtube.redirectUri,
    ...(codeVerifier ? { code_verifier: codeVerifier } : {})
  });
  return normalizeTokenResponse(body);
}

async function refreshAccessToken(refreshToken) {
  const body = await requestGoogleToken({
    grant_type: 'refresh_token',
    refresh_token: refreshToken
  });
  return normalizeTokenResponse(body, { refresh_token: refreshToken });
}

/**
 * Best-effort Google-side revocation. Returns { revoked } and never
 * throws — the caller must clear local credentials regardless and report
 * a revocation failure truthfully.
 */
async function revokeToken(token) {
  if (!token) return { revoked: false, reason: 'No token available to revoke.' };
  try {
    const response = await fetch(config.youtube.revokeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
      signal: requestSignal()
    });
    if (response.ok) return { revoked: true };
    return { revoked: false, reason: `Google revocation returned HTTP ${response.status}.` };
  } catch (error) {
    return { revoked: false, reason: `Google revocation failed: ${error.message}` };
  }
}

/**
 * Normalizes a Google token response into { tokens, meta } where `tokens`
 * is the plaintext payload destined for the vault and `meta` is the safe
 * metadata destined for the account record. A missing refresh_token in the
 * response PRESERVES the previous refresh token (Google only reissues it
 * on consent), never overwrites it with null.
 */
function normalizeTokenResponse(body, previous = {}) {
  const expiresIn = Number(body.expires_in || 0);
  const accessTokenExpiresAt = expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000).toISOString() : null;
  const refreshToken = body.refresh_token || previous.refresh_token || '';
  const tokens = {
    access_token: body.access_token || '',
    refresh_token: refreshToken
  };
  return {
    tokens,
    meta: {
      tokenPresent: Boolean(tokens.access_token),
      refreshTokenPresent: Boolean(refreshToken),
      accessTokenExpiresAt,
      grantedScopes: String(body.scope || previous.scope || '').trim(),
      refreshTokenRotated: Boolean(body.refresh_token)
    }
  };
}

/** Encrypts a normalized token payload for persistence. */
function encryptTokens(tokens) {
  return tokenVault.encryptCredentials(tokens);
}

// ── Channel resolution ─────────────────────────────────────────────────────

/**
 * Resolves the channels of the authenticated Google identity. Requires the
 * youtube.readonly scope; a 403 here is normalized to a truthful
 * missing-scope failure instead of a generic error.
 */
async function listMyChannels(accessToken) {
  const url = new URL(`${config.youtube.apiBaseUrl}/channels`);
  url.search = new URLSearchParams({ part: 'snippet', mine: 'true', maxResults: '50' }).toString();
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: requestSignal()
  });
  const body = await parseResponseBody(response);
  if (!response.ok) {
    const error = new Error(normalizeGoogleApiErrorMessage(body, response.status, 'YouTube channel lookup'));
    error.code = response.status === 403 ? 'missing_readonly_scope' : 'youtube_api_error';
    error.status = response.status;
    throw error;
  }
  const items = body && Array.isArray(body.items) ? body.items : [];
  return items.map((item) => {
    const snippet = item && item.snippet ? item.snippet : {};
    const thumbnails = snippet.thumbnails || {};
    const thumbnail = (thumbnails.default && thumbnails.default.url)
      || (thumbnails.medium && thumbnails.medium.url) || '';
    return {
      channelId: String(item.id || ''),
      title: String(snippet.title || ''),
      handle: String(snippet.customUrl || ''),
      thumbnailUrl: /^https:\/\//.test(String(thumbnail)) ? String(thumbnail) : ''
    };
  }).filter((channel) => channel.channelId);
}

// ── Connection finalization ────────────────────────────────────────────────

/** Decrypts a stored credential envelope (custody stays in this module). */
function decryptTokens(envelope) {
  return tokenVault.decryptCredentials(envelope);
}

/**
 * Persists one resolved channel as a connected account. Preservation rule:
 * when Google returned no new refresh token (normal on reconnect without a
 * consent prompt), the previously stored encrypted refresh token is merged
 * forward — never overwritten with null. If no refresh path exists at all,
 * the account is saved but immediately marked reauthorization_required so
 * it can never be presented as ready without offline access.
 */
async function finalizeYouTubeConnection({
  userId,
  channel,
  tokens,
  meta,
  workspaceScope,
  activationContext
}) {
  let finalTokens = { ...tokens };
  if (!finalTokens.refresh_token) {
    const existingEnvelope = await storage.getYouTubeAccountCredential(
      userId,
      channel.channelId,
      workspaceScope
    );
    if (existingEnvelope) {
      try {
        const previous = tokenVault.decryptCredentials(existingEnvelope);
        if (previous.refresh_token) finalTokens.refresh_token = previous.refresh_token;
      } catch (error) {
        // The old envelope is unreadable (rotated key, tampering): treat as
        // no stored refresh token rather than failing the whole reconnect.
      }
    }
  }
  const refreshTokenPresent = Boolean(finalTokens.refresh_token);
  const account = await storage.saveYouTubeAccount(userId, {
    channelId: channel.channelId,
    profile: channel,
    credentialEnvelope: encryptTokens(finalTokens),
    tokenMeta: {
      ...meta,
      tokenPresent: Boolean(finalTokens.access_token),
      refreshTokenPresent
    }
  }, workspaceScope, activationContext);
  if (!refreshTokenPresent) {
    await storage.markYouTubeAccountReauthorizationRequired(
      userId,
      channel.channelId,
      'no_refresh_token',
      workspaceScope
    );
    return { account: { ...account, reauthorizationRequired: true }, refreshTokenPresent: false };
  }
  return { account, refreshTokenPresent: true };
}

// ── Active credentials for publishing ──────────────────────────────────────

/**
 * Resolves usable credentials for one connected YouTube account: decrypts
 * the stored envelope and refreshes the access token server-side when it
 * is missing or near expiry. Refresh results are persisted atomically
 * (refresh token preserved unless rotated); invalid_grant marks the
 * account reauthorization_required. Returns { ok, accessToken } or
 * { ok: false, code, reason }.
 */
async function getActiveYouTubeCredentials(userId, accountId, workspaceScope) {
  const account = await storage.getYouTubeAccount(userId, accountId, workspaceScope);
  if (!account || !account.connected) {
    return { ok: false, code: 'account_disconnected', reason: `YouTube channel ${accountId} is not connected.` };
  }
  if (account.reauthorizationRequired) {
    return { ok: false, code: 'reauthorization_required', reason: 'YouTube channel requires reauthorization. Reconnect it from the AutoPoster site.' };
  }
  const envelope = await storage.getYouTubeAccountCredential(userId, accountId, workspaceScope);
  if (!envelope) {
    return { ok: false, code: 'credentials_unavailable', reason: 'No stored YouTube credentials for this channel.' };
  }
  let tokens;
  try {
    tokens = tokenVault.decryptCredentials(envelope);
  } catch (error) {
    return { ok: false, code: error.code || 'vault_decrypt_failed', reason: 'Stored YouTube credentials could not be decrypted.' };
  }

  const expiresAtMs = account.accessTokenExpiresAt ? Date.parse(account.accessTokenExpiresAt) : NaN;
  const needsRefresh = !tokens.access_token
    || (Number.isFinite(expiresAtMs) && expiresAtMs - TOKEN_REFRESH_BUFFER_MS <= Date.now());
  if (!needsRefresh) return { ok: true, accessToken: tokens.access_token };

  if (!tokens.refresh_token) {
    await storage.markYouTubeAccountReauthorizationRequired(
      userId,
      accountId,
      'no_refresh_token',
      workspaceScope
    );
    return { ok: false, code: 'reauthorization_required', reason: 'The YouTube access token expired and no refresh token is stored. Reconnect the channel.' };
  }
  try {
    const refreshed = await refreshAccessToken(tokens.refresh_token);
    await storage.updateYouTubeAccountTokenState(userId, accountId, {
      credentialEnvelope: encryptTokens(refreshed.tokens),
      tokenMeta: { ...refreshed.meta, lastRefreshAt: new Date().toISOString(), lastRefreshFailureCode: '' }
    }, workspaceScope);
    return { ok: true, accessToken: refreshed.tokens.access_token };
  } catch (error) {
    if (error.code === 'reauthorization_required') {
      await storage.markYouTubeAccountReauthorizationRequired(
        userId,
        accountId,
        'invalid_grant',
        workspaceScope
      );
      return { ok: false, code: 'reauthorization_required', reason: 'Google rejected the stored refresh token (invalid_grant). Reconnect the channel.' };
    }
    safeWarn('[youtube] token refresh failed', { accountId, error: error.message });
    return { ok: false, code: 'token_refresh_failed', reason: `YouTube token refresh failed: ${error.message}` };
  }
}

// ── Media source (trusted boundary, streaming, SSRF hardened) ──────────────

function getLocalMediaPath(post) {
  const fileName = String(post.fileName || '').trim();
  if (!fileName) return '';
  const uploadPath = path.resolve(config.uploadsDir, fileName);
  const uploadsRoot = path.resolve(config.uploadsDir);
  const relative = path.relative(uploadsRoot, uploadPath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return '';
  return uploadPath;
}

function isPrivateHostname(hostname) {
  const value = String(hostname || '').toLowerCase();
  if (value === 'localhost' || value === '::1' || value.endsWith('.local') || value.endsWith('.internal')) return true;
  // Reject every IP-literal host outright: the product's durable media
  // lives behind DNS names (Cloudinary / admin-entered HTTPS CDN URLs).
  if (/^\[?[0-9a-f:]+\]?$/.test(value) && value.includes(':')) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return true;
  return false;
}

/**
 * The only remote-media gate for YouTube uploads: HTTPS, DNS-named host,
 * video extension per mediaPolicy, no redirects followed, bounded size,
 * and a Content-Length is mandatory (the resumable protocol needs it and
 * it enforces the size cap before any byte is streamed).
 */
function isTrustedRemoteMediaUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:') return false;
    if (isPrivateHostname(url.hostname)) return false;
    return mediaPolicy.isVideoMediaUrl(url.toString());
  } catch (error) {
    return false;
  }
}

async function getVideoSource(post) {
  const localPath = getLocalMediaPath(post);
  if (localPath) {
    try {
      const stats = fs.statSync(localPath);
      if (stats.isFile() && stats.size > 0) {
        if (stats.size > config.youtube.maxVideoBytes) {
          return { ok: false, reason: `Video exceeds the ${config.youtube.maxVideoBytes} byte YouTube upload limit configured for this product.` };
        }
        const fileName = path.basename(localPath);
        return {
          ok: true,
          source: 'local',
          sourceId: `local:${canonicalSha256({ fileName })}`,
          fileName,
          mimeType: String(post.mimeType || 'video/mp4').split(';')[0].trim().toLowerCase(),
          createBody: () => fs.createReadStream(localPath),
          fileSize: stats.size
        };
      }
    } catch (error) {
      // Local uploads are wiped on redeploy; fall through to the durable URL.
    }
  }

  const remoteUrl = [post.mediaUrl, post.videoPath, post.mediaPath, post.publicMediaUrl]
    .map((value) => String(value || '').trim())
    .find(Boolean) || '';
  if (!remoteUrl) return { ok: false, reason: 'Video media reference is missing for this job.' };
  if (!isTrustedRemoteMediaUrl(remoteUrl)) {
    return { ok: false, reason: 'Video media URL is not a trusted HTTPS video source; YouTube upload was blocked.' };
  }

  let response;
  try {
    response = await fetch(remoteUrl, { redirect: 'error', signal: requestSignal(config.youtube.uploadTimeoutMs) });
  } catch (error) {
    return { ok: false, reason: `Could not load video media: ${error.message}` };
  }
  if (!response.ok) {
    return { ok: false, reason: `Video media download returned HTTP ${response.status}` };
  }
  const contentLength = Number(response.headers.get('content-length'));
  if (!Number.isFinite(contentLength) || contentLength <= 0) {
    await cancelBody(response);
    return { ok: false, reason: 'Video media source did not declare a Content-Length; YouTube upload was blocked.' };
  }
  if (contentLength > config.youtube.maxVideoBytes) {
    await cancelBody(response);
    return { ok: false, reason: `Video exceeds the ${config.youtube.maxVideoBytes} byte YouTube upload limit configured for this product.` };
  }
  const parsedUrl = new URL(remoteUrl);
  const fileName = path.basename(parsedUrl.pathname) || 'video.mp4';
  const responseMimeType = String(response.headers.get('content-type') || post.mimeType || 'video/mp4')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (!responseMimeType.startsWith('video/')) {
    await cancelBody(response);
    return { ok: false, reason: 'Video media source returned a non-video content type; YouTube upload was blocked.' };
  }
  return {
    ok: true,
    source: 'remote',
    sourceId: `remote:${canonicalSha256({ origin: parsedUrl.origin, pathname: parsedUrl.pathname })}`,
    fileName,
    mimeType: responseMimeType,
    createBody: () => response.body,
    fileSize: contentLength,
    cancel: () => cancelBody(response)
  };
}

async function cancelBody(response) {
  try {
    if (response && response.body && typeof response.body.cancel === 'function') await response.body.cancel();
  } catch (error) {
    // Stream may already be consumed or closed.
  }
}

async function removePreparedMedia(prepared) {
  if (!prepared) return;
  try {
    if (prepared.filePath) await fs.promises.unlink(prepared.filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') safeWarn('[youtube] temporary media cleanup failed', { error: error.message });
  }
  try {
    if (prepared.tempDir) await fs.promises.rmdir(prepared.tempDir);
  } catch (error) {
    if (error.code !== 'ENOENT') safeWarn('[youtube] temporary media directory cleanup failed', { error: error.message });
  }
}

/**
 * Materializes the exact provider bytes into a bounded temporary file. This
 * gives the operation a stable digest and lets reconciliation reopen the
 * identical range without retaining the video in memory.
 */
async function materializeVideoSource(post) {
  const source = await getVideoSource(post);
  if (!source.ok) return source;
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'chanter-youtube-'));
  const filePath = path.join(tempDir, 'provider-media.bin');
  const hash = createHash('sha256');
  let byteSize = 0;
  const meter = new Transform({
    transform(chunk, encoding, callback) {
      byteSize += chunk.length;
      if (byteSize > config.youtube.maxVideoBytes) {
        callback(new Error('Video exceeded the configured YouTube upload limit while being read.'));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    }
  });
  try {
    await pipeline(source.createBody(), meter, fs.createWriteStream(filePath, { flags: 'wx' }));
    if (byteSize !== source.fileSize) {
      throw new Error('Video media size changed while being read; provider upload was blocked.');
    }
    const mp4 = await inspectMp4File(filePath);
    if (!mp4.valid) throw new Error(`Media is not a valid MP4/ISO BMFF file (${mp4.code}).`);
    const prepared = {
      ok: true,
      tempDir,
      filePath,
      fileSize: byteSize,
      mediaSha256: hash.digest('hex'),
      mimeType: mp4.mimeType,
      container: mp4.container,
      fileName: source.fileName,
      sourceId: source.sourceId,
      createBody: (start = 0) => fs.createReadStream(filePath, { start })
    };
    return prepared;
  } catch (error) {
    await removePreparedMedia({ tempDir, filePath });
    return { ok: false, reason: error.message };
  } finally {
    if (typeof source.cancel === 'function') await source.cancel();
  }
}

async function verifyPreparedMedia(prepared) {
  const hash = createHash('sha256');
  let byteSize = 0;
  await pipeline(
    fs.createReadStream(prepared.filePath),
    new Transform({
      transform(chunk, encoding, callback) {
        byteSize += chunk.length;
        hash.update(chunk);
        callback(null, chunk);
      }
    }),
    new Transform({ transform(chunk, encoding, callback) { callback(); } })
  );
  return byteSize === prepared.fileSize && hash.digest('hex') === prepared.mediaSha256;
}

// ── Resumable upload ───────────────────────────────────────────────────────

function validateYouTubeMetadata(metadata = {}) {
  const title = String(metadata.title || '').trim();
  if (!title) return { ok: false, reason: 'YouTube upload requires a non-empty title.' };
  if (title.length > MAX_TITLE_LENGTH) {
    return { ok: false, reason: `YouTube title must be at most ${MAX_TITLE_LENGTH} characters.` };
  }
  if (/[<>]/.test(title)) return { ok: false, reason: 'YouTube titles cannot contain the characters < or >.' };
  const description = String(metadata.description || '').trim();
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    return { ok: false, reason: `YouTube description must be at most ${MAX_DESCRIPTION_LENGTH} characters.` };
  }
  if (/[<>]/.test(description)) return { ok: false, reason: 'YouTube descriptions cannot contain the characters < or >.' };
  // An omitted visibility means private. A supplied one must be exactly a
  // visibility this adapter implements — silently downgrading a typo would
  // publish something other than what the requester read and approved.
  const rawVisibility = metadata.privacyStatus === undefined || metadata.privacyStatus === null
    ? 'private'
    : String(metadata.privacyStatus).trim().toLowerCase();
  if (sanitizeRequestedVisibility(rawVisibility) !== rawVisibility) {
    return { ok: false, reason: 'YouTube visibility must be exactly "private" or "public".' };
  }
  return { ok: true, title, description, privacyStatus: rawVisibility };
}

/**
 * The deployment-level ceiling on requested visibility. `privateOnly` (on by
 * default) refuses any request beyond private BEFORE the provider is touched;
 * turning it off authorizes the public path to exist but never selects it.
 */
function visibilityAuthorization(requestedVisibility, configStatus = getYouTubeConfigStatus()) {
  const requested = sanitizeRequestedVisibility(requestedVisibility);
  const allowed = Array.isArray(configStatus.allowedVisibilities)
    ? configStatus.allowedVisibilities
    : ['private'];
  if (!allowed.includes(requested)) {
    return {
      ok: false,
      requested,
      reason: `This deployment authorizes YouTube ${allowed.join('/')} publishing only; a ${requested} upload was blocked.`
    };
  }
  return { ok: true, requested };
}

/**
 * Uploads one video through the documented YouTube resumable protocol:
 *
 *   1. POST /upload/youtube/v3/videos?uploadType=resumable  -> session URL
 *   2. PUT <session URL> with the streamed bytes            -> video resource
 *
 * privacyStatus is whatever validateYouTubeMetadata accepted (private unless
 * the caller explicitly asked otherwise); notifySubscribers is always false
 * and callers cannot override it. The result distinguishes:
 *   ok:true                       — Google returned the video resource
 *   ok:false, sessionCreated:false — nothing external happened (retry-safe)
 *   ok:false, definitiveFailure    — Google rejected the upload (no video)
 *   ok:false, outcomeUnknown       — bytes may have arrived, no definitive
 *                                    answer (NEVER blind-retry)
 */
function acceptedOffsetFromRange(value, mediaByteSize = Number.MAX_SAFE_INTEGER) {
  const match = /^bytes=0-(\d+)$/.exec(String(value || '').trim());
  if (!match) return null;
  const lastByte = Number(match[1]);
  const offset = Number.isSafeInteger(lastByte) && lastByte >= 0 ? lastByte + 1 : null;
  return offset !== null && offset <= mediaByteSize ? offset : null;
}

async function putResumableBytes({
  sessionUrl,
  media,
  contentType,
  startOffset = 0,
  onUploadAttempt
}) {
  if (!Number.isSafeInteger(startOffset) || startOffset < 0 || startOffset > media.fileSize) {
    return { ok: false, sessionCreated: true, outcomeUnknown: true, reason: 'The provider resume offset was invalid.' };
  }
  if (startOffset === media.fileSize) {
    return { ok: false, sessionCreated: true, outcomeUnknown: true, fullSizeAmbiguous: true, reason: 'The provider accepted the full byte count without confirming completion.' };
  }
  try {
    if (typeof onUploadAttempt === 'function') await onUploadAttempt({ acceptedByteOffset: startOffset });
  } catch (error) {
    return {
      ok: false,
      sessionCreated: true,
      outcomeUnknown: true,
      reason: 'The persisted YouTube session could not durably record the media write attempt; no further bytes were sent.'
    };
  }
  const remaining = media.fileSize - startOffset;
  let response;
  try {
    response = await fetch(sessionUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(remaining),
        ...(startOffset > 0
          ? { 'Content-Range': `bytes ${startOffset}-${media.fileSize - 1}/${media.fileSize}` }
          : {})
      },
      body: media.createBody(startOffset),
      duplex: 'half',
      signal: requestSignal(config.youtube.uploadTimeoutMs)
    });
  } catch (error) {
    return {
      ok: false,
      sessionCreated: true,
      outcomeUnknown: true,
      reason: 'YouTube upload did not return a definitive result. A video may exist; reconcile the persisted session before retrying.'
    };
  }
  const body = await parseResponseBody(response);
  if (response.ok && body && body.id) {
    const status = body.status || {};
    return {
      ok: true,
      mode: 'api',
      providerResponseSha256: canonicalSha256({
        id: String(body.id),
        channelId: String((body.snippet && body.snippet.channelId) || ''),
        privacyStatus: String(status.privacyStatus || ''),
        uploadStatus: String(status.uploadStatus || '')
      }),
      response: {
        video_id: String(body.id),
        privacy_status: String(status.privacyStatus || ''),
        upload_status: String(status.uploadStatus || ''),
        channel_id: String((body.snippet && body.snippet.channelId) || ''),
        upload_method: UPLOAD_METHOD
      }
    };
  }
  if (response.status === 308) {
    const acceptedByteOffset = acceptedOffsetFromRange(response.headers.get('range'), media.fileSize);
    if (acceptedByteOffset === null || acceptedByteOffset < startOffset) {
      return { ok: false, sessionCreated: true, outcomeUnknown: true, reason: 'YouTube returned an invalid or decreasing resumable offset.' };
    }
    return {
      ok: false,
      sessionCreated: true,
      resumable: true,
      acceptedByteOffset,
      reason: 'YouTube accepted only part of the media; same-session reconciliation is required.'
    };
  }
  if (response.status >= 400 && response.status < 500) {
    return {
      ok: false,
      sessionCreated: true,
      definitiveFailure: true,
      reason: normalizeGoogleApiErrorMessage(body, response.status, 'YouTube video upload'),
      providerErrorCategory: categorizeGoogleApiError(body, response.status)
    };
  }
  return {
    ok: false,
    sessionCreated: true,
    outcomeUnknown: true,
    reason: `YouTube upload returned HTTP ${response.status} without a definitive video resource. Reconcile the persisted session before retrying.`
  };
}

async function uploadVideo({ accessToken, media, metadata, onSessionCreated, onUploadAttempt }) {
  const meta = validateYouTubeMetadata(metadata);
  if (!meta.ok) return { ok: false, sessionCreated: false, reason: meta.reason };

  const initUrl = new URL(`${config.youtube.uploadBaseUrl}/videos`);
  initUrl.search = new URLSearchParams({
    uploadType: 'resumable',
    part: 'snippet,status',
    notifySubscribers: 'false'
  }).toString();
  const contentType = String(metadata.mimeType || 'video/mp4');

  let initResponse;
  try {
    initResponse = await fetch(initUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': contentType,
        'X-Upload-Content-Length': String(media.fileSize)
      },
      body: JSON.stringify({
        snippet: {
          title: meta.title,
          ...(meta.description ? { description: meta.description } : {})
        },
        status: { privacyStatus: meta.privacyStatus }
      }),
      signal: requestSignal()
    });
  } catch (error) {
    return { ok: false, sessionCreated: false, reason: safeDiagnosticText(`YouTube upload session request failed: ${error.message}`) };
  }

  if (!initResponse.ok) {
    const body = await parseResponseBody(initResponse);
    return {
      ok: false,
      sessionCreated: false,
      reason: normalizeGoogleApiErrorMessage(body, initResponse.status, 'YouTube upload session'),
      providerErrorCategory: categorizeGoogleApiError(body, initResponse.status)
    };
  }

  const sessionUrl = initResponse.headers.get('location');
  if (!sessionUrl) {
    return { ok: false, sessionCreated: false, reason: 'YouTube did not return a resumable upload session URL.' };
  }

  try {
    if (typeof onSessionCreated === 'function') await onSessionCreated(sessionUrl);
  } catch (error) {
    return {
      ok: false,
      sessionCreated: true,
      outcomeUnknown: true,
      sessionPersistenceFailed: true,
      reason: 'YouTube created a resumable session, but durable encrypted session custody failed before any media byte was sent.'
    };
  }
  return putResumableBytes({ sessionUrl, media, contentType, onUploadAttempt });
}

async function queryResumableSession({ sessionUrl, mediaByteSize }) {
  let response;
  try {
    response = await fetch(sessionUrl, {
      method: 'PUT',
      headers: {
        'Content-Length': '0',
        'Content-Range': `bytes */${mediaByteSize}`
      },
      signal: requestSignal()
    });
  } catch (error) {
    return { outcome: 'unknown', reason: 'The persisted YouTube session did not return a definitive status.' };
  }
  const body = await parseResponseBody(response);
  if (response.ok && body && body.id) return { outcome: 'complete', body };
  if (response.status === 308) {
    const acceptedByteOffset = acceptedOffsetFromRange(response.headers.get('range'), mediaByteSize);
    return acceptedByteOffset === null
      ? { outcome: 'unknown', reason: 'The persisted YouTube session returned an invalid offset.' }
      : { outcome: 'resumable', acceptedByteOffset };
  }
  if (response.status === 404 || response.status === 410) return { outcome: 'missing' };
  if (response.status >= 400 && response.status < 500) return { outcome: 'terminal' };
  return { outcome: 'unknown' };
}

// ── Status lookup (youtube.readonly) ───────────────────────────────────────

async function readUploadedVideo(accessToken, videoId) {
  const cleanVideoId = String(videoId || '').trim();
  if (!cleanVideoId) return { ok: false, reason: 'A YouTube video ID is required.' };

  const url = new URL(`${config.youtube.apiBaseUrl}/videos`);
  url.search = new URLSearchParams({ part: 'snippet,status,processingDetails', id: cleanVideoId }).toString();
  let response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: requestSignal()
    });
  } catch (error) {
    return {
      ok: false,
      code: 'youtube_api_unavailable',
      retryable: true,
      reason: `YouTube status lookup failed: ${error.message}`
    };
  }
  const body = await parseResponseBody(response);
  if (!response.ok) {
    return {
      ok: false,
      reason: normalizeGoogleApiErrorMessage(body, response.status, 'YouTube status lookup'),
      code: response.status === 403 ? 'missing_readonly_scope' : 'youtube_api_error',
      retryable: response.status === 429 || response.status >= 500
    };
  }
  const item = body && Array.isArray(body.items) ? body.items[0] : null;
  if (!item) {
    return {
      ok: false,
      reason: 'YouTube returned no video for this ID (it may still be propagating or may have been deleted).',
      code: 'video_not_found',
      retryable: true
    };
  }
  const status = item.status || {};
  const snippet = item.snippet || {};
  const processing = item.processingDetails || {};
  return {
    ok: true,
    videoId: cleanVideoId,
    channelId: String(snippet.channelId || ''),
    channelTitle: String(snippet.channelTitle || ''),
    channelHandle: '',
    title: String(snippet.title || ''),
    uploadStatus: String(status.uploadStatus || ''),
    privacyStatus: String(status.privacyStatus || ''),
    processingStatus: String(processing.processingStatus || '')
  };
}

async function getUploadedVideoStatus({ userId, accountId, videoId, workspaceScope }) {
  const credentials = await getActiveYouTubeCredentials(userId, accountId, workspaceScope);
  if (!credentials.ok) return { ok: false, code: credentials.code, reason: credentials.reason };
  return readUploadedVideo(credentials.accessToken, videoId);
}

async function buildProviderStatusReceipt({
  accessToken,
  operation,
  expectedTitle,
  videoId
}) {
  const cleanVideoId = String(videoId || operation.externalVideoId || '').trim();
  const status = cleanVideoId
    ? await readUploadedVideo(accessToken, cleanVideoId)
    : { ok: false, code: 'video_not_found', reason: 'No provider video ID was established.' };
  if (!status.ok && status.code !== 'video_not_found') {
    return { ok: false, code: status.code || 'provider_status_unavailable', reason: status.reason };
  }
  let channel = null;
  if (status.ok) {
    let channels;
    try {
      channels = await listMyChannels(accessToken);
    } catch (error) {
      return { ok: false, code: error.code || 'provider_channel_verification_failed', reason: error.message };
    }
    channel = channels.find((entry) => entry.channelId === status.channelId) || null;
  }
  const providerFacts = {
    videoId: status.ok ? status.videoId : '',
    channelId: status.ok ? status.channelId : '',
    channelOwnedByAuthenticatedIdentity: Boolean(channel),
    title: status.ok ? status.title : '',
    privacyStatus: status.ok ? status.privacyStatus : '',
    uploadStatus: status.ok ? status.uploadStatus : '',
    processingStatus: status.ok ? status.processingStatus : ''
  };
  const receipt = {
    provider: 'youtube',
    queueId: operation.queueId,
    providerOperationId: operation.providerOperationId,
    providerAttemptId: operation.providerAttemptId,
    userId: operation.userId,
    workspaceId: operation.workspaceId,
    runtimeMissionId: operation.runtimeMissionId,
    graphId: operation.graphId,
    mediaSha256: operation.mediaSha256,
    approvedMedia: operation.approvedMedia,
    providerProofMode: operation.providerProofMode,
    configuredAccountId: operation.accountId,
    connectedAccountId: operation.connectedAccountId,
    verifiedChannelId: status.ok ? status.channelId : '',
    authenticatedChannelId: channel ? channel.channelId : '',
    safeChannelTitle: channel ? channel.title : (status.channelTitle || ''),
    safeChannelHandle: channel ? channel.handle : '',
    externalVideoId: status.ok ? status.videoId : '',
    expectedTitle,
    exactTitleMatch: Boolean(status.ok && status.title === expectedTitle),
    artifactExists: Boolean(status.ok),
    // The visibility this operation was approved for. The recorder proves the
    // provider's actual privacyStatus against THIS, not against a constant.
    requestedVisibility: sanitizeRequestedVisibility(operation.requestedVisibility),
    privacyStatus: status.ok ? status.privacyStatus : '',
    uploadStatus: status.ok ? status.uploadStatus : '',
    processingStatus: status.ok ? status.processingStatus : '',
    verificationMethod: RECEIPT_METHOD,
    verificationTimestamp: new Date().toISOString(),
    canonicalResponseSha256: canonicalSha256(providerFacts)
  };
  return { ok: true, receipt, receiptSha256: canonicalSha256(receipt) };
}

function verificationFailure(code, reason, status = null) {
  return {
    ok: false,
    code,
    reason,
    ...(status && status.videoId ? { externalVideoId: status.videoId } : {})
  };
}

async function verifyUploadedVideo({
  accessToken,
  accountId,
  videoId,
  expectedTitle,
  expectedPrivacyStatus = 'private'
}) {
  const expectedVisibility = sanitizeRequestedVisibility(expectedPrivacyStatus);
  let status = null;
  for (let attempt = 0; attempt < VERIFICATION_ATTEMPTS; attempt += 1) {
    status = await readUploadedVideo(accessToken, videoId);
    if (status.ok || !status.retryable || attempt === VERIFICATION_ATTEMPTS - 1) break;
    await new Promise((resolve) => setTimeout(resolve, VERIFICATION_BACKOFF_MS[attempt] || 1_000));
  }
  if (!status || !status.ok) {
    return verificationFailure(
      status && status.code ? status.code : 'provider_verification_failed',
      status && status.reason ? status.reason : 'YouTube read-back verification did not return a resource.',
      status
    );
  }
  if (status.videoId !== String(videoId || '').trim()) {
    return verificationFailure('provider_video_id_mismatch', 'YouTube read-back returned a different video ID.', status);
  }
  if (status.channelId !== String(accountId || '').trim()) {
    return verificationFailure('provider_channel_mismatch', 'YouTube read-back returned a different channel.', status);
  }
  if (status.privacyStatus !== expectedVisibility) {
    return verificationFailure(
      'provider_privacy_mismatch',
      `YouTube read-back did not confirm ${expectedVisibility} visibility.`,
      status
    );
  }
  if (status.title !== String(expectedTitle || '').trim()) {
    return verificationFailure('provider_title_mismatch', 'YouTube read-back title does not match the submitted proof title.', status);
  }
  if (['rejected', 'deleted', 'failed'].includes(status.uploadStatus.toLowerCase())) {
    return verificationFailure('provider_upload_rejected', `YouTube reported upload status ${status.uploadStatus}.`, status);
  }
  let channel;
  try {
    const channels = await listMyChannels(accessToken);
    channel = channels.find((entry) => entry.channelId === status.channelId);
  } catch (error) {
    return verificationFailure('provider_channel_verification_failed', error.message, status);
  }
  if (!channel) {
    return verificationFailure('provider_channel_mismatch', 'The uploaded resource channel is not owned by the authenticated YouTube identity.', status);
  }
  return {
    ok: true,
    provider: 'youtube',
    externalVideoId: status.videoId,
    channelId: status.channelId,
    channelTitle: channel.title || status.channelTitle,
    channelHandle: channel.handle,
    title: status.title,
    privacyStatus: status.privacyStatus,
    uploadStatus: status.uploadStatus,
    processingStatus: status.processingStatus,
    verifiedAt: new Date().toISOString(),
    uploadMethod: UPLOAD_METHOD
  };
}

// ── Worker publish path ────────────────────────────────────────────────────

function scopeIncludesUpload(scopeValue) {
  return String(scopeValue || '').split(/[,\s]+/).includes(UPLOAD_SCOPE);
}

function preProviderUploadFailure(reason, code) {
  return {
    ok: false,
    mode: 'api',
    ...(code ? { code } : {}),
    providerMutationStarted: false,
    failureBoundary: 'before_provider_upload_session',
    reason
  };
}

/**
 * The worker's YouTube publish handler. Every gate fails closed BEFORE any
 * external call; only a fully-gated job reaches the upload session. The
 * shape of the return value matches the TikTok publish results the worker
 * already finalizes, plus outcomeUnknown/providerStatus extensions.
 */
async function publishScheduledYouTubePost(post) {
  const configStatus = getYouTubeConfigStatus();
  if (!configStatus.configured) {
    return preProviderUploadFailure('YouTube publishing is not configured on this deployment; publishing was blocked.');
  }
  const accountId = String(post.accountId || '').trim();
  if (!accountId || accountId === 'legacy') {
    return preProviderUploadFailure('YouTube channel is unassigned for this job; publishing was blocked.');
  }
  if (post.publishId) {
    return preProviderUploadFailure('This job already has a YouTube video ID; publishing again was blocked.');
  }

  const workspaceScope = post.workspaceId ? { workspaceId: post.workspaceId } : undefined;

  const youtubeMeta = (post.providerMetadata && post.providerMetadata.youtube) || {};
  const metadataCheck = validateYouTubeMetadata(youtubeMeta);
  if (!metadataCheck.ok) {
    return preProviderUploadFailure(metadataCheck.reason);
  }
  if (String(post.mediaType || '').toLowerCase() !== 'video') {
    return preProviderUploadFailure('YouTube publishing is video-only; this job has no video media.');
  }

  const operation = sanitizeProviderOperation(post.providerOperation);
  if (!operation || operation.queueId !== post.id || operation.accountId !== accountId) {
    return preProviderUploadFailure('The durable YouTube provider operation is missing or does not match this queue job.', 'PROVIDER_OPERATION_IDENTITY_MISMATCH');
  }

  // Visibility is decided exactly once, here, from two independent sources
  // that must agree: the durable operation minted at claim time (which hashes
  // the approved visibility into its id) and the queue record's live provider
  // metadata. Disagreement means the approved record drifted after the claim,
  // so nothing is uploaded.
  const requestedVisibility = operation.requestedVisibility;
  if (metadataCheck.privacyStatus !== requestedVisibility) {
    return preProviderUploadFailure(
      'The requested YouTube visibility does not match the visibility bound to this approved provider operation.',
      'PROVIDER_OPERATION_IDENTITY_MISMATCH'
    );
  }
  const visibilityGate = visibilityAuthorization(requestedVisibility, configStatus);
  if (!visibilityGate.ok) {
    return preProviderUploadFailure(visibilityGate.reason, 'PROVIDER_VISIBILITY_NOT_AUTHORIZED');
  }

  const operationInput = {
    userId: post.userId,
    postId: post.id,
    accountId,
    workspaceScope,
    providerOperationId: operation.providerOperationId,
    providerAttemptId: operation.providerAttemptId
  };

  const media = await materializeVideoSource(post);
  if (!media.ok) {
    return preProviderUploadFailure(media.reason);
  }
  const approvedMedia = sanitizeApprovedMediaIdentity(operation.approvedMedia, { maxByteSize: config.youtube.maxVideoBytes });
  const observedIdentity = {
    sha256: media.mediaSha256,
    byteSize: media.fileSize,
    mimeType: media.mimeType,
    fileName: approvedMedia ? approvedMedia.fileName : media.fileName,
    container: media.container
  };
  if (operation.providerProofMode && (!approvedMedia || !approvedMediaMatches(approvedMedia, observedIdentity))) {
    await removePreparedMedia(media);
    await storage.recordYouTubeProviderOperationFailure({
      ...operationInput,
      operationState: 'terminal_failure',
      errorCode: 'APPROVED_MEDIA_MISMATCH'
    });
    return preProviderUploadFailure('The materialized media bytes do not match the approved identity.', 'APPROVED_MEDIA_MISMATCH');
  }

  const account = await storage.getYouTubeAccount(post.userId, accountId, workspaceScope);
  if (!account) {
    await removePreparedMedia(media);
    return preProviderUploadFailure(`YouTube channel ${accountId} is not connected for this owner; publishing was blocked.`);
  }
  if (!account.connected) {
    await removePreparedMedia(media);
    return preProviderUploadFailure('YouTube channel is disconnected; reconnect it before publishing.');
  }
  if (account.reauthorizationRequired) {
    await removePreparedMedia(media);
    return preProviderUploadFailure('YouTube channel requires reauthorization; reconnect it before publishing.', 'reauthorization_required');
  }
  if (account.grantedScopes && !scopeIncludesUpload(account.grantedScopes)) {
    await removePreparedMedia(media);
    return preProviderUploadFailure('The stored YouTube authorization is missing the youtube.upload scope; reconnect the channel.');
  }

  try {
    const mediaBinding = await storage.bindYouTubeProviderOperationMedia({
      ...operationInput,
      mediaSha256: media.mediaSha256,
      mediaByteSize: media.fileSize,
      mediaMimeType: media.mimeType,
      mediaContainer: media.container,
      mediaFileName: media.fileName,
      mediaSourceId: media.sourceId
    });
    if (!['bound', 'already_bound'].includes(mediaBinding.outcome)) {
      return preProviderUploadFailure('The exact YouTube media identity could not be bound to this provider operation.', 'MEDIA_IDENTITY_DRIFT');
    }
    if (mediaBinding.safeOperation && mediaBinding.safeOperation.sessionCreatedAt) {
      return preProviderUploadFailure('This provider operation already owns a resumable session; reconcile that exact session instead of creating another.', 'PROVIDER_OPERATION_UNRESOLVED');
    }
    if (!(await verifyPreparedMedia(media))) {
      await storage.recordYouTubeProviderOperationFailure({
        ...operationInput,
        operationState: 'terminal_failure',
        errorCode: 'MEDIA_IDENTITY_DRIFT'
      });
      return preProviderUploadFailure('The prepared media changed before session creation; YouTube upload was blocked.', 'MEDIA_IDENTITY_DRIFT');
    }
    const credentials = await getActiveYouTubeCredentials(post.userId, accountId, workspaceScope);
    if (!credentials.ok) {
      return preProviderUploadFailure(credentials.reason, credentials.code);
    }
    const result = await uploadVideo({
      accessToken: credentials.accessToken,
      media,
      metadata: {
        title: youtubeMeta.title,
        description: youtubeMeta.description,
        privacyStatus: requestedVisibility,
        mimeType: media.mimeType
      },
      onSessionCreated: async (sessionUrl) => {
        const sessionLocatorEnvelope = tokenVault.encryptCredentials({
          kind: 'youtube_resumable_session',
          sessionUrl
        });
        const persisted = await storage.persistYouTubeSessionLocator({
          ...operationInput,
          sessionLocatorEnvelope
        });
        if (persisted.outcome !== 'session_persisted') {
          throw new Error('Durable session custody failed.');
        }
      },
      onUploadAttempt: async ({ acceptedByteOffset }) => {
        const recorded = await storage.recordYouTubeUploadAttempt({
          ...operationInput,
          acceptedByteOffset
        });
        if (recorded.outcome !== 'recorded') throw new Error('Durable upload-attempt recording failed.');
      }
    });
    if (result.ok) {
      await storage.recordYouTubeProviderResponse({
        ...operationInput,
        providerResponseSha256: result.providerResponseSha256,
        externalVideoId: result.response.video_id
      });
      const receiptResult = await buildProviderStatusReceipt({
        accessToken: credentials.accessToken,
        operation: { ...operation, mediaSha256: media.mediaSha256 },
        videoId: result.response.video_id,
        expectedTitle: metadataCheck.title
      });
      if (!receiptResult.ok) {
        await storage.recordYouTubeProviderOperationFailure({
          ...operationInput,
          operationState: 'outcome_unknown',
          errorCode: 'PROVIDER_STATUS_UNAVAILABLE'
        });
        return {
          ok: false,
          mode: 'api',
          code: 'PROVIDER_VERIFICATION_FAILED',
          outcomeUnknown: true,
          sessionCreated: true,
          providerMutationStarted: true,
          failureBoundary: 'provider_read_back',
          providerStatus: 'provider_verification_required',
          response: result.response,
          reason: receiptResult.reason
        };
      }
      const recordedReceipt = await storage.recordYouTubeProviderStatusReceipt({
        ...operationInput,
        providerStatusReceipt: receiptResult.receipt,
        providerStatusReceiptSha256: receiptResult.receiptSha256
      });
      const verifiedOperation = recordedReceipt.safeOperation;
      const completionState = completionStateForVisibility(requestedVisibility);
      if (!verifiedOperation || verifiedOperation.operationState !== completionState) {
        return {
          ok: false,
          mode: 'api',
          code: verifiedOperation && verifiedOperation.operationState === 'contradictory_public'
            ? 'PROVIDER_VISIBILITY_CONTRADICTION'
            : 'PROVIDER_VERIFICATION_FAILED',
          outcomeUnknown: true,
          sessionCreated: true,
          providerMutationStarted: true,
          failureBoundary: 'provider_read_back',
          providerStatus: verifiedOperation ? verifiedOperation.operationState : 'provider_verification_required',
          response: result.response,
          reason: `YouTube read-back did not prove one exact ${requestedVisibility} artifact for the configured channel.`
        };
      }
      const receipt = verifiedOperation.providerStatusReceipt;
      const verification = {
        ok: true,
        provider: 'youtube',
        externalVideoId: receipt.externalVideoId,
        channelId: receipt.verifiedChannelId,
        channelTitle: receipt.safeChannelTitle,
        channelHandle: receipt.safeChannelHandle,
        title: receipt.expectedTitle,
        privacyStatus: receipt.privacyStatus,
        uploadStatus: receipt.uploadStatus,
        processingStatus: receipt.processingStatus,
        verifiedAt: receipt.verificationTimestamp,
        uploadMethod: UPLOAD_METHOD
      };
      return {
        ok: true,
        mode: result.mode,
        response: result.response,
        providerMutationStarted: true,
        providerStatus: providerUploadStatus(receipt.privacyStatus),
        providerVerification: verification
      };
    }
    if (result.resumable) {
      await storage.recordYouTubeAcceptedByteOffset({
        ...operationInput,
        acceptedByteOffset: result.acceptedByteOffset
      });
    } else {
      await storage.recordYouTubeProviderOperationFailure({
        ...operationInput,
        operationState: result.definitiveFailure ? 'terminal_failure' : 'outcome_unknown',
        errorCode: result.sessionPersistenceFailed
          ? 'SESSION_PERSISTENCE_FAILED'
          : (result.definitiveFailure ? 'PROVIDER_UPLOAD_REJECTED' : 'PROVIDER_OUTCOME_UNKNOWN')
      });
    }
    return {
      ok: false,
      mode: 'api',
      reason: result.reason,
      providerMutationStarted: result.sessionCreated === true,
      failureBoundary: result.sessionCreated === true
        ? 'provider_upload_session'
        : 'before_provider_upload_session',
      ...(result.resumable ? { outcomeUnknown: true, code: 'PROVIDER_RECONCILIATION_REQUIRED' } : {}),
      ...(result.outcomeUnknown ? { outcomeUnknown: true, code: 'PROVIDER_RECONCILIATION_REQUIRED' } : {}),
      ...(result.providerErrorCategory ? { providerErrorCategory: result.providerErrorCategory } : {})
    };
  } finally {
    await removePreparedMedia(media);
  }
}

// ── Error normalization ────────────────────────────────────────────────────

function safeUploadResponseHash(body) {
  const status = body && body.status && typeof body.status === 'object' ? body.status : {};
  const snippet = body && body.snippet && typeof body.snippet === 'object' ? body.snippet : {};
  return canonicalSha256({
    id: String((body && body.id) || ''),
    channelId: String(snippet.channelId || ''),
    privacyStatus: String(status.privacyStatus || ''),
    uploadStatus: String(status.uploadStatus || '')
  });
}

function isExpectedSessionLocator(value) {
  if (!value || value.kind !== 'youtube_resumable_session' || typeof value.sessionUrl !== 'string') return false;
  try {
    const session = new URL(value.sessionUrl);
    const configuredOrigin = new URL(config.youtube.uploadBaseUrl).origin;
    return session.origin === configuredOrigin
      || (session.protocol === 'https:' && /(^|\.)googleapis\.com$/i.test(session.hostname));
  } catch (error) {
    return false;
  }
}

function mediaMatchesOperation(media, operation) {
  return media.mediaSha256 === operation.mediaSha256
    && media.fileSize === operation.mediaByteSize
    && media.mimeType === operation.mediaMimeType
    && media.fileName === operation.mediaFileName
    && media.sourceId === operation.mediaSourceId;
}

async function reconcileYouTubeProviderOperation({ userId, postId, accountId, workspaceScope }) {
  const internal = await storage.getYouTubeProviderOperationInternal(
    userId,
    postId,
    accountId,
    workspaceScope
  );
  if (!internal) return { classification: 'provider_operation_not_found' };
  const operation = sanitizeProviderOperation(internal.operation);
  if (!operation || operation.queueId !== postId || operation.accountId !== accountId) {
    return { classification: 'provider_operation_identity_mismatch' };
  }
  if (['completed_private', 'completed_public', 'contradictory_public', 'provider_missing', 'terminal_failure'].includes(operation.operationState)) {
    return { classification: operation.operationState };
  }
  const operationInput = {
    userId,
    postId,
    accountId,
    workspaceScope,
    providerOperationId: operation.providerOperationId,
    providerAttemptId: operation.providerAttemptId
  };
  const ownerId = `ytrec_${randomUUID()}`;
  const claimed = await storage.claimYouTubeReconciliationAttempt({ ...operationInput, ownerId });
  if (claimed.outcome !== 'claimed') return { classification: claimed.outcome };
  operationInput.leaseOwnerId = ownerId;
  operationInput.fencingToken = claimed.lease.fencingToken;
  try {

  let locator;
  try {
    locator = tokenVault.decryptCredentials(internal.operation.sessionLocatorEnvelope);
  } catch (error) {
    await storage.recordYouTubeProviderOperationFailure({
      ...operationInput,
      operationState: 'outcome_unknown',
      errorCode: 'SESSION_LOCATOR_DECRYPT_FAILED',
      reconciled: true
    });
    return { classification: 'session_locator_decrypt_failed' };
  }
  if (!isExpectedSessionLocator(locator)) {
    await storage.recordYouTubeProviderOperationFailure({
      ...operationInput,
      operationState: 'outcome_unknown',
      errorCode: 'SESSION_LOCATOR_INVALID',
      reconciled: true
    });
    return { classification: 'session_locator_invalid' };
  }

  const credentials = await getActiveYouTubeCredentials(userId, accountId, workspaceScope);
  if (!credentials.ok) return { classification: credentials.code || 'provider_credentials_unavailable' };
  let videoId = operation.externalVideoId || '';
  if (!videoId) {
    const session = await queryResumableSession({
      sessionUrl: locator.sessionUrl,
      mediaByteSize: operation.mediaByteSize
    });
    if (session.outcome === 'missing') {
      await storage.recordYouTubeProviderOperationFailure({ ...operationInput, operationState: 'provider_missing', errorCode: 'PROVIDER_SESSION_MISSING', reconciled: true });
      return { classification: 'provider_missing' };
    }
    if (session.outcome === 'terminal') {
      await storage.recordYouTubeProviderOperationFailure({ ...operationInput, operationState: 'terminal_failure', errorCode: 'PROVIDER_SESSION_TERMINAL', reconciled: true });
      return { classification: 'terminal_failure' };
    }
    if (session.outcome === 'unknown') {
      await storage.recordYouTubeProviderOperationFailure({ ...operationInput, operationState: 'outcome_unknown', errorCode: 'PROVIDER_SESSION_OUTCOME_UNKNOWN', reconciled: true });
      return { classification: 'outcome_unknown' };
    }
    if (session.outcome === 'complete') {
      videoId = String(session.body.id || '').trim();
      await storage.recordYouTubeProviderResponse({
        ...operationInput,
        providerResponseSha256: safeUploadResponseHash(session.body),
        externalVideoId: videoId
      });
    } else {
      await storage.recordYouTubeAcceptedByteOffset({ ...operationInput, acceptedByteOffset: session.acceptedByteOffset });
      const media = await materializeVideoSource(internal.post);
      if (!media.ok) {
        await storage.recordYouTubeProviderOperationFailure({ ...operationInput, operationState: 'outcome_unknown', errorCode: 'MEDIA_UNAVAILABLE_FOR_RECONCILIATION', reconciled: true });
        return { classification: 'media_unavailable' };
      }
      try {
        if (!mediaMatchesOperation(media, operation) || !(await verifyPreparedMedia(media))) {
          await storage.recordYouTubeProviderOperationFailure({ ...operationInput, operationState: 'terminal_failure', errorCode: 'MEDIA_IDENTITY_DRIFT', reconciled: true });
          return { classification: 'media_identity_drift' };
        }
        const resumed = await putResumableBytes({
          sessionUrl: locator.sessionUrl,
          media,
          contentType: operation.mediaMimeType,
          startOffset: session.acceptedByteOffset,
          onUploadAttempt: async ({ acceptedByteOffset }) => {
            const recorded = await storage.recordYouTubeUploadAttempt({ ...operationInput, acceptedByteOffset });
            if (recorded.outcome !== 'recorded') throw new Error('Durable resume-attempt recording failed.');
          }
        });
        if (!resumed.ok) {
          if (resumed.resumable) {
            await storage.recordYouTubeAcceptedByteOffset({ ...operationInput, acceptedByteOffset: resumed.acceptedByteOffset });
            return { classification: 'resumable' };
          }
          await storage.recordYouTubeProviderOperationFailure({
            ...operationInput,
            operationState: resumed.definitiveFailure ? 'terminal_failure' : 'outcome_unknown',
            errorCode: resumed.definitiveFailure ? 'PROVIDER_UPLOAD_REJECTED' : 'PROVIDER_OUTCOME_UNKNOWN',
            reconciled: true
          });
          return { classification: resumed.definitiveFailure ? 'terminal_failure' : 'outcome_unknown' };
        }
        videoId = resumed.response.video_id;
        await storage.recordYouTubeProviderResponse({
          ...operationInput,
          providerResponseSha256: resumed.providerResponseSha256,
          externalVideoId: videoId
        });
      } finally {
        await removePreparedMedia(media);
      }
    }
  }

  const receiptResult = await buildProviderStatusReceipt({
    accessToken: credentials.accessToken,
    operation,
    expectedTitle: String((internal.post.providerMetadata?.youtube?.title) || '').trim(),
    videoId
  });
  if (!receiptResult.ok) {
    await storage.recordYouTubeProviderOperationFailure({ ...operationInput, operationState: 'outcome_unknown', errorCode: 'PROVIDER_STATUS_UNAVAILABLE', reconciled: true });
    return { classification: 'provider_status_unavailable' };
  }
  const recorded = await storage.recordYouTubeProviderStatusReceipt({
    ...operationInput,
    providerStatusReceipt: receiptResult.receipt,
    providerStatusReceiptSha256: receiptResult.receiptSha256
  });
  if (!recorded.safeOperation) return { classification: recorded.outcome || 'provider_receipt_rejected' };
  await storage.applyYouTubeProviderReconciliationResult(operationInput);
  return { classification: recorded.safeOperation.operationState };
  } finally {
    await storage.releaseYouTubeReconciliationLease(operationInput);
  }
}

function isInvalidGrant(body) {
  return Boolean(body && typeof body === 'object' && String(body.error || '') === 'invalid_grant');
}

function normalizeGoogleOAuthErrorMessage(body, httpStatus) {
  if (body && typeof body === 'object') {
    const code = String(body.error || '').trim();
    const description = String(body.error_description || '').trim();
    if (code) return `Google OAuth error: ${code}${description ? ` (${description})` : ''}`;
  }
  return `Google OAuth returned HTTP ${httpStatus}`;
}

/** Safe one-line message from a Google API error body — never the raw body. */
function normalizeGoogleApiErrorMessage(body, httpStatus, operation) {
  const error = body && typeof body === 'object' && body.error && typeof body.error === 'object'
    ? body.error
    : null;
  if (error) {
    const reason = Array.isArray(error.errors) && error.errors[0] && error.errors[0].reason
      ? String(error.errors[0].reason)
      : '';
    const message = safeDiagnosticText(String(error.message || '').slice(0, 200));
    return `${operation} failed (HTTP ${httpStatus}${reason ? `, ${reason}` : ''})${message ? `: ${message}` : ''}`;
  }
  return `${operation} returned HTTP ${httpStatus}`;
}

function categorizeGoogleApiError(body, httpStatus) {
  const error = body && typeof body === 'object' && body.error && typeof body.error === 'object'
    ? body.error
    : {};
  const reason = Array.isArray(error.errors) && error.errors[0] && error.errors[0].reason
    ? String(error.errors[0].reason)
    : '';
  if (httpStatus === 401 || reason === 'authError') return 'authorization';
  if (httpStatus === 403 && /quota/i.test(reason)) return 'quota';
  if (httpStatus === 403) return 'permission';
  if (httpStatus === 400) return 'invalid_request';
  return 'provider_error';
}

module.exports = {
  UPLOAD_SCOPE,
  READONLY_SCOPE,
  MAX_TITLE_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  getYouTubeConfigStatus,
  isYouTubeConfigured,
  createPkcePair,
  buildYouTubeAuthUrl,
  exchangeCodeForToken,
  refreshAccessToken,
  revokeToken,
  normalizeTokenResponse,
  encryptTokens,
  decryptTokens,
  finalizeYouTubeConnection,
  listMyChannels,
  getActiveYouTubeCredentials,
  validateYouTubeMetadata,
  isTrustedRemoteMediaUrl,
  getVideoSource,
  materializeVideoSource,
  verifyPreparedMedia,
  removePreparedMedia,
  acceptedOffsetFromRange,
  uploadVideo,
  queryResumableSession,
  readUploadedVideo,
  getUploadedVideoStatus,
  verifyUploadedVideo,
  publishScheduledYouTubePost,
  reconcileYouTubeProviderOperation,
  redactSensitive
};
