'use strict';

// YouTube OAuth route contract. The Google network layer and the state
// store are replaced with in-memory fakes that keep the exact semantics
// (single-use, expiring, user/provider-bound — those semantics themselves
// are proven in oauth-state-store.test.js); everything else (routes, auth,
// CSRF, vault, finalization, storage rules) runs real.

process.env.ADMIN_PASSWORD = 'test-admin-password-123';
process.env.ENABLE_INSTAGRAM = 'false';
process.env.TOKEN_ENCRYPTION_KEY = require('node:crypto').randomBytes(32).toString('base64');
process.env.YOUTUBE_CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
process.env.YOUTUBE_CLIENT_SECRET = 'CANARY-ROUTE-CLIENT-SECRET-abc123';
process.env.YOUTUBE_REDIRECT_URI = 'http://localhost:10000/auth/youtube/callback';

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const express = require('express');
const { randomBytes } = require('node:crypto');

const storage = require('../src/storage');
const youtube = require('../src/youtube');
const oauthStateStore = require('../src/oauthStateStore');
const tokenVault = require('../src/tokenVault');
const { attachUser, csrfOriginCheck, createAdminSessionToken, ADMIN_SESSION_COOKIE } = require('../src/auth');
const config = require('../src/config');

const CANARY_ACCESS = 'CANARY-ROUTE-ACCESS-TOKEN';
const CANARY_REFRESH = 'CANARY-ROUTE-REFRESH-TOKEN';
const AUTH_CODE = 'CANARY-AUTH-CODE-4f9d';

// ── In-memory state store with the real semantics ──────────────────────────
const stateRecords = new Map();
oauthStateStore.createOAuthState = async (fields, { now = Date.now() } = {}) => {
  const id = randomBytes(32).toString('base64url');
  stateRecords.set(id, { kind: 'oauth_state', expiresAtMs: now + oauthStateStore.STATE_TTL_MS, ...fields });
  return id;
};
oauthStateStore.consumeOAuthState = async (id, { userId, provider, now = Date.now() } = {}) => {
  const record = stateRecords.get(id);
  stateRecords.delete(id);
  if (!record || record.kind !== 'oauth_state') return { ok: false, code: 'missing_or_replayed' };
  if (record.expiresAtMs <= now) return { ok: false, code: 'expired' };
  if (String(record.userId) !== String(userId)) return { ok: false, code: 'wrong_user' };
  if (provider && record.provider !== provider) return { ok: false, code: 'wrong_provider' };
  return { ok: true, record };
};
oauthStateStore.createChannelSelection = async (fields, { now = Date.now() } = {}) => {
  const id = randomBytes(32).toString('base64url');
  stateRecords.set(id, { kind: 'channel_selection', expiresAtMs: now + oauthStateStore.SELECTION_TTL_MS, ...fields });
  return id;
};
oauthStateStore.consumeChannelSelection = async (id, { userId, provider, now = Date.now() } = {}) => {
  const record = stateRecords.get(id);
  stateRecords.delete(id);
  if (!record || record.kind !== 'channel_selection') return { ok: false, code: 'missing_or_replayed' };
  if (record.expiresAtMs <= now) return { ok: false, code: 'expired' };
  if (String(record.userId) !== String(userId)) return { ok: false, code: 'wrong_user' };
  if (provider && record.provider !== provider) return { ok: false, code: 'wrong_provider' };
  return { ok: true, record };
};

// ── Google layer fakes (adapter network calls only) ────────────────────────
let exchangeCalls = [];
let channelsScenario = 'one';
let exchangeScenario = 'with-refresh';
let revokeCalls = [];
let revokeResult = { revoked: true };

