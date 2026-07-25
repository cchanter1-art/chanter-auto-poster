const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { randomUUID } = require('crypto');
const config = require('./config');
const storage = require('./storage');
const { resolveSoundCapability } = require('./tiktokSoundMode');
const { isTikTokPrivacyLevel, normalizeTikTokPrivacyLevel } = require('./tiktokPrivacy');
const { deriveMutedVideo } = require('./autoMusic');

const tokenRefreshBufferMs = 5 * 60 * 1000;

// Honest capability result for a directly published video whose destination
// selected TikTok-recommended sound. TikTok's video DIRECT_POST API exposes no
// automatic recommended-sound switch, so this fails clearly (manual completion)
// rather than silently claiming a native sound was applied. The code is not in
// the scheduler's transient set, so the outcome is terminal (no blind retry).
const SOUND_MODE_MANUAL_CODE = 'SOUND_MODE_MANUAL_REQUIRED';
const SOUND_MODE_MANUAL_REASON =
  'TikTok does not support automatically adding recommended sound to a directly '
  + 'published video. Choose Original or Muted for automatic posting, or finish '
  + 'sound selection manually in the TikTok app.';
// Privacy fail-closed codes (terminal, not in the scheduler's transient set):
// a job whose privacy value is unknown, or is not permitted for the connected
// account, must never reach the publish/init call. It is surfaced to the
// operator, never silently downgraded to a more-public level.
const PRIVACY_LEVEL_INVALID_CODE = 'PRIVACY_LEVEL_INVALID';
const PRIVACY_LEVEL_UNSUPPORTED_CODE = 'PRIVACY_LEVEL_UNSUPPORTED';
const videoInitUrl = 'https://open.tiktokapis.com/v2/post/publish/video/init/';
const creatorInfoQueryUrl = 'https://open.tiktokapis.com/v2/post/publish/creator_info/query/';
const MIN_CHUNK_SIZE = 5 * 1024 * 1024;
const MAX_CHUNK_SIZE = 64 * 1024 * 1024;

const SENSITIVE_KEYS = new Set([
  'access_token', 'accessToken', 'refresh_token', 'refreshToken',
  'client_secret', 'clientSecret', 'open_id', 'openId', 'code'
]);

/**
 * Redacts token-like fields from objects before logging.
 * Recursively walks objects and arrays, replacing sensitive values
 * with '[REDACTED]'.
 */
function redactSensitive(value) {
  if (value == null) return value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redactSensitive);

  const result = {};
  for (const [key, val] of Object.entries(value)) {
    if (SENSITIVE_KEYS.has(key)) {
      result[key] = '[REDACTED]';
    } else if (val && typeof val === 'object') {
      result[key] = redactSensitive(val);
    } else {
      result[key] = val;
    }
  }
  return result;
}

function safeLog(label, obj) {
  console.log(label, JSON.stringify(redactSensitive(obj), null, 2));
}

function safeError(label, obj) {
  console.error(label, JSON.stringify(redactSensitive(obj), null, 2));
}

function requestSignal(timeoutMs = config.tiktok.requestTimeoutMs) {
  return AbortSignal.timeout(Math.max(1, Number(timeoutMs) || 30_000));
}

async function isConfigured(accountId, userId) {
  return (await getTikTokAuthStatus(accountId, userId)).connected;
}

function buildTikTokAuthUrl(state) {
  // Always ensure video.publish is included
  const scopeSet = new Set([
    'user.info.basic',
    'video.publish',
    ...String(config.tiktok.scopes || '').split(',').map(s => s.trim()).filter(Boolean)
  ]);

  const url = new URL(config.tiktok.authUrl);
  url.search = new URLSearchParams({
    client_key: config.tiktok.clientKey,
    response_type: 'code',
    scope: [...scopeSet].join(','),
    redirect_uri: config.tiktok.redirectUri,
    state
  }).toString();

  return url.toString();
}

async function exchangeCodeForToken(code) {
  const body = await requestTikTokToken({
    client_key: config.tiktok.clientKey,
    client_secret: config.tiktok.clientSecret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: config.tiktok.redirectUri
  });

  return normalizeTokenResponse(body);
}

async function getTikTokAuthStatus(accountId, userId, workspaceScope) {
  const auth = await storage.getTikTokAccount(userId, accountId, workspaceScope);
  return {
    connected: Boolean(auth && auth.connected && auth.access_token),
    accountId: auth ? auth.accountId : String(accountId || ''),
    open_id: auth ? auth.open_id || '' : '',
    username: auth ? auth.username || '' : '',
    displayName: auth ? auth.displayName || '' : '',
    avatarUrl: auth ? auth.avatarUrl || '' : '',
    expires_at: auth ? auth.expires_at || null : null,
    scope: auth ? auth.scope || '' : ''
  };
}

async function refreshTikTokToken(accountId, userId, workspaceScope) {
  const auth = await storage.getTikTokAccount(userId, accountId, workspaceScope);
  if (!auth || !auth.connected || !auth.refresh_token) {
    return null;
  }

  const body = await requestTikTokToken({
    client_key: config.tiktok.clientKey,
    client_secret: config.tiktok.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: auth.refresh_token
  });

  return storage.saveTikTokAccount(userId, normalizeTokenResponse(body, auth), {}, workspaceScope);
}

async function publishPhotoPost(post) {
  const accountId = String((post && post.accountId) || '').trim();
  if (!accountId || accountId === 'legacy') {
    return {
      ok: false,
      mode: 'api',
      reason: 'TikTok account is unassigned for this job; publishing was blocked.'
    };
  }

  let auth;

  try {
    auth = await getActiveTikTokAuth(
      accountId,
      post.userId,
      post.workspaceId ? { workspaceId: post.workspaceId } : undefined
    );
  } catch (error) {
    return {
      ok: false,
      mode: 'api',
      reason: error.message,
      response: error.response || null
    };
  }

  if (!auth) {
    return {
      ok: false,
      mode: 'manual',
      reason: `TikTok account ${accountId} is not connected or its token has expired. Please click Disconnect then reconnect TikTok to get a fresh token.`
    };
  }

  if (post.tiktokOpenId && auth.open_id !== post.tiktokOpenId) {
    return {
      ok: false,
      mode: 'api',
      reason: 'TikTok account identity does not match this job; publishing was blocked.'
    };
  }

  // Destination-level sound mode is resolved here, at the provider boundary,
  // from the fanned-out post's own soundMode. A video that asked for TikTok
  // recommended sound cannot be auto-published honestly, so refuse before any
  // external call (no creator-info query, no init).
  if (isVideoPost(post) && resolveSoundCapability(post.mediaType, post.soundMode).manualCompletionRequired) {
    return {
      ok: false,
      mode: 'manual',
      code: SOUND_MODE_MANUAL_CODE,
      reason: SOUND_MODE_MANUAL_REASON
    };
  }

  // Privacy fail-closed #1 (no external call): an explicitly set but unknown
  // privacy value is refused outright rather than trusted or silently defaulted
  // — reject before we even query the account.
  if (post.privacyLevel && !isTikTokPrivacyLevel(post.privacyLevel)) {
    return {
      ok: false,
      mode: 'manual',
      code: PRIVACY_LEVEL_INVALID_CODE,
      reason: `Unknown TikTok privacy level "${post.privacyLevel}". Set a valid privacy level before publishing.`
    };
  }

  const creatorInfo = await queryCreatorInfoForPublish(auth.access_token);

  // Privacy fail-closed #2 (capability): when the connected account reports its
  // allowed privacy options, the persisted value MUST be one of them. Anything
  // else fails here — before any PHOTO/VIDEO init call — instead of
  // resolvePrivacyLevel silently substituting a different (possibly more public)
  // level. SELF_ONLY is never converted to PUBLIC_TO_EVERYONE.
  const requestedPrivacy = normalizeTikTokPrivacyLevel(post.privacyLevel);
  const privacyOptions = Array.isArray(creatorInfo && creatorInfo.privacy_level_options)
    ? creatorInfo.privacy_level_options.map((option) => String(option || '').trim()).filter(Boolean)
    : [];
  if (privacyOptions.length > 0 && !privacyOptions.includes(requestedPrivacy)) {
    return {
      ok: false,
      mode: 'manual',
      code: PRIVACY_LEVEL_UNSUPPORTED_CODE,
      reason: `Privacy level ${requestedPrivacy} is not permitted for this connected TikTok account. Choose an allowed privacy level before publishing.`
    };
  }

  if (isVideoPost(post)) {
    return publishVideoPost(post, auth.access_token, creatorInfo);
  }

  const imageUrl = getPublicImageUrl(post);
  if (!imageUrl) {
    return {
      ok: false,
      mode: 'manual',
      reason: 'Public image URL missing'
    };
  }

  const payload = buildPhotoPayload(post, imageUrl, creatorInfo);
  return postPhotoPayload(payload, auth.access_token);
}