youtube.exchangeCodeForToken = async (code, verifier) => {
  exchangeCalls.push({ code, verifier });
  const tokens = {
    access_token: CANARY_ACCESS,
    refresh_token: exchangeScenario === 'with-refresh' ? CANARY_REFRESH : ''
  };
  return {
    tokens,
    meta: {
      tokenPresent: true,
      refreshTokenPresent: Boolean(tokens.refresh_token),
      accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
      grantedScopes: 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly',
      refreshTokenRotated: Boolean(tokens.refresh_token)
    }
  };
};
youtube.listMyChannels = async () => {
  if (channelsScenario === 'zero') return [];
  if (channelsScenario === 'multi') {
    return [
      { channelId: 'UC-chanter', title: 'chanterCy', handle: '@chanterCy', thumbnailUrl: '' },
      { channelId: 'UC-brand', title: 'Brand Channel', handle: '@brand', thumbnailUrl: '' }
    ];
  }
  return [{ channelId: 'UC-chanter', title: 'chanterCy', handle: '@chanterCy', thumbnailUrl: '' }];
};
youtube.revokeToken = async (token) => {
  revokeCalls.push(token);
  return revokeResult;
};

// ── Storage fakes (account persistence only; envelope rules stay real) ─────
const savedAccounts = new Map();
const reauthorizationMarks = [];
const accountActivationContexts = [];
storage.getYouTubeAccounts = async () => [...savedAccounts.values()];
storage.getYouTubeAccount = async (userId, accountId) => {
  const account = savedAccounts.get(accountId);
  return account && account.userId === userId ? account : null;
};
storage.saveYouTubeAccount = async (
  userId,
  { channelId, profile, credentialEnvelope, tokenMeta },
  workspaceScope,
  activationContext
) => {
  if (!credentialEnvelope || !credentialEnvelope.ct) {
    throw new Error('YouTube credentials must be an encrypted envelope; refusing to persist');
  }
  if (activationContext) accountActivationContexts.push({ workspaceScope, activationContext });
  const account = {
    accountId: channelId,
    id: channelId,
    userId,
    provider: 'youtube',
    platform: 'youtube',
    channelId,
    username: String(profile.handle || '').replace(/^@/, ''),
    displayName: profile.title || '',
    avatarUrl: profile.thumbnailUrl || '',
    connected: Boolean(tokenMeta.tokenPresent),
    tokenPresent: Boolean(tokenMeta.tokenPresent),
    refreshTokenPresent: Boolean(tokenMeta.refreshTokenPresent),
    accessTokenExpiresAt: tokenMeta.accessTokenExpiresAt || null,
    grantedScopes: tokenMeta.grantedScopes || '',
    scope: tokenMeta.grantedScopes || '',
    reauthorizationRequired: false,
    credential: credentialEnvelope,
    connectedAt: new Date().toISOString()
  };
  savedAccounts.set(channelId, account);
  return account;
};
storage.getYouTubeAccountCredential = async (userId, channelId) => {
  const account = savedAccounts.get(channelId);
  return account && account.userId === userId ? account.credential || null : null;
};
storage.markYouTubeAccountReauthorizationRequired = async (userId, channelId, code) => {
  reauthorizationMarks.push({ channelId, code });
  const account = savedAccounts.get(channelId);
  if (account) account.reauthorizationRequired = true;
  return true;
};
storage.disconnectYouTubeAccount = async (userId, channelId) => {
  const account = savedAccounts.get(channelId);
  if (!account || account.userId !== userId) return false;
  account.connected = false;
  account.credential = null;
  account.tokenPresent = false;
  account.refreshTokenPresent = false;
  return true;
};

const { installCommercialFixture } = require('./helpers/commercial-fixture');
installCommercialFixture(require('../src/commercialService'), storage);
const routes = require('../src/routes');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'src', 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(attachUser);
app.use(csrfOriginCheck);
app.use('/', routes);

let server;
let baseUrl;
const adminCookie = `${ADMIN_SESSION_COOKIE}=${createAdminSessionToken()}`;