function isVideoPost(post) {
  const mediaType = String(post.mediaType || '').toLowerCase();
  if (mediaType === 'video') return true;

  const fileName = String(post.fileName || post.mediaPath || post.videoPath || '').toLowerCase();
  return ['.mp4', '.mov', '.webm'].some((extension) => fileName.endsWith(extension));
}

async function publishVideoPost(post, accessToken, creatorInfo = null) {
  // Destination-level sound mode: `mute` uploads a muted derivative of the
  // canonical asset; keep_original uploads the asset unchanged. The muted copy
  // is a throwaway temp file (source.cleanup removes it) — the stored asset is
  // never mutated.
  const capability = resolveSoundCapability(post.mediaType, post.soundMode);
  const source = capability.requiresMutedDerivative
    ? await getMutedVideoSource(post)
    : await getVideoSource(post);
  if (!source.ok) return source;

  const fileSize = source.fileSize;
  const { chunkSize, totalChunkCount } = calculateTikTokChunks(fileSize);

  const payload = buildVideoPayload(post, fileSize, creatorInfo, { chunkSize, totalChunkCount });
  const initResult = await postVideoInitPayload(payload, accessToken);

  if (!initResult.ok) {
    await cancelVideoSource(source);
    return initResult;
  }

  const uploadUrl = getUploadUrl(initResult.response);
  if (!uploadUrl) {
    await cancelVideoSource(source);
    return {
      ok: false,
      mode: 'api',
      reason: 'TikTok video init did not return upload_url',
      response: initResult.response
    };
  }

  const uploadResult = await uploadVideoFile(
    uploadUrl,
    source,
    fileSize,
    chunkSize,
    totalChunkCount
  );
  await cancelVideoSource(source);
  if (!uploadResult.ok) return uploadResult;

  return {
    ok: true,
    mode: 'api',
    response: {
      init: initResult.response,
      upload: uploadResult.response
    }
  };
}

async function cancelVideoSource(source) {
  if (!source) return;
  try {
    if (source.streamReader && typeof source.streamReader.cancel === 'function') {
      await source.streamReader.cancel();
    } else if (source.stream && typeof source.stream.cancel === 'function') {
      await source.stream.cancel();
    }
  } catch (error) {
    // The upload may already own or have consumed the stream.
  }
  // Remove any temp files a derived (muted) source materialized. Runs on every
  // publish path — success, init failure, and upload failure all reach here.
  if (typeof source.cleanup === 'function') {
    try {
      await source.cleanup();
    } catch (error) {
      // Best-effort cleanup must never mask the real publish result.
    }
  }
}

// Bring the canonical video to a local file so it can be muted. A durable local
// upload is used in place (never deleted); a remote asset is downloaded to a
// temp file the caller owns. The canonical stored asset is never modified.
async function materializeLocalVideo(post) {
  const localPath = getLocalMediaPath(post);
  if (localPath) {
    try {
      const stats = fs.statSync(localPath);
      if (stats.isFile() && stats.size > 0) {
        return { ok: true, path: localPath, cleanup: async () => {} };
      }
    } catch (error) {
      // Render restarts wipe local uploads. Fall through to the durable URL.
    }
  }

  const remoteUrl = getRemoteMediaUrl(post);
  if (!remoteUrl) {
    return {
      ok: false,
      mode: 'manual',
      reason: localPath ? `Video file not found: ${path.basename(localPath)}` : 'Video media URL missing'
    };
  }

  const extension = safeVideoExtension(remoteUrl);
  const tempPath = path.join(config.uploadsDir, `tiktok-src-${randomUUID()}${extension}`);
  try {
    const response = await fetch(remoteUrl, { signal: requestSignal(config.tiktok.uploadTimeoutMs) });
    if (!response.ok) {
      return { ok: false, mode: 'api', reason: `Video media download returned HTTP ${response.status}` };
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0) {
      return { ok: false, mode: 'api', reason: 'Video file is empty' };
    }
    await fsp.mkdir(config.uploadsDir, { recursive: true });
    await fsp.writeFile(tempPath, buffer);
    return { ok: true, path: tempPath, cleanup: async () => { await fsp.rm(tempPath, { force: true }); } };
  } catch (error) {
    await fsp.rm(tempPath, { force: true }).catch(() => {});
    return { ok: false, mode: 'api', reason: `Could not load video media: ${error.message}` };
  }
}

// A ready-to-upload source pointing at a muted derivative of the canonical
// video. Mirrors getVideoSource's local-file shape so uploadVideoFile treats it
// identically; cleanup removes both any downloaded source and the muted copy.
async function getMutedVideoSource(post) {
  const input = await materializeLocalVideo(post);
  if (!input.ok) return input;

  const extension = safeVideoExtension(input.path);
  const mutedPath = path.join(config.uploadsDir, `tiktok-muted-${randomUUID()}${extension}`);
  try {
    await fsp.mkdir(config.uploadsDir, { recursive: true });
    await deriveMutedVideo(input.path, mutedPath);
  } catch (error) {
    await input.cleanup();
    await fsp.rm(mutedPath, { force: true }).catch(() => {});
    return { ok: false, mode: 'api', reason: `Could not mute the video for TikTok: ${error.message}` };
  }

  let stats;
  try {
    stats = fs.statSync(mutedPath);
  } catch (error) {
    await input.cleanup();
    return { ok: false, mode: 'api', reason: 'The muted video could not be read after rendering.' };
  }

  return {
    ok: true,
    source: 'local',
    videoPath: mutedPath,
    fileSize: stats.size,
    cleanup: async () => {
      await input.cleanup();
      await fsp.rm(mutedPath, { force: true }).catch(() => {});
    }
  };
}

function safeVideoExtension(value) {
  let candidate = '';
  try {
    candidate = path.extname(new URL(value).pathname);
  } catch (error) {
    candidate = path.extname(String(value || ''));
  }
  const normalized = String(candidate || '').toLowerCase();
  return ['.mp4', '.mov', '.webm'].includes(normalized) ? normalized : '.mp4';
}

async function getVideoSource(post) {
  const videoPath = getLocalMediaPath(post);

  if (videoPath) {
    try {
      const stats = fs.statSync(videoPath);
      if (stats.isFile() && stats.size > 0) {
        return { ok: true, source: 'local', videoPath, fileSize: stats.size };
      }
    } catch (error) {
      // Render restarts wipe local uploads. Fall through to the durable URL.
    }
  }

  const remoteUrl = getRemoteMediaUrl(post);
  if (!remoteUrl) {
    return {
      ok: false,
      mode: 'manual',
      reason: videoPath ? `Video file not found: ${path.basename(videoPath)}` : 'Video media URL missing'
    };
  }

  try {
    const response = await fetch(remoteUrl, { signal: requestSignal(config.tiktok.uploadTimeoutMs) });
    if (!response.ok) {
      return {
        ok: false,
        mode: 'api',
        reason: `Video media download returned HTTP ${response.status}`
      };
    }

    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > 0 && response.body) {
      return { ok: true, source: 'remote', stream: response.body, fileSize: contentLength };
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0) {
      return {
        ok: false,
        mode: 'api',
        reason: 'Video file is empty'
      };
    }

    return { ok: true, source: 'remote', buffer, fileSize: buffer.length };
  } catch (error) {
    return {
      ok: false,
      mode: 'api',
      reason: `Could not load video media: ${error.message}`
    };
  }
}

async function queryCreatorInfo(accountId, userId, workspaceScope) {
  const auth = await getActiveTikTokAuth(accountId, userId, workspaceScope);
  if (!auth || !auth.access_token) {
    throw new Error('TikTok not connected');
  }

  return queryCreatorInfoWithToken(auth.access_token);
}