test.before(async () => {
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => new Promise((resolve) => server.close(resolve)));

function resetScenario() {
  exchangeCalls = [];
  revokeCalls = [];
  channelsScenario = 'one';
  exchangeScenario = 'with-refresh';
  revokeResult = { revoked: true };
  savedAccounts.clear();
  stateRecords.clear();
  reauthorizationMarks.length = 0;
  accountActivationContexts.length = 0;
}

async function get(pathname, { cookies = [adminCookie], redirect = 'manual' } = {}) {
  return fetch(`${baseUrl}${pathname}`, { redirect, headers: { cookie: cookies.join('; ') } });
}

async function post(pathname, body, { cookies = [adminCookie], origin = baseUrl } = {}) {
  return fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      cookie: cookies.join('; '),
      'content-type': 'application/x-www-form-urlencoded',
      ...(origin ? { origin } : {})
    },
    body: new URLSearchParams(body).toString()
  });
}

function noticeOf(response) {
  const location = response.headers.get('location') || '';
  const match = location.match(/notice=([^&]*)/);
  return match ? decodeURIComponent(match[1].replace(/\+/g, ' ')) : '';
}

function stateCookieOf(response) {
  const setCookie = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
  const stateCookie = setCookie.find((cookie) => cookie.startsWith('youtube_oauth_state='));
  return stateCookie ? stateCookie.split(';')[0] : '';
}

async function startOAuth(queryString = '') {
  const response = await get(`/connect/youtube${queryString}`);
  assert.equal(response.status, 302);
  const location = new URL(response.headers.get('location'));
  return { location, stateCookie: stateCookieOf(response), state: location.searchParams.get('state') };
}

test('connect requires an authenticated admin', async () => {
  resetScenario();
  const response = await get('/connect/youtube', { cookies: [] });
  assert.equal(response.status, 302);
  assert.match(response.headers.get('location'), /\/admin-login/);
});