async function queryCreatorInfoForPublish(accessToken) {
  try {
    return await queryCreatorInfoWithToken(accessToken);
  } catch (error) {
    console.warn('[tiktok] creator info query failed', error.message);
    return null;
  }
}

async function queryCreatorInfoWithToken(accessToken) {
  const response = await fetch(creatorInfoQueryUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8'
    },
    body: JSON.stringify({}),
    signal: requestSignal()
  });

  const body = await parseResponseBody(response);

  if (!response.ok) {
    const error = new Error(`TikTok creator info returned HTTP ${response.status}`);
    error.response = body;
    throw error;
  }

  const apiError = getTikTokApiError(body);
  if (apiError) {
    const error = new Error(apiError);
    error.response = body;
    throw error;
  }

  return normalizeCreatorInfo(body);
}

function normalizeCreatorInfo(body) {
  const data = body && typeof body === 'object' && body.data && typeof body.data === 'object'
    ? body.data
    : body || {};

  const privacyLevelOptions = Array.isArray(data.privacy_level_options)
    ? data.privacy_level_options.map((option) => String(option || '').trim()).filter(Boolean)
    : [];

  return {
    creator_username: String(data.creator_username || '').trim(),
    creator_nickname: String(data.creator_nickname || '').trim(),
    creator_avatar_url: String(data.creator_avatar_url || '').trim(),
    privacy_level_options: privacyLevelOptions,
    comment_disabled: Boolean(data.comment_disabled),
    duet_disabled: Boolean(data.duet_disabled),
    stitch_disabled: Boolean(data.stitch_disabled),
    max_video_post_duration_sec: Number(data.max_video_post_duration_sec || 0) || 0
  };
}

function calculateTikTokChunks(videoSize) {
  if (!Number.isFinite(videoSize) || videoSize <= 0) {
    throw new Error('Invalid video size');
  }

  if (videoSize <= MAX_CHUNK_SIZE) {
    return {
      chunkSize: videoSize,
      totalChunkCount: 1
    };
  }

  const totalChunkCount = Math.ceil(videoSize / MAX_CHUNK_SIZE);
  const chunkSize = Math.floor(videoSize / totalChunkCount);

  if (chunkSize < MIN_CHUNK_SIZE || chunkSize > MAX_CHUNK_SIZE) {
    throw new Error(`Invalid calculated TikTok chunk size: ${chunkSize}`);
  }

  return {
    chunkSize,
    totalChunkCount
  };
}

function getTikTokChunkRange(index, chunkSize, totalChunkCount, videoSize) {
  const start = index * chunkSize;
  const end = index === totalChunkCount - 1
    ? videoSize - 1
    : start + chunkSize - 1;
  const contentLength = end - start + 1;

  return {
    start,
    end,
    contentLength,
    contentRange: `bytes ${start}-${end}/${videoSize}`
  };
}

function buildVideoPayload(post, fileSize, creatorInfo = null, chunkConfig = null) {
  const { chunkSize, totalChunkCount } = chunkConfig || calculateTikTokChunks(fileSize);

  return {
    post_info: {
      title: buildCaption(post),
      privacy_level: resolvePrivacyLevel(post, creatorInfo),
      disable_duet:    Boolean(post.disableDuet),
      disable_comment: Boolean(post.disableComment),
      disable_stitch:  Boolean(post.disableStitch)
    },
    source_info: {
      source: 'FILE_UPLOAD',
      video_size: fileSize,
      chunk_size: chunkSize,
      total_chunk_count: totalChunkCount
    },
    post_mode: 'DIRECT_POST'
  };
}