test('connect redirects to Google with code flow, offline access, PKCE, exact redirect URI, and a fresh state', async () => {
  resetScenario();
  const first = await startOAuth();
  assert.equal(first.location.origin + first.location.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(first.location.searchParams.get('response_type'), 'code');
  assert.equal(first.location.searchParams.get('access_type'), 'offline');
  assert.equal(first.location.searchParams.get('include_granted_scopes'), 'true');
  assert.equal(first.location.searchParams.get('redirect_uri'), 'http://localhost:10000/auth/youtube/callback');
  assert.equal(first.location.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(first.state && first.state.length >= 40);
  // No stored refresh token anywhere yet: consent is requested to obtain one.
  assert.equal(first.location.searchParams.get('prompt'), 'consent');

  const second = await startOAuth();
  assert.notEqual(first.state, second.state, 'state is unique per authorization');
});

test('an arbitrary returnTo is replaced with a validated internal path', async () => {
  resetScenario();
  const { state } = await startOAuth('?returnTo=https%3A%2F%2Fevil.example.com%2Fphish');
  assert.equal(stateRecords.get(state).returnTo, '/platform');
});

test('valid callback connects the single channel with encrypted custody and returns to the site', async () => {
  resetScenario();
  const { state, stateCookie } = await startOAuth();
  const response = await get(`/auth/youtube/callback?code=${AUTH_CODE}&state=${state}`, {
    cookies: [adminCookie, stateCookie]
  });
  assert.equal(response.status, 302);
  const location = response.headers.get('location');
  assert.match(noticeOf(response), /YouTube channel @chanterCy connected\./);
  assert.equal(location.includes(AUTH_CODE), false, 'the authorization code never appears in the redirect');

  assert.equal(exchangeCalls.length, 1);
  assert.equal(exchangeCalls[0].code, AUTH_CODE);
  assert.ok(exchangeCalls[0].verifier, 'the PKCE verifier from the state record is used');

  const account = savedAccounts.get('UC-chanter');
  assert.ok(account, 'the channel was connected');
  assert.equal(account.username, 'chanterCy');
  assert.equal(tokenVault.isCredentialEnvelope(account.credential), true, 'stored credentials are an encrypted envelope');
  const serialized = JSON.stringify(account.credential);
  assert.equal(serialized.includes(CANARY_ACCESS), false);
  assert.equal(serialized.includes(CANARY_REFRESH), false);
  assert.deepEqual(tokenVault.decryptCredentials(account.credential), {
    access_token: CANARY_ACCESS,
    refresh_token: CANARY_REFRESH
  });
  assert.equal(accountActivationContexts.length, 1);
  assert.equal(accountActivationContexts[0].activationContext.provider, 'youtube');
  assert.equal(
    accountActivationContexts[0].activationContext.workspaceId,
    accountActivationContexts[0].workspaceScope.workspaceId
  );
  assert.equal(JSON.stringify(accountActivationContexts[0]).includes(CANARY_ACCESS), false);
  assert.equal(JSON.stringify(accountActivationContexts[0]).includes(CANARY_REFRESH), false);

  // The state is single-use: replaying the exact same callback fails.
  const replay = await get(`/auth/youtube/callback?code=${AUTH_CODE}&state=${state}`, {
    cookies: [adminCookie, stateCookie]
  });
  assert.match(noticeOf(replay), /invalid OAuth state/);
  assert.equal(exchangeCalls.length, 1, 'no second code exchange happened');
});

test('callback rejects missing, mismatched, expired, and cross-user states, and never leaks the code', async () => {
  resetScenario();

  // Missing state.
  let response = await get(`/auth/youtube/callback?code=${AUTH_CODE}`, { cookies: [adminCookie] });
  assert.match(noticeOf(response), /invalid OAuth state/);

  // State without the browser cookie binding.
  let flow = await startOAuth();
  response = await get(`/auth/youtube/callback?code=${AUTH_CODE}&state=${flow.state}`, { cookies: [adminCookie] });
  assert.match(noticeOf(response), /invalid OAuth state/);

  // Altered state value.
  flow = await startOAuth();
  response = await get(`/auth/youtube/callback?code=${AUTH_CODE}&state=${flow.state}x`, {
    cookies: [adminCookie, flow.stateCookie]
  });
  assert.match(noticeOf(response), /invalid OAuth state/);

  // Expired state.
  flow = await startOAuth();
  stateRecords.get(flow.state).expiresAtMs = Date.now() - 1;
  response = await get(`/auth/youtube/callback?code=${AUTH_CODE}&state=${flow.state}`, {
    cookies: [adminCookie, flow.stateCookie]
  });
  assert.match(noticeOf(response), /invalid OAuth state/);

  // State bound to another user.
  flow = await startOAuth();
  stateRecords.get(flow.state).userId = 'someone-else';
  response = await get(`/auth/youtube/callback?code=${AUTH_CODE}&state=${flow.state}`, {
    cookies: [adminCookie, flow.stateCookie]
  });
  assert.match(noticeOf(response), /invalid OAuth state/);

  // Callback after logout: the admin session is required.
  flow = await startOAuth();
  response = await get(`/auth/youtube/callback?code=${AUTH_CODE}&state=${flow.state}`, {
    cookies: [flow.stateCookie]
  });
  assert.equal(response.status, 302);
  assert.match(response.headers.get('location'), /\/admin-login/);

  assert.equal(exchangeCalls.length, 0, 'no rejected callback reached the code exchange');
  assert.equal(savedAccounts.size, 0, 'no rejected callback connected an account');
});

test('provider error callbacks and missing codes are truthful failures', async () => {
  resetScenario();
  let flow = await startOAuth();
  let response = await get(`/auth/youtube/callback?error=access_denied&state=${flow.state}`, {
    cookies: [adminCookie, flow.stateCookie]
  });
  assert.match(noticeOf(response), /access_denied/);

  flow = await startOAuth();
  response = await get(`/auth/youtube/callback?state=${flow.state}`, {
    cookies: [adminCookie, flow.stateCookie]
  });
  assert.match(noticeOf(response), /no authorization code/);
  assert.equal(exchangeCalls.length, 0);
});

test('zero channels fails truthfully without creating a connection', async () => {
  resetScenario();
  channelsScenario = 'zero';
  const { state, stateCookie } = await startOAuth();
  const response = await get(`/auth/youtube/callback?code=${AUTH_CODE}&state=${state}`, {
    cookies: [adminCookie, stateCookie]
  });
  assert.match(noticeOf(response), /has no YouTube channel/);
  assert.equal(savedAccounts.size, 0);
});

test('a connection without offline access is saved but blocked until reauthorized', async () => {
  resetScenario();
  exchangeScenario = 'no-refresh';
  const { state, stateCookie } = await startOAuth();
  const response = await get(`/auth/youtube/callback?code=${AUTH_CODE}&state=${state}`, {
    cookies: [adminCookie, stateCookie]
  });
  assert.match(noticeOf(response), /did not grant offline access/);
  assert.equal(savedAccounts.get('UC-chanter').reauthorizationRequired, true);
  assert.deepEqual(reauthorizationMarks, [{ channelId: 'UC-chanter', code: 'no_refresh_token' }]);
});

test('multiple channels require explicit selection bound to the same transaction', async () => {
  resetScenario();
  channelsScenario = 'multi';
  const { state, stateCookie } = await startOAuth();
  const response = await get(`/auth/youtube/callback?code=${AUTH_CODE}&state=${state}`, {
    cookies: [adminCookie, stateCookie]
  });
  assert.equal(response.status, 200, 'multi-channel renders the selection view');
  const html = await response.text();
  assert.match(html, /UC-chanter/);
  assert.match(html, /UC-brand/);
  assert.equal(html.includes(CANARY_ACCESS), false, 'no token reaches the selection view');
  assert.equal(html.includes(CANARY_REFRESH), false);
  assert.equal(html.includes(AUTH_CODE), false);
  assert.equal(savedAccounts.size, 0, 'nothing is connected before selection');

  const selectionId = html.match(/name="selectionId" value="([^"]+)"/)[1];

  // A channel Google never returned is rejected.
  let select = await post('/connect/youtube/select', { selectionId, channelId: 'UC-attacker' });
  assert.match(noticeOf(select), /was not part of this authorization/);
  assert.equal(savedAccounts.size, 0);

  // The transaction is single-use: a second attempt with the same id fails…
  select = await post('/connect/youtube/select', { selectionId, channelId: 'UC-chanter' });
  assert.match(noticeOf(select), /expired or was already used/);

  // …so a fresh authorization is needed for a valid selection.
  channelsScenario = 'multi';
  const retry = await startOAuth();
  const retryResponse = await get(`/auth/youtube/callback?code=${AUTH_CODE}&state=${retry.state}`, {
    cookies: [adminCookie, retry.stateCookie]
  });
  const retryHtml = await retryResponse.text();
  const retrySelectionId = retryHtml.match(/name="selectionId" value="([^"]+)"/)[1];
  select = await post('/connect/youtube/select', { selectionId: retrySelectionId, channelId: 'UC-chanter' });
  assert.match(noticeOf(select), /YouTube channel @chanterCy connected\./);
  assert.ok(savedAccounts.get('UC-chanter'));
  assert.equal(savedAccounts.has('UC-brand'), false, 'only the selected channel is connected');
  assert.equal(accountActivationContexts.length, 1, 'selection finalization receives one safe activation context');
});