async function postVideoInitPayload(payload, accessToken) {
  try {
    safeLog('[tiktok] video init payload', payload);

    const response = await fetch(videoInitUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8'
      },
      body: JSON.stringify(payload),
      signal: requestSignal()
    });

    const body = await parseResponseBody(response);

    if (!response.ok) {
      const error = getTikTokErrorLogFields(body);
      safeError('[tiktok] video init failed', {
        status: response.status,
        code: error.code,
        message: error.message,
        log_id: error.logId,
        body,
        payload
      });

      // HTTP 403 after approval = stale pre-approval token
      // User must Disconnect and reconnect TikTok to get fresh production token
      const reason = response.status === 403
        ? 'Token was issued before app approval. Please click Disconnect then reconnect TikTok to get a fresh production token.'
        : `TikTok video init returned HTTP ${response.status}`;

      return {
        ok: false,
        mode: 'api',
        reason,
        response: body
      };
    }

    const apiError = getTikTokApiError(body);
    if (apiError) {
      const error = getTikTokErrorLogFields(body);
      safeError('[tiktok] video init failed', {
        status: response.status,
        code: error.code,
        message: error.message,
        log_id: error.logId,
        body,
        payload
      });

      return {
        ok: false,
        mode: 'api',
        reason: apiError,
        response: body
      };
    }

    return {
      ok: true,
      mode: 'api',
      response: body
    };
  } catch (error) {
    return {
      ok: false,
      mode: 'api',
      reason: error.message
    };
  }
}

async function uploadVideoFile(uploadUrl, source, fileSize, chunkSize, totalChunkCount) {
  try {
    let lastResponseBody = null;

    for (let index = 0; index < totalChunkCount; index += 1) {
      const range = getTikTokChunkRange(index, chunkSize, totalChunkCount, fileSize);
      const uploadBody = createTikTokChunkBody(source, range);
      const requestOptions = {
        method: 'PUT',
        headers: {
          'Content-Type': 'video/mp4',
          'Content-Length': String(range.contentLength),
          'Content-Range': range.contentRange
        },
        body: uploadBody,
        signal: requestSignal(config.tiktok.uploadTimeoutMs)
      };
      if (source.stream || source.videoPath) requestOptions.duplex = 'half';

      const response = await fetch(uploadUrl, requestOptions);
      const body = await parseResponseBody(response);

      if (!response.ok) {
        const error = getTikTokErrorLogFields(body);
        safeError('[tiktok] video upload failed', {
          status: response.status,
          code: error.code,
          message: error.message,
          log_id: error.logId,
          chunk_index: index,
          body
        });

        return {
          ok: false,
          mode: 'api',
          reason: `TikTok video upload returned HTTP ${response.status}`,
          response: body
        };
      }

      lastResponseBody = body;
    }

    return {
      ok: true,
      mode: 'api',
      response: lastResponseBody || { uploaded: true, size: fileSize, chunks: totalChunkCount }
    };
  } catch (error) {
    return {
      ok: false,
      mode: 'api',
      reason: error.message
    };
  }
}

function createTikTokChunkBody(source, range) {
  if (source.buffer) {
    return source.buffer.subarray(range.start, range.end + 1);
  }

  if (source.videoPath) {
    return fs.createReadStream(source.videoPath, {
      start: range.start,
      end: range.end
    });
  }

  if (source.stream) {
    return createRemoteTikTokChunkStream(source, range.contentLength);
  }

  throw new Error('TikTok video source is unavailable');
}

function createRemoteTikTokChunkStream(source, contentLength) {
  if (!source.streamReader) {
    source.streamReader = source.stream.getReader();
  }

  let remaining = contentLength;

  return new ReadableStream({
    async pull(controller) {
      if (remaining === 0) {
        controller.close();
        return;
      }

      let chunk = source.pendingStreamChunk;
      if (!chunk || chunk.byteLength === 0) {
        const { done, value } = await source.streamReader.read();
        if (done) {
          controller.error(new Error('Video media stream ended before the declared size'));
          return;
        }
        chunk = value;
      }

      const bytesToSend = Math.min(chunk.byteLength, remaining);
      const output = chunk.subarray(0, bytesToSend);
      source.pendingStreamChunk = bytesToSend < chunk.byteLength
        ? chunk.subarray(bytesToSend)
        : null;
      remaining -= bytesToSend;
      controller.enqueue(output);

      if (remaining === 0) controller.close();
    },
    async cancel(reason) {
      await source.streamReader.cancel(reason);
    }
  });
}

function getUploadUrl(response) {
  if (!response || typeof response !== 'object') return '';
  return response.upload_url || (response.data && response.data.upload_url) || '';
}