test('reauthorize preserves the channel identity and rejects a different Google account', async () => {
  resetScenario();
  // Seed a connected channel that needs reauthorization.
  await storage.saveYouTubeAccount('owner', {
    channelId: 'UC-chanter',
    profile: { title: 'chanterCy', handle: '@chanterCy', thumbnailUrl: '' },
    credentialEnvelope: tokenVault.encryptCredentials({ access_token: 'old', refresh_token: 'old-refresh' }),
    tokenMeta: { tokenPresent: true, refreshTokenPresent: false, grantedScopes: '' }
  });

  // The default user id in tests is config.defaultUserId; rebind ownership.
  savedAccounts.get('UC-chanter').userId = config.defaultUserId;

  const { state, stateCookie } = await startOAuth('?reauthorize=UC-chanter');
  assert.equal(stateRecords.get(state).mode, 'reauthorize');
  assert.equal(stateRecords.get(state).accountId, 'UC-chanter');

  // The authorized Google account exposes a different channel only.
  channelsScenario = 'multi';
  youtube.listMyChannels = async () => [{ channelId: 'UC-other', title: 'Other', handle: '@other', thumbnailUrl: '' }];
  const mismatch = await get(`/auth/youtube/callback?code=${AUTH_CODE}&state=${state}`, {
    cookies: [adminCookie, stateCookie]
  });
  assert.match(noticeOf(mismatch), /does not include the channel being reauthorized/);

  // A matching account reauthorizes the SAME connection (no duplicate).
  youtube.listMyChannels = async () => [{ channelId: 'UC-chanter', title: 'chanterCy', handle: '@chanterCy', thumbnailUrl: '' }];
  const retry = await startOAuth('?reauthorize=UC-chanter');
  const response = await get(`/auth/youtube/callback?code=${AUTH_CODE}&state=${retry.state}`, {
    cookies: [adminCookie, retry.stateCookie]
  });
  assert.match(noticeOf(response), /connected/);
  assert.equal(savedAccounts.size, 1, 'reconnect updates the existing record instead of duplicating');
});