function getLocalMediaPath(post) {
  const fileName = String(post.fileName || '').trim();
  if (!fileName) return '';

  const uploadPath = path.resolve(config.uploadsDir, fileName);
  const uploadsRoot = path.resolve(config.uploadsDir);

  if (!uploadPath.startsWith(uploadsRoot)) return '';
  return uploadPath;
}

function getRemoteMediaUrl(post) {
  const candidates = [
    post.mediaUrl,
    post.videoPath,
    post.mediaPath,
    post.publicMediaUrl,
    post.publicImageUrl
  ];

  return candidates.map((value) => String(value || '').trim()).find(isUsablePublicUrl) || '';
}

function buildPhotoPayload(post, imageUrl, creatorInfo = null) {
  // Destination-level sound mode for a photo post. A photo carries no source
  // audio, so keep_original and mute are both silent (auto_add_music:false);
  // only tiktok_recommended asks TikTok to add a recommended track.
  const capability = resolveSoundCapability('photo', post && post.soundMode);
  return {
    post_info: {
      title: buildCaption(post),
      privacy_level: resolvePrivacyLevel(post, creatorInfo),
      disable_duet:    true,  // Not applicable for photo posts per TikTok guidelines
      disable_comment: Boolean(post.disableComment),
      disable_stitch:  true,  // Not applicable for photo posts per TikTok guidelines
      auto_add_music:  capability.autoAddMusic
    },
    source_info: {
      source: 'PULL_FROM_URL',
      photo_cover_index: 0,
      photo_images: [imageUrl]
    },
    post_mode: 'DIRECT_POST',
    media_type: 'PHOTO'
  };
}

function resolvePrivacyLevel(post, creatorInfo = null) {
  const requested = String((post && post.privacyLevel) || config.tiktok.privacyLevel || 'SELF_ONLY').trim() || 'SELF_ONLY';
  const configured = String(config.tiktok.privacyLevel || 'SELF_ONLY').trim() || 'SELF_ONLY';
  const options = creatorInfo && Array.isArray(creatorInfo.privacy_level_options)
    ? creatorInfo.privacy_level_options.map((option) => String(option || '').trim()).filter(Boolean)
    : [];

  if (options.length === 0) return requested;
  if (options.includes(requested)) return requested;
  if (options.includes(configured)) return configured;
  if (options.includes('SELF_ONLY')) return 'SELF_ONLY';
  return options[0];
}

function getPublicImageUrl(post) {
  const publicUrl = [post.mediaUrl, post.publicMediaUrl, post.publicImageUrl]
    .map((value) => String(value || '').trim())
    .find(isUsablePublicUrl);
  if (publicUrl) return publicUrl;

  const localImagePath = String(post.imageUrl || post.mediaPath || '').trim();
  if (!config.publicBaseUrl || !localImagePath) return '';

  const fallbackUrl = `${config.publicBaseUrl}${localImagePath.startsWith('/') ? '' : '/'}${localImagePath}`;
  return isUsablePublicUrl(fallbackUrl) ? fallbackUrl : '';
}

function buildCaption(post) {
  return [post.caption, post.hashtags]
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join('\n\n');
}

async function getActiveTikTokAuth(accountId, userId, workspaceScope) {
  const auth = await storage.getTikTokAccount(userId, accountId, workspaceScope);
  if (!auth) return null;
  if (!auth.connected || !auth.access_token) return null;
  if (!shouldRefresh(auth)) return auth;

  // Token is near expiry — attempt refresh. If refresh fails (e.g.,
  // refresh_token expired or revoked), return null so the caller
  // produces a clear "reconnect required" message instead of silently
  // using a stale token.
  try {
    const refreshed = await refreshTikTokToken(accountId, userId, workspaceScope);
    if (!refreshed || !refreshed.access_token) {
      console.warn('[tiktok] token refresh returned no valid token for account', redactSensitive({ accountId }));
      return null;
    }
    return refreshed;
  } catch (error) {
    console.warn('[tiktok] token refresh failed for account', redactSensitive({ accountId, error: error.message }));
    return null;
  }
}