test('disconnect requires POST + CSRF origin, attempts revocation, and always clears local credentials', async () => {
  resetScenario();
  await storage.saveYouTubeAccount(config.defaultUserId, {
    channelId: 'UC-chanter',
    profile: { title: 'chanterCy', handle: '@chanterCy', thumbnailUrl: '' },
    credentialEnvelope: tokenVault.encryptCredentials({ access_token: CANARY_ACCESS, refresh_token: CANARY_REFRESH }),
    tokenMeta: { tokenPresent: true, refreshTokenPresent: true, grantedScopes: '' }
  });

  // Cross-origin POST is refused by the CSRF check.
  const crossOrigin = await post('/disconnect/youtube', { accountId: 'UC-chanter' }, { origin: 'https://evil.example.com' });
  assert.equal(crossOrigin.status, 403);
  assert.equal(savedAccounts.get('UC-chanter').connected, true);

  // Same-origin disconnect revokes at Google and clears local credentials.
  const response = await post('/disconnect/youtube', { accountId: 'UC-chanter' });
  assert.match(noticeOf(response), /disconnected and its Google access was revoked/);
  assert.deepEqual(revokeCalls, [CANARY_REFRESH], 'the refresh token is revoked at Google');
  const account = savedAccounts.get('UC-chanter');
  assert.equal(account.connected, false);
  assert.equal(account.credential, null, 'local credentials are removed');

  // Revocation failure is reported truthfully but still clears credentials.
  await storage.saveYouTubeAccount(config.defaultUserId, {
    channelId: 'UC-chanter',
    profile: { title: 'chanterCy', handle: '@chanterCy', thumbnailUrl: '' },
    credentialEnvelope: tokenVault.encryptCredentials({ access_token: CANARY_ACCESS, refresh_token: CANARY_REFRESH }),
    tokenMeta: { tokenPresent: true, refreshTokenPresent: true, grantedScopes: '' }
  });
  revokeResult = { revoked: false, reason: 'Google revocation returned HTTP 503.' };
  const failed = await post('/disconnect/youtube', { accountId: 'UC-chanter' });
  assert.match(noticeOf(failed), /revocation did not complete/);
  assert.equal(savedAccounts.get('UC-chanter').credential, null, 'credentials are cleared even when revocation fails');
});