function shouldRefresh(auth) {
  if (!auth.expires_at) return false;
  const expiresAt = new Date(auth.expires_at).getTime();
  if (!Number.isFinite(expiresAt)) return false;
  return expiresAt - tokenRefreshBufferMs <= Date.now();
}

async function postPhotoPayload(payload, accessToken) {
  try {
    safeLog('[tiktok] photo publish payload', payload);

    const response = await fetch(config.tiktok.contentPostInitUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8'
      },
      body: JSON.stringify(payload),
      signal: requestSignal()
    });

    const body = await parseResponseBody(response);

    if (!response.ok) {
      safeError('[tiktok] photo content init failed', {
        status: response.status,
        body,
        payload
      });

      const reason = response.status === 403
        ? 'Token was issued before app approval. Please click Disconnect then reconnect TikTok to get a fresh production token.'
        : `TikTok photo init returned HTTP ${response.status}`;

      return {
        ok: false,
        mode: 'api',
        reason,
        response: body
      };
    }

    const apiError = getTikTokApiError(body);
    if (apiError) {
      return {
        ok: false,
        mode: 'api',
        reason: apiError,
        response: body
      };
    }

    return {
      ok: true,
      mode: 'api',
      response: body
    };
  } catch (error) {
    return {
      ok: false,
      mode: 'api',
      reason: error.message
    };
  }
}

async function requestTikTokToken(params) {
  if (!config.tiktok.clientKey || !config.tiktok.clientSecret) {
    throw new Error('TikTok client key and secret are required');
  }

  const response = await fetch(config.tiktok.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cache-Control': 'no-cache'
    },
    body: new URLSearchParams(params).toString(),
    signal: requestSignal()
  });

  const body = await parseResponseBody(response);

  if (!response.ok || (body && body.error)) {
    const error = new Error(getTikTokErrorMessage(body, `TikTok OAuth returned HTTP ${response.status}`));
    error.response = body;
    throw error;
  }

  return body || {};
}

function normalizeTokenResponse(body, previous = {}) {
  const expiresIn = Number(body.expires_in || 0);
  const expiresAt = expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000).toISOString() : null;

  return {
    connected: Boolean(body.access_token || previous.access_token),
    open_id: body.open_id || previous.open_id || '',
    access_token: body.access_token || previous.access_token || '',
    refresh_token: body.refresh_token || previous.refresh_token || '',
    expires_at: expiresAt,
    scope: body.scope || previous.scope || ''
  };
}

function getTikTokErrorMessage(body, fallback) {
  if (!body || typeof body !== 'object') return fallback;
  return body.error_description || body.message || body.error || fallback;
}

function getTikTokApiError(body) {
  if (!body || typeof body !== 'object') return '';

  const error = body.error;
  if (!error) return '';

  if (typeof error === 'string') {
    return error.toLowerCase() === 'ok' ? '' : error;
  }

  if (typeof error !== 'object') return '';

  const code = String(error.code || '').toLowerCase();
  if (!code || code === 'ok' || code === 'success') return '';

  return error.message || error.description || `TikTok API returned ${error.code}`;
}

function getTikTokErrorLogFields(body) {
  const error = body && typeof body === 'object' && body.error && typeof body.error === 'object'
    ? body.error
    : {};

  return {
    code: String(error.code || ''),
    message: String(error.message || error.description || ''),
    logId: String(error.log_id || '')
  };
}

function isUsablePublicUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !isLocalHost(url.hostname);
  } catch (error) {
    return false;
  }
}

function isLocalHost(hostname) {
  const value = String(hostname || '').toLowerCase();
  return value === 'localhost' || value === '::1' || value.startsWith('127.');
}

async function parseResponseBody(response) {
  const text = await response.text();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch (error) {
    return text;
  }
}

module.exports = {
  isConfigured,
  buildTikTokAuthUrl,
  exchangeCodeForToken,
  getTikTokAuthStatus,
  refreshTikTokToken,
  queryCreatorInfo,
  publishPhotoPost,
  buildCaption,
  buildPhotoPayload,
  buildVideoPayload,
  calculateTikTokChunks,
  getTikTokChunkRange,
  getPublicImageUrl,
  resolvePrivacyLevel,
  redactSensitive
};
