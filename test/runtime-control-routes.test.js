'use strict';

// Agent Runtime control surface (P1B) — token auth, tenant scoping, media
// policy reuse, idempotent scheduling, truthful failures, and the guarantee
// that nothing on these routes can reach TikTok publishing code.

process.env.RUNTIME_CONTROL_TOKEN = 'test-runtime-token-1234567890';
process.env.PLATFORM_CANONICAL_MEDIA_REFERENCE_SECRET = 'runtime-staged-reference-test-secret-1234567890';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const express = require('express');

const config = require('../src/config');
const storage = require('../src/storage');
const applicationService = require('../src/autoposterApplicationService');
const { defaultWorkspaceId } = require('../src/workspaceService');
const { createInitialYouTubeProviderOperation, sanitizeProviderOperation } = require('../src/youtubeProviderOperation');
const { createCanonicalStagedMedia } = require('../src/canonicalStagedMedia');

const TOKEN = 'test-runtime-token-1234567890';

const accounts = [
  {
    accountId: 'account-a', open_id: 'open-a', userId: 'owner', platform: 'tiktok',
    username: 'creator_a', displayName: 'Creator A', connected: true,
    access_token: 'CANARY-RUNTIME-ACCOUNT-ACCESS-TOKEN',
    refresh_token: 'CANARY-RUNTIME-ACCOUNT-REFRESH-TOKEN',
    scope: 'video.publish',
    connectedAt: '2026-07-10T08:00:00.000Z'
  },
  { accountId: 'account-cold', open_id: 'open-cold', userId: 'owner', platform: 'tiktok', username: 'creator_cold', connected: false }
];

function makePost(overrides = {}) {
  return {
    id: 'post-1',
    userId: 'owner',
    workspaceId: 'workspace-owner',
    accountId: 'account-a',
    provider: 'tiktok',
    username: 'creator_a',
    status: 'scheduled',
    scheduledAt: '2026-07-11T09:00:00.000Z',
    approved: false,
    approvedAt: null,
    approvedBy: '',
    mediaType: 'video',
    caption: 'First drop',
    createdAt: '2026-07-10T08:00:00.000Z',
    updatedAt: '2026-07-10T08:00:00.000Z',
    postedAt: null,
    publishId: '',
    claimAttempts: 0,
    lastResult: null,
    runtimeIdempotencyKey: '',
    runtimeScheduledBy: '',
    runtimeMissionId: '',
    runtimeGraphId: '',
    runtimeAction: '',
    runtimePayloadHash: '',
    campaignId: 'campaign-post-1',
    approvalId: '',
    evidenceBundleId: '',
    ...overrides
  };
}

// Mutable behavior the tests steer per scenario.
const state = {
  posts: [makePost()],
  getPostsError: null,
  addUploadedPostsCalls: [],
  updatePostCalls: [],
  updatePostResult: 'apply', // 'apply' | 'null' | 'throw'
  tiktokTouched: [],
  legacyAccountReads: [],
  canonicalAccountReads: []
};

storage.getTikTokAccount = async (userId, accountId) => {
  state.legacyAccountReads.push({ operation: 'get', accountId });
  if (userId !== config.defaultUserId) return null;
  return accounts.find((account) => account.accountId === accountId) || null;
};
storage.getYouTubeAccount = async () => null;
storage.getTikTokAccounts = async (userId) => {
  state.legacyAccountReads.push({ operation: 'list' });
  return userId === config.defaultUserId ? accounts : [];
};
storage.getCanonicalTikTokAccount = async (userId, accountId) => {
  state.canonicalAccountReads.push({ operation: 'get', accountId });
  if (userId !== config.defaultUserId) return null;
  return accounts.find((account) => account.accountId === accountId) || null;
};
storage.getCanonicalTikTokAccounts = async (userId) => {
  state.canonicalAccountReads.push({ operation: 'list' });
  return userId === config.defaultUserId ? accounts : [];
};
storage.getYouTubeAccounts = async () => [];
storage.listConnectedAccountReferencesForOwner = async (userId) =>
  userId === config.defaultUserId
    ? accounts.map((account) => ({ provider: 'tiktok', accountId: account.accountId, workspaceId: '' }))
    : [];
storage.getPosts = async (userId, accountId) => {
  if (state.getPostsError) throw state.getPostsError;
  if (userId !== config.defaultUserId) return [];
  return state.posts.filter((post) => !accountId || post.accountId === accountId);
};
storage.getPost = async (userId, id, accountId) => {
  if (userId !== config.defaultUserId) return null;
  const post = state.posts.find((item) => item.id === id) || null;
  if (!post) return null;
  if (accountId && post.accountId !== accountId) return null;
  return post;
};
storage.addUploadedPosts = async (userId, files, defaults) => {
  state.addUploadedPostsCalls.push({ userId, files, defaults });
  // Mirror the real chokepoint's video-only URL refusal (mediaPolicy-backed).
  const { isVideoMediaUrl } = require('../src/mediaPolicy');
  const url = String(defaults.publicMediaUrl || '').trim();
  if (url && !isVideoMediaUrl(url)) {
    const error = new Error('TikTok posting is video-only. The Public Media URL must point directly to an MP4, MOV, or WebM video file.');
    error.status = 400;
    throw error;
  }
  const target = defaults.accounts[0];
  const created = makePost({
    id: `created-${state.addUploadedPostsCalls.length}`,
    accountId: target.accountId,
    username: target.username,
    status: defaults.scheduledAt ? 'scheduled' : 'pending',
    scheduledAt: defaults.scheduledAt || null,
    caption: String(defaults.caption || ''),
    idempotencyKey: defaults.idempotencyKey || '',
    runtimeIdempotencyKey: defaults.runtimeIdempotencyKey || '',
    runtimeScheduledBy: defaults.runtimeScheduledBy || '',
    workspaceId: defaults.workspaceId || '',
    runtimeMissionId: defaults.runtimeMissionId || '',
    runtimeGraphId: defaults.runtimeGraphId || '',
    runtimeAction: defaults.runtimeAction || '',
    runtimePayloadHash: defaults.runtimePayloadHash || '',
    campaignId: defaults.campaignId || `campaign-${state.addUploadedPostsCalls.length}`,
    approvalId: defaults.approvalId || '',
    evidenceBundleId: defaults.evidenceBundleId || '',
    soundMode: defaults.soundMode || (defaults.accounts[0] && defaults.accounts[0].soundMode),
    provider: defaults.provider || 'tiktok'
  });
  state.posts.push(created);
  return [created];
};
storage.updatePost = async (userId, id, patch, accountId, historyEvent) => {
  state.updatePostCalls.push({ userId, id, patch, accountId, historyEvent });
  if (state.updatePostResult === 'throw') throw new Error('Firestore update failed');
  if (state.updatePostResult === 'null') return null;
  const scheduled = makePost({
    id,
    accountId,
    status: 'scheduled',
    scheduledAt: patch.scheduledAt,
    runtimeIdempotencyKey: patch.runtimeIdempotencyKey,
    runtimeScheduledBy: patch.runtimeScheduledBy
  });
  state.posts.push(scheduled);
  return scheduled;
};

// Trip-wire: none of these may ever be called from the runtime control surface.
const tiktok = require('../src/tiktok');
for (const key of Object.keys(tiktok)) {
  if (typeof tiktok[key] === 'function') {
    const name = key;
    tiktok[name] = async () => {
      state.tiktokTouched.push(name);
      throw new Error(`runtime control surface must never call tiktok.${name}`);
    };
  }
}

const { installCommercialFixture } = require('./helpers/commercial-fixture');
installCommercialFixture(require('../src/commercialService'), storage);
const runtimeControlRoutes = require('../src/runtimeControlRoutes');

function futureIso(minutesAhead = 90) {
  return new Date(Date.now() + minutesAhead * 60_000).toISOString();
}

test('runtime control routes: auth, scoping, media policy, idempotent scheduling', async (t) => {
  const app = express();
  app.use('/api/runtime', runtimeControlRoutes);
  // Mirror server.js's error middleware for /api/ JSON error truthfulness.
  app.use((error, req, res, next) => {
    if (!error) { next(); return; }
    res.status(error.status || 500).json({ ok: false, reason: error.message || 'Unexpected server error' });
  });

  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const call = (method, pathName, { token = TOKEN, body } = {}) =>
    fetch(`${baseUrl}${pathName}`, {
      method,
      headers: {
        ...(token === null ? {} : { 'x-chanter-runtime-token': token }),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        Accept: 'application/json'
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });

  // ── Fail closed: no token configured -> 503 for everything ──────────────
  const configuredToken = config.runtimeControl.token;
  config.runtimeControl.token = '';
  const disabled = await call('GET', '/api/runtime/queue');
  assert.equal(disabled.status, 503);
  assert.equal((await disabled.json()).ok, false);
  config.runtimeControl.token = configuredToken;

  // ── Unauthorized: missing or wrong token never reaches storage ──────────
  const before = state.addUploadedPostsCalls.length;
  for (const token of [null, 'wrong-token']) {
    const refused = await call('POST', '/api/runtime/schedule', {
      token,
      body: { accountId: 'account-a', mediaUrl: 'https://cdn.example.com/a.mp4', scheduledAt: futureIso(), idempotencyKey: 'k' }
    });
    assert.equal(refused.status, 401);
    const payload = await refused.json();
    assert.equal(payload.ok, false);
    assert.equal(payload.code, 'unauthorized');
  }
  assert.equal(state.addUploadedPostsCalls.length, before, 'unauthorized calls must not create posts');

  const refusedRegistry = await call('GET', '/api/runtime/connected-accounts', { token: null });
  assert.equal(refusedRegistry.status, 401, 'connected-account discovery is token-guarded');

  const legacyReadsBeforePreflight = state.legacyAccountReads.length;
  const registry = await call('GET', '/api/runtime/connected-accounts?provider=tiktok');
  assert.equal(registry.status, 200);
  const registryBody = await registry.json();
  assert.equal(registryBody.ok, true);
  assert.equal(registryBody.count, 2);
  assert.equal(registryBody.accounts[0].accountId, 'account-a');
  assert.equal(registryBody.accounts[0].connectedAccountId, 'tiktok:account-a');
  assert.deepEqual(Object.keys(registryBody.accounts[0]).sort(), [
    'accountId',
    'connectedAccountId',
    'connectionStatus',
    'displayName',
    'lastVerifiedAt',
    'provider',
    'providerDisplayName',
    'publishingReady',
    'readinessBlockers',
    'username'
  ]);
  const registryJson = JSON.stringify(registryBody);
  assert.equal(registryJson.includes('CANARY-RUNTIME-ACCOUNT-ACCESS-TOKEN'), false);
  assert.equal(registryJson.includes('CANARY-RUNTIME-ACCOUNT-REFRESH-TOKEN'), false);
  assert.equal(registryJson.includes('authorization'), false);
  assert.equal(registryJson.includes('tokenPresent'), false);

  const validAccount = await call('POST', '/api/runtime/connected-accounts/validate', {
    body: { provider: 'tiktok', accountId: 'account-a' }
  });
  assert.equal(validAccount.status, 200);
  const validAccountBody = await validAccount.json();
  assert.equal(validAccountBody.account.accountId, 'account-a');
  assert.equal(validAccountBody.account.publishingReady, true);
  assert.equal(JSON.stringify(validAccountBody).includes('CANARY-RUNTIME-ACCOUNT'), false);

  const wrongCase = await call('POST', '/api/runtime/connected-accounts/validate', {
    body: { provider: 'tiktok', accountId: 'ACCOUNT-A' }
  });
  assert.equal(wrongCase.status, 409);
  const wrongCaseBody = await wrongCase.json();
  assert.equal(wrongCaseBody.code, 'account_id_case_mismatch');
  assert.equal(wrongCaseBody.canonicalAccountId, 'account-a');
  assert.equal(
    state.legacyAccountReads.length,
    legacyReadsBeforePreflight,
    'Runtime account discovery and exact preflight never enter legacy read/migration getters'
  );
  assert.deepEqual(state.canonicalAccountReads, [
    { operation: 'list' },
    { operation: 'get', accountId: 'account-a' },
    { operation: 'get', accountId: 'ACCOUNT-A' }
  ]);

  // ── Queue list: authorized scope, bounded, truthful empty, failure ──────
  const list = await call('GET', '/api/runtime/queue?accountId=account-a&limit=10');
  assert.equal(list.status, 200);
  const listBody = await list.json();
  assert.equal(listBody.ok, true);
  assert.equal(listBody.count, 1);
  assert.equal(listBody.scope.accountId, 'account-a');
  assert.equal(listBody.items[0].id, 'post-1');
  assert.equal(listBody.items[0].approved, false);
  assert.equal(listBody.items[0].mediaUrl, undefined, 'raw media URLs are not exposed');
  assert.equal(listBody.items[0].provider, 'tiktok', 'queue items expose canonical provider identity');
  assert.equal(typeof listBody.items[0].connectedAccountId, 'string', 'connected-account identity is safe metadata');

  const unknownScope = await call('GET', '/api/runtime/queue?accountId=account-nope');
  assert.equal(unknownScope.status, 404);
  assert.equal((await unknownScope.json()).code, 'not_found');

  const badLimit = await call('GET', '/api/runtime/queue?limit=0');
  assert.equal(badLimit.status, 400);

  const savedPosts = state.posts;
  state.posts = [];
  const empty = await call('GET', '/api/runtime/queue');
  const emptyBody = await empty.json();
  assert.equal(empty.status, 200);
  assert.equal(emptyBody.ok, true);
  assert.equal(emptyBody.count, 0);
  assert.deepEqual(emptyBody.items, []);
  state.posts = savedPosts;

  state.getPostsError = new Error('Firestore unavailable');
  const failedList = await call('GET', '/api/runtime/queue');
  assert.equal(failedList.status, 500);
  assert.equal((await failedList.json()).ok, false, 'downstream failure is never an empty success');
  state.getPostsError = null;

  // ── Post status: found, missing, and account-scope isolation ────────────
  const status = await call('GET', '/api/runtime/posts/post-1/status');
  const statusBody = await status.json();
  assert.equal(status.status, 200);
  assert.equal(statusBody.post.status, 'scheduled');
  assert.equal(statusBody.post.approved, false);
  assert.equal(statusBody.post.lastErrorMessage, '');

  const missing = await call('GET', '/api/runtime/posts/nope/status');
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).code, 'not_found');

  const wrongScope = await call('GET', '/api/runtime/posts/post-1/status?accountId=account-cold');
  assert.equal(wrongScope.status, 404, 'a post outside the account scope is not found (existing convention)');

  // ── Media validation: reuses mediaPolicy verbatim ────────────────────────
  const mediaCases = [
    [{ fileName: 'clip.mp4', mimeType: 'video/mp4' }, { valid: true, classification: 'video' }],
    [{ fileName: 'photo.jpg', mimeType: 'image/jpeg' }, { valid: false, rejectionCode: 'image_mime' }],
    [{ fileName: 'photo.png', mimeType: 'application/octet-stream' }, { valid: false, rejectionCode: 'image_extension' }],
    [{ fileName: 'clip.png', mimeType: 'video/mp4' }, { valid: false, rejectionCode: 'mime_extension_mismatch' }],
    [{ mediaUrl: 'https://cdn.example.com/clip.mov' }, { valid: true, classification: 'video' }],
    [{ mediaUrl: 'https://cdn.example.com/media' }, { valid: false, rejectionCode: 'unsupported_url' }],
    [{ mediaUrl: 'http://cdn.example.com/clip.mp4' }, { valid: false, rejectionCode: 'not_https_url' }],
    [{ mediaUrl: 'https://cdn.example.com/photo.jpg' }, { valid: false, rejectionCode: 'unsupported_url' }]
  ];
  for (const [body, expected] of mediaCases) {
    const response = await call('POST', '/api/runtime/media/validate', { body });
    assert.equal(response.status, 200, JSON.stringify(body));
    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.valid, expected.valid, JSON.stringify(body));
    if (expected.classification) assert.equal(payload.classification, expected.classification);
    if (expected.rejectionCode) assert.equal(payload.rejectionCode, expected.rejectionCode, JSON.stringify(body));
    assert.equal(payload.policy.videoOnly, true);
  }
  const noInput = await call('POST', '/api/runtime/media/validate', { body: {} });
  assert.equal(noInput.status, 400);

  // ── Scheduling: one queue item, unapproved, truthful metadata ────────────
  const scheduledAt = futureIso();
  const legacyReadsBeforeSchedule = state.legacyAccountReads.length;
  const canonicalReadsBeforeSchedule = state.canonicalAccountReads.length;
  const schedule = await call('POST', '/api/runtime/schedule', {
    body: {
      accountId: 'account-a',
      mediaUrl: 'https://cdn.example.com/new.mp4',
      caption: 'Launch teaser',
      scheduledAt,
      idempotencyKey: 'idem-100',
      missionId: 'mission-100',
      graphId: 'graph-100',
      action: 'autoposter.post.schedule',
      missionPayloadHash: 'a'.repeat(64),
      soundMode: 'tiktok_recommended',
      requestedBy: 'mcp-client'
    }
  });
  assert.equal(schedule.status, 201);
  const scheduleBody = await schedule.json();
  assert.equal(scheduleBody.ok, true);
  assert.equal(scheduleBody.duplicate, false);
  assert.equal(scheduleBody.post.status, 'scheduled');
  assert.equal(scheduleBody.post.provider, 'tiktok', 'runtime-created items carry canonical provider identity');
  assert.equal(scheduleBody.post.approved, false, 'runtime scheduling never grants approval');
  assert.equal(scheduleBody.post.scheduledAt, new Date(scheduledAt).toISOString());
  assert.match(scheduleBody.post.campaignId, /^campaign-/);
  assert.equal(scheduleBody.post.approvalId, 'autoposter-approval:mission-100');
  assert.equal(scheduleBody.post.evidenceBundleId, 'autoposter-evidence:graph-100');
  assert.equal(state.addUploadedPostsCalls.length, 1, 'exactly one queue item created');
  assert.equal(state.updatePostCalls.length, 0, 'explicit schedule is persisted in the initial create-only write');
  assert.equal(state.addUploadedPostsCalls[0].defaults.runtimeIdempotencyKey, 'idem-100');
  assert.equal(state.addUploadedPostsCalls[0].defaults.scheduledAt, new Date(scheduledAt).toISOString());
  assert.equal(state.addUploadedPostsCalls[0].defaults.createOnly, true);
  assert.equal(state.addUploadedPostsCalls[0].defaults.soundMode, 'tiktok_recommended');
  assert.equal(state.addUploadedPostsCalls[0].defaults.approvalId, 'autoposter-approval:mission-100');
  assert.equal(state.addUploadedPostsCalls[0].defaults.evidenceBundleId, 'autoposter-evidence:graph-100');
  assert.match(state.addUploadedPostsCalls[0].defaults.scheduleHistory.detail, /awaits human approval/);
  assert.equal(
    state.legacyAccountReads.length,
    legacyReadsBeforeSchedule,
    'Runtime scheduling never enters legacy read/migration getters'
  );
  assert.equal(
    state.canonicalAccountReads.length,
    canonicalReadsBeforeSchedule + 1,
    'Runtime scheduling revalidates the canonical account immediately before creation'
  );

  // ── Idempotency: the same key returns the existing item, creates nothing ─
  const duplicate = await call('POST', '/api/runtime/schedule', {
    body: {
      accountId: 'account-a',
      mediaUrl: 'https://cdn.example.com/new.mp4',
      caption: 'Launch teaser',
      scheduledAt,
      idempotencyKey: 'idem-100',
      missionId: 'mission-100',
      graphId: 'graph-100',
      action: 'autoposter.post.schedule',
      missionPayloadHash: 'a'.repeat(64)
    }
  });
  assert.equal(duplicate.status, 200);
  const duplicateBody = await duplicate.json();
  assert.equal(duplicateBody.ok, true);
  assert.equal(duplicateBody.duplicate, true);
  assert.equal(duplicateBody.post.id, scheduleBody.post.id);
  assert.equal(duplicateBody.post.approvalId, scheduleBody.post.approvalId);
  assert.equal(duplicateBody.post.evidenceBundleId, scheduleBody.post.evidenceBundleId);
  assert.equal(state.addUploadedPostsCalls.length, 1, 'no second queue item for a duplicate key');

  const reconciliationBody = {
    workspaceId: defaultWorkspaceId('owner'),
    accountId: 'account-a',
    provider: 'tiktok',
    scheduledAt,
    idempotencyKey: 'idem-100',
    missionId: 'mission-100',
    action: 'autoposter.post.schedule',
    missionPayloadHash: 'a'.repeat(64)
  };
  const reconciled = await call('POST', '/api/runtime/schedule/reconcile', {
    body: reconciliationBody
  });
  assert.equal(reconciled.status, 200);
  const reconciledBody = await reconciled.json();
  assert.equal(reconciledBody.ok, true);
  assert.equal(reconciledBody.outcome, 'unique');
  assert.equal(reconciledBody.safeToReuse, true);
  assert.equal(reconciledBody.post.id, scheduleBody.post.id);
  assert.equal(reconciledBody.post.campaignId, scheduleBody.post.campaignId);
  assert.equal(reconciledBody.post.approvalId, scheduleBody.post.approvalId);
  assert.equal(reconciledBody.post.evidenceBundleId, scheduleBody.post.evidenceBundleId);
  assert.equal(reconciledBody.approvalState, 'required');
  assert.equal(reconciledBody.publishingState, 'blocked_until_human_approval');
  assert.equal(state.addUploadedPostsCalls.length, 1, 'read-only reconciliation creates nothing');

  const reconciliationMutations = [
    ['action', { action: 'autoposter.queue.list' }, 'scope_mismatch'],
    ['workspace', { workspaceId: ` ${reconciliationBody.workspaceId}` }, 'scope_mismatch'],
    ['provider', { provider: 'TikTok' }, 'scope_mismatch'],
    ['account-value', { accountId: 'other-account' }, 'scope_mismatch'],
    ['account-case', { accountId: 'Account-A' }, 'scope_mismatch'],
    ['account-whitespace', { accountId: ' account-a' }, 'scope_mismatch'],
    ['payload', { missionPayloadHash: 'b'.repeat(64) }, 'payload_mismatch'],
    ['idempotency-key', { idempotencyKey: 'idem-101' }, 'idempotency_mismatch'],
    ['schedule', { scheduledAt: scheduledAt.replace('Z', '+00:00') }, 'scope_mismatch']
  ];
  for (const [label, mutation, expectedOutcome] of reconciliationMutations) {
    const mismatched = await call('POST', '/api/runtime/schedule/reconcile', {
      body: { ...reconciliationBody, ...mutation }
    });
    assert.equal(mismatched.status, 200, label);
    const mismatchedBody = await mismatched.json();
    assert.equal(mismatchedBody.ok, true, label);
    assert.equal(mismatchedBody.outcome, expectedOutcome, label);
    assert.equal(mismatchedBody.safeToReuse, false, label);
    assert.equal(mismatchedBody.post, undefined, label);
  }
  const absent = await call('POST', '/api/runtime/schedule/reconcile', {
    body: { ...reconciliationBody, missionId: 'mission-not-created' }
  });
  assert.equal(absent.status, 200);
  const absentBody = await absent.json();
  assert.equal(absentBody.outcome, 'not_found');
  assert.equal(absentBody.post, undefined);
  assert.equal(state.addUploadedPostsCalls.length, 1);

  // ── Scheduling refusals: timestamps, scope, connectivity, media, key ─────
  const refusals = [
    [{ accountId: 'account-a', mediaUrl: 'https://cdn.example.com/a.mp4', scheduledAt: 'not-a-date', idempotencyKey: 'k1' }, 400],
    [{ accountId: 'account-a', mediaUrl: 'https://cdn.example.com/a.mp4', scheduledAt: '2026-07-11T09:00:00', idempotencyKey: 'k2' }, 400],
    [{ accountId: 'account-a', mediaUrl: 'https://cdn.example.com/a.mp4', scheduledAt: '2020-01-01T00:00:00Z', idempotencyKey: 'k3' }, 400],
    [{ accountId: 'account-a', mediaUrl: 'https://cdn.example.com/a.mp4', scheduledAt: futureIso(), idempotencyKey: '' }, 400],
    [{ accountId: 'account-nope', mediaUrl: 'https://cdn.example.com/a.mp4', scheduledAt: futureIso(), idempotencyKey: 'k4' }, 404],
    [{ accountId: 'account-cold', mediaUrl: 'https://cdn.example.com/a.mp4', scheduledAt: futureIso(), idempotencyKey: 'k5' }, 409],
    [{ accountId: 'account-a', mediaUrl: 'https://cdn.example.com/photo.jpg', scheduledAt: futureIso(), idempotencyKey: 'k6' }, 400]
  ];
  const createsBefore = state.addUploadedPostsCalls.length;
  for (const [body, expectedStatus] of refusals) {
    const refused = await call('POST', '/api/runtime/schedule', { body });
    assert.equal(refused.status, expectedStatus, JSON.stringify(body));
    assert.equal((await refused.json()).ok, false);
  }
  // Shared application validation refuses every bad request before creation;
  // storage still retains its defense-in-depth policy for direct callers.
  assert.equal(state.addUploadedPostsCalls.length - createsBefore, 0);
  assert.equal(state.updatePostCalls.length, 0, 'no refused request applied a schedule');

  // Signed staged upload: the first call uses a disposable copy; exact replay
  // succeeds from the durable product record after staging has been released.
  const staging = createCanonicalStagedMedia({
    rootDir: config.canonicalExecution.stagedMediaDir,
    secret: config.canonicalExecution.mediaReferenceSecret
  });
  const stagedCommandId = `platform-autoposter-${'c'.repeat(40)}`;
  const stagedSourceDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'runtime-stage-route-'));
  t.after(() => fs.rmSync(stagedSourceDir, { recursive: true, force: true }));
  const stagedSourcePath = path.join(stagedSourceDir, 'canonical.mp4');
  fs.writeFileSync(stagedSourcePath, 'canonical-staged-video');
  const staged = await staging.stage(stagedCommandId, {
    path: stagedSourcePath,
    filename: 'canonical.mp4',
    originalname: 'canonical.mp4',
    mimetype: 'video/mp4',
    size: fs.statSync(stagedSourcePath).size
  });
  const stagedScheduleBody = {
    workspaceId: defaultWorkspaceId('owner'),
    accountId: 'account-a',
    provider: 'tiktok',
    mediaUrl: staged.reference,
    caption: 'Canonical staged pilot',
    soundMode: 'tiktok_recommended',
    scheduledAt: futureIso(150),
    idempotencyKey: 'canonical-staged-idem-1',
    missionId: 'canonical-staged-mission-1',
    graphId: 'canonical-staged-graph-1',
    action: 'autoposter.post.schedule',
    missionPayloadHash: 'd'.repeat(64)
  };
  const createsBeforeStaged = state.addUploadedPostsCalls.length;
  const stagedFirst = await call('POST', '/api/runtime/schedule', { body: stagedScheduleBody });
  assert.equal(stagedFirst.status, 201);
  const stagedFirstBody = await stagedFirst.json();
  assert.equal(stagedFirstBody.post.approvalId, 'autoposter-approval:canonical-staged-mission-1');
  assert.equal(stagedFirstBody.post.evidenceBundleId, 'autoposter-evidence:canonical-staged-graph-1');
  assert.equal(state.addUploadedPostsCalls.length, createsBeforeStaged + 1);
  assert.equal(
    fs.existsSync(path.join(config.canonicalExecution.stagedMediaDir, stagedCommandId)),
    false,
    'durable product custody releases terminal staging'
  );

  const stagedReplay = await call('POST', '/api/runtime/schedule', { body: stagedScheduleBody });
  assert.equal(stagedReplay.status, 200);
  const stagedReplayBody = await stagedReplay.json();
  assert.equal(stagedReplayBody.duplicate, true);
  assert.equal(stagedReplayBody.post.id, stagedFirstBody.post.id);
  assert.equal(state.addUploadedPostsCalls.length, createsBeforeStaged + 1, 'staged replay creates no job');

  const stagedPost = state.posts.find((post) => post.id === stagedFirstBody.post.id);
  const exactLinkage = {
    campaignId: stagedPost.campaignId,
    approvalId: stagedPost.approvalId,
    evidenceBundleId: stagedPost.evidenceBundleId
  };
  const invalidLinkage = {
    campaignId: ` ${exactLinkage.campaignId}`,
    approvalId: `${exactLinkage.approvalId}\n`,
    evidenceBundleId: 'e'.repeat(257)
  };
  const exactReconcileBody = {
    workspaceId: stagedScheduleBody.workspaceId,
    accountId: stagedScheduleBody.accountId,
    provider: stagedScheduleBody.provider,
    scheduledAt: stagedScheduleBody.scheduledAt,
    idempotencyKey: stagedScheduleBody.idempotencyKey,
    missionId: stagedScheduleBody.missionId,
    action: stagedScheduleBody.action,
    missionPayloadHash: stagedScheduleBody.missionPayloadHash
  };
  for (const [field, invalidValue] of Object.entries(invalidLinkage)) {
    stagedPost[field] = invalidValue;
    const corruptReconcile = await call('POST', '/api/runtime/schedule/reconcile', {
      body: exactReconcileBody
    });
    assert.equal(corruptReconcile.status, 500, `${field} reconcile`);
    assert.equal((await corruptReconcile.json()).code, 'runtime_linkage_invalid', field);

    const corruptReplay = await call('POST', '/api/runtime/schedule', { body: stagedScheduleBody });
    assert.equal(corruptReplay.status, 500, `${field} schedule replay`);
    assert.equal((await corruptReplay.json()).code, 'runtime_linkage_invalid', field);
    stagedPost[field] = exactLinkage[field];
  }

  const failedStageCommandId = `platform-autoposter-${'f'.repeat(40)}`;
  const failedStage = await staging.stage(failedStageCommandId, {
    path: stagedSourcePath,
    filename: 'canonical.mp4',
    originalname: 'canonical.mp4',
    mimetype: 'video/mp4',
    size: fs.statSync(stagedSourcePath).size
  });
  const failedCreate = await call('POST', '/api/runtime/schedule', {
    body: {
      ...stagedScheduleBody,
      accountId: 'account-nope',
      mediaUrl: failedStage.reference,
      idempotencyKey: 'canonical-staged-failed-idem',
      missionId: 'canonical-staged-failed-mission',
      graphId: 'canonical-staged-failed-graph'
    }
  });
  assert.equal(failedCreate.status, 404);
  assert.equal(
    fs.existsSync(path.join(config.canonicalExecution.stagedMediaDir, failedStageCommandId)),
    true,
    'failed product creation retains stable bytes for recovery'
  );
  await staging.release(failedStage.reference);

  // ── No publishing: TikTok module was never touched ───────────────────────
  assert.deepEqual(state.tiktokTouched, [], 'runtime control surface must never call TikTok code');
});

test('runtime control routes: no responses ever contain the service token', async () => {
  // Static guarantee alongside the behavioral ones above: the module never
  // interpolates the token into a response and never requires publish code.
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'runtimeControlRoutes.js'), 'utf8');
  for (const forbidden of ['tiktok', 'instagram', 'scheduler', 'cloudinary']) {
    assert.equal(source.includes(`require('./${forbidden}')`), false, `must not require ${forbidden}`);
  }
  assert.equal(/\bfetch\s*\(/.test(source), false, 'must not call fetch()');
});

test('runtime routes propagate verified workspace context and preserve structured commercial denial', async (t) => {
  const createsBeforeCommercialDenial = state.addUploadedPostsCalls.length;
  const originals = {
    listQueue: applicationService.listQueue,
    getPostStatus: applicationService.getPostStatus,
    schedulePost: applicationService.schedulePost
  };
  t.after(() => Object.assign(applicationService, originals));

  const calls = [];
  applicationService.listQueue = async (context) => {
    calls.push({ operation: 'list', context });
    if (context.workspaceId === 'workspace-b-00000001') {
      throw new applicationService.AutoPosterApplicationError(
        'Workspace not found.',
        { status: 404, code: 'not_found' }
      );
    }
    return {
      items: [],
      totalInScope: 0,
      scope: { workspaceId: context.workspaceId, accountId: 'all' }
    };
  };
  applicationService.getPostStatus = async (context) => {
    calls.push({ operation: 'status', context });
    throw new applicationService.AutoPosterApplicationError(
      'Post not found for this tenant/account scope.',
      { status: 404, code: 'not_found' }
    );
  };
  applicationService.schedulePost = async (context, input) => {
    calls.push({ operation: 'schedule', context, input });
    throw new applicationService.AutoPosterApplicationError(
      'Runtime scheduling is not available on Starter.',
      {
        status: 403,
        code: 'runtime_scheduling_not_allowed',
        details: {
          reasonCode: 'runtime_scheduling_not_allowed',
          current: 0,
          limit: 0,
          remaining: 0,
          planId: 'starter',
          workspaceId: context.workspaceId
        }
      }
    );
  };

  const app = express();
  app.use('/api/runtime', runtimeControlRoutes);
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const headers = { 'x-chanter-runtime-token': TOKEN, Accept: 'application/json' };

  const deniedWorkspace = await fetch(
    `${baseUrl}/api/runtime/queue?workspaceId=workspace-b-00000001`,
    { headers }
  );
  assert.equal(deniedWorkspace.status, 404);
  assert.equal((await deniedWorkspace.json()).code, 'not_found');

  const status = await fetch(
    `${baseUrl}/api/runtime/posts/post-b/status?workspaceId=workspace-a-00000001`,
    { headers }
  );
  assert.equal(status.status, 404);

  const schedule = await fetch(`${baseUrl}/api/runtime/schedule`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workspaceId: 'workspace-a-00000001',
      accountId: 'account-a',
      mediaUrl: 'https://cdn.example.com/runtime.mp4',
      scheduledAt: futureIso(),
      idempotencyKey: 'workspace-denial-1',
      planId: 'studio',
      entitlementOverrides: { runtimeScheduling: true },
      scheduledPostsPerCycle: 999999
    })
  });
  assert.equal(schedule.status, 403);
  assert.deepEqual(await schedule.json(), {
    ok: false,
    code: 'runtime_scheduling_not_allowed',
    reason: 'Runtime scheduling is not available on Starter.',
    reasonCode: 'runtime_scheduling_not_allowed',
    current: 0,
    limit: 0,
    remaining: 0,
    planId: 'starter',
    workspaceId: 'workspace-a-00000001'
  });

  const scheduleCall = calls.find((call) => call.operation === 'schedule');
  assert.equal(scheduleCall.context.workspaceId, 'workspace-a-00000001');
  assert.equal('planId' in scheduleCall.input, false);
  assert.equal('entitlementOverrides' in scheduleCall.input, false);
  assert.equal('scheduledPostsPerCycle' in scheduleCall.input, false);
  assert.equal(
    state.addUploadedPostsCalls.length,
    createsBeforeCommercialDenial,
    'structured denial creates no additional queue item'
  );
});

test('runtime post status exposes the bounded Phase 2E-B lifecycle contract truthfully', async (t) => {
  const app = express();
  app.use('/api/runtime', runtimeControlRoutes);
  app.use((error, req, res, next) => {
    if (!error) { next(); return; }
    res.status(error.status || 500).json({ ok: false, reason: error.message || 'Unexpected server error' });
  });
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const headers = { 'x-chanter-runtime-token': TOKEN, Accept: 'application/json' };

  const savedPosts = state.posts;
  t.after(() => { state.posts = savedPosts; });

  const statusOf = async (postId) => {
    const response = await fetch(`${baseUrl}/api/runtime/posts/${postId}/status`, { headers });
    assert.equal(response.status, 200, postId);
    const body = await response.json();
    assert.equal(body.ok, true, postId);
    return body.post;
  };

  const EXPECTED_STATUS_KEYS = [
    'accountId', 'approvalState', 'approved', 'approvedAt', 'approvedBy', 'attemptBudgetExhausted',
    'captionSummary', 'claimAttempts', 'connectedAccountId', 'createdAt',
    'history', 'id', 'lastErrorMessage', 'lastResult', 'lockedAt',
    'mediaType', 'postedAt', 'provider', 'providerOperation', 'providerStatus',
    'providerVerification', 'publishAttemptBudget', 'publishId', 'runtimeAction', 'runtimeIdempotencyKey', 'runtimeMissionId',
    'runtimePayloadHash', 'scheduledAt', 'status', 'updatedAt', 'username',
    'workspaceId'
  ];

  // ── Scheduled unapproved draft (exact Phase 2E-A success state) ─────────
  state.posts = [makePost({
    id: 'draft-1',
    runtimeMissionId: 'graph:g-1:node:n-1',
    runtimeIdempotencyKey: 'graph:g-1:node:n-1',
    runtimeAction: 'autoposter.post.schedule',
    runtimePayloadHash: 'c'.repeat(64),
    history: [{ at: '2026-07-10T08:00:00.000Z', event: 'runtime_scheduled', detail: 'Draft created; awaits human approval.' }]
  })];
  const draft = await statusOf('draft-1');
  assert.deepEqual(Object.keys(draft).sort(), EXPECTED_STATUS_KEYS);
  assert.equal(draft.status, 'scheduled');
  assert.equal(draft.approved, false);
  assert.equal(draft.approvalState, 'unapproved');
  assert.equal(draft.workspaceId, 'workspace-owner');
  assert.equal(draft.runtimeMissionId, 'graph:g-1:node:n-1');
  assert.equal(draft.runtimeIdempotencyKey, 'graph:g-1:node:n-1');
  assert.equal(draft.runtimeAction, 'autoposter.post.schedule');
  assert.equal(draft.runtimePayloadHash, 'c'.repeat(64));
  assert.equal(draft.lockedAt, null);
  assert.equal(draft.lastResult, null);
  assert.equal(draft.providerOperation, null, 'legacy and pre-provider rows stay backward compatible');
  assert.deepEqual(draft.history, [{
    at: '2026-07-10T08:00:00.000Z',
    event: 'runtime_scheduled',
    detail: 'Draft created; awaits human approval.'
  }]);

  // ── Approved for publishing (human approval, not yet claimed) ───────────
  state.posts = [makePost({
    id: 'approved-1',
    approvedAt: '2026-07-10T10:00:00.000Z',
    approvedBy: 'founder@chanter',
    approved: true,
    approvalState: 'approved'
  })];
  const approved = await statusOf('approved-1');
  assert.equal(approved.approvalState, 'approved');
  assert.equal(approved.approved, true);
  assert.equal(approved.approvedBy, 'founder@chanter');
  assert.equal(approved.status, 'scheduled');
  assert.equal(approved.lastResult, null);

  // ── Processing (claimed by scheduler; lock time visible, worker not) ────
  state.posts = [makePost({
    id: 'processing-1',
    status: 'processing',
    approved: true,
    approvalState: 'approved',
    approvedAt: '2026-07-10T10:00:00.000Z',
    lockedAt: '2026-07-11T09:00:05.000Z',
    lockedBy: 'worker-CANARY-LOCKED-BY',
    claimAttempts: 1
  })];
  const processing = await statusOf('processing-1');
  assert.equal(processing.status, 'processing');
  assert.equal(processing.lockedAt, '2026-07-11T09:00:05.000Z');
  assert.equal(processing.claimAttempts, 1);
  assert.equal('lockedBy' in processing, false, 'worker lock identity is never exposed');

  // ── Retry scheduled (transient failure; AutoPoster owns the retry) ──────
  state.posts = [makePost({
    id: 'retry-1',
    status: 'scheduled',
    approved: true,
    approvalState: 'approved',
    approvedAt: '2026-07-10T10:00:00.000Z',
    claimAttempts: 2,
    lastResult: {
      ok: false, code: 'PROVIDER_5XX', reason: 'TikTok returned HTTP 502.',
      willRetry: true, attempts: 2
    },
    history: [{ at: '2026-07-11T09:01:00.000Z', event: 'retry_scheduled', detail: 'Retrying in 5 minutes.' }]
  })];
  const retry = await statusOf('retry-1');
  assert.equal(retry.status, 'scheduled');
  assert.equal(retry.lastResult.willRetry, true);
  assert.equal(retry.lastResult.code, 'PROVIDER_5XX');
  assert.equal(retry.lastResult.message, 'TikTok returned HTTP 502.');
  assert.equal(retry.history[retry.history.length - 1].event, 'retry_scheduled');
  assert.equal('attempts' in retry.lastResult, false, 'wire lastResult carries only the exact bounded subset');
  assert.equal('ok' in retry.lastResult, false);

  // ── YouTube uploaded private (terminal upload, explicitly not public) ───
  state.posts = [makePost({
    id: 'youtube-1',
    provider: 'youtube',
    connectedAccountId: 'youtube:channel-a',
    accountId: 'channel-a',
    status: 'posted',
    approved: true,
    approvalState: 'approved',
    approvedAt: '2026-07-10T10:00:00.000Z',
    postedAt: '2026-07-11T09:02:00.000Z',
    publishId: 'yt-video-123',
    providerStatus: 'uploaded_private',
    providerMetadata: { youtube: { title: 'Launch', description: '', privacyStatus: 'private', notifySubscribers: false } },
    lastResult: { ok: true, published: true, completedAt: '2026-07-11T09:02:00.000Z' }
  })];
  const youtube = await statusOf('youtube-1');
  assert.equal(youtube.provider, 'youtube');
  assert.equal(youtube.status, 'posted');
  assert.equal(youtube.providerStatus, 'uploaded_private');
  assert.equal(youtube.publishId, 'yt-video-123');
  assert.equal('providerMetadata' in youtube, false, 'legacy provider metadata is not part of the strict Runtime wire contract');
  assert.equal(youtube.lastResult.completedAt, '2026-07-11T09:02:00.000Z');

  // ── TikTok provider accepted (API acceptance, visibility unverified) ────
  state.posts = [makePost({
    id: 'tiktok-1',
    status: 'posted',
    approved: true,
    approvalState: 'approved',
    approvedAt: '2026-07-10T10:00:00.000Z',
    postedAt: '2026-07-11T09:03:00.000Z',
    publishId: 'tt-publish-9',
    lastResult: { ok: true, mode: 'api', completedAt: '2026-07-11T09:03:00.000Z' }
  })];
  const tiktok = await statusOf('tiktok-1');
  assert.equal(tiktok.provider, 'tiktok');
  assert.equal(tiktok.status, 'posted');
  assert.equal(tiktok.publishId, 'tt-publish-9');
  assert.equal(tiktok.lastResult.mode, 'api');
  assert.equal(tiktok.providerStatus, '', 'no invented provider visibility state');

  // ── Manually reconciled (human assertion, not provider verification) ────
  state.posts = [makePost({
    id: 'manual-1',
    status: 'posted',
    approved: true,
    approvalState: 'approved',
    approvedAt: '2026-07-10T10:00:00.000Z',
    postedAt: '2026-07-11T09:04:00.000Z',
    lastResult: { ok: true, mode: 'manual', reason: 'Marked posted manually', completedAt: '2026-07-11T09:04:00.000Z' },
    history: [{ at: '2026-07-11T09:04:00.000Z', event: 'marked_posted', detail: 'Marked posted manually by the operator.' }]
  })];
  const manual = await statusOf('manual-1');
  assert.equal(manual.status, 'posted');
  assert.equal(manual.lastResult.mode, 'manual');
  assert.equal(manual.history[manual.history.length - 1].event, 'marked_posted');
  assert.equal(manual.publishId, '', 'a manual assertion has no provider publish identity');

  // ── Definitive failure ───────────────────────────────────────────────────
  state.posts = [makePost({
    id: 'failed-1',
    status: 'failed',
    approved: true,
    approvalState: 'approved',
    approvedAt: '2026-07-10T10:00:00.000Z',
    claimAttempts: 3,
    lastResult: { ok: false, code: 'PROVIDER_AUTH', reason: 'Reauthorize the TikTok account.', definitiveFailure: true },
    history: [{ at: '2026-07-11T09:05:00.000Z', event: 'failed', detail: 'Reauthorize the TikTok account.' }]
  })];
  const failed = await statusOf('failed-1');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.lastResult.code, 'PROVIDER_AUTH');
  assert.equal(failed.lastErrorMessage, 'Reauthorize the TikTok account.');

  // ── Outcome unknown (terminal for automation; highest human priority) ───
  state.posts = [makePost({
    id: 'unknown-1',
    status: 'outcome_unknown',
    approved: true,
    approvalState: 'approved',
    approvedAt: '2026-07-10T10:00:00.000Z',
    providerStatus: 'provider_reconciliation_required',
    lastResult: { ok: false, outcomeUnknown: true, code: 'PROVIDER_RECONCILIATION_REQUIRED', reason: 'Upload session ended without a definitive result.' },
    history: [{ at: '2026-07-11T09:06:00.000Z', event: 'outcome_unknown', detail: 'Upload session ended without a definitive result.' }]
  })];
  const unknown = await statusOf('unknown-1');
  assert.equal(unknown.status, 'outcome_unknown');
  assert.equal(unknown.providerStatus, 'provider_reconciliation_required');
  assert.equal(unknown.lastResult.outcomeUnknown, true);

  // ── Legacy publishing status normalizes; legacy record has empty fields ──
  state.posts = [makePost({
    id: 'legacy-1',
    status: 'publishing',
    workspaceId: '',
    runtimeMissionId: '',
    runtimeIdempotencyKey: '',
    runtimeAction: '',
    runtimePayloadHash: '',
    history: undefined,
    lastResult: undefined
  })];
  const legacy = await statusOf('legacy-1');
  assert.equal(legacy.status, 'processing', 'legacy publishing status normalizes to processing');
  assert.equal(legacy.workspaceId, '');
  assert.equal(legacy.runtimeMissionId, '');
  assert.equal(legacy.lastResult, null);
  assert.deepEqual(legacy.history, []);

  // ── Redaction and size bounds on malformed/hostile stored evidence ──────
  const hostileHistory = Array.from({ length: 30 }, (_, index) => ({
    at: `2026-07-11T08:${String(index).padStart(2, '0')}:00.000Z`,
    event: `event_${index}`,
    detail: index === 29
      ? 'access_token: CANARY-STATUS-ACCESS-TOKEN and Bearer abcdefghijklmnop.qrstuvwxyz012345.ABCDEFGHIJKLMNOP'
      : `detail ${index} ${'x'.repeat(400)}`
  }));
  state.posts = [makePost({
    id: 'hostile-1',
    status: 'failed',
    lastResult: {
      ok: false,
      reason: 'refresh_token: CANARY-STATUS-REFRESH-TOKEN caused the failure.',
      code: 'X'.repeat(500),
      access_token: 'CANARY-STATUS-RAW-TOKEN',
      response: { publish_id: 'p-1', access_token: 'CANARY-STATUS-RESPONSE-TOKEN' }
    },
    history: hostileHistory
  })];
  const hostile = await statusOf('hostile-1');
  assert.equal(hostile.history.length, 20, 'wire history is capped');
  assert.equal(hostile.history[19].event, 'event_29', 'the newest entries are kept');
  assert.ok(hostile.history[19].detail.includes('access_token=[redacted]'));
  assert.ok(hostile.history[0].detail.length <= 300, 'history details stay bounded');
  assert.ok(hostile.lastResult.message.includes('refresh_token=[redacted]'));
  assert.ok(hostile.lastResult.code.length <= 120, 'lastResult code stays bounded');
  assert.equal('response' in hostile.lastResult, false, 'raw provider response objects never reach the wire');
  const hostileJson = JSON.stringify(hostile);
  for (const canary of [
    'CANARY-STATUS-ACCESS-TOKEN',
    'CANARY-STATUS-REFRESH-TOKEN',
    'CANARY-STATUS-RAW-TOKEN',
    'CANARY-STATUS-RESPONSE-TOKEN',
    'worker-CANARY-LOCKED-BY'
  ]) {
    assert.equal(hostileJson.includes(canary), false, `${canary} must never appear in a status response`);
  }
  assert.equal('mediaUrl' in hostile, false, 'raw media URLs are not exposed');
  assert.equal('caption' in hostile, false, 'full captions are not exposed');
});

test('runtime provider reconciliation invokes one exact application operation and returns only the safe projection', async (t) => {
  const original = applicationService.reconcileProviderOperation;
  const calls = [];
  const base = makePost({
    id: 'youtube-operation-1',
    provider: 'youtube',
    accountId: 'UC-exact',
    connectedAccountId: 'youtube:UC-exact',
    userId: 'owner',
    workspaceId: 'workspace-a',
    runtimeMissionId: 'graph:g:node:n',
    runtimeGraphId: 'graph:g',
    runtimeAction: 'autoposter.post.schedule',
    runtimePayloadHash: 'a'.repeat(64),
    approvedBy: 'founder',
    approvedAt: '2026-07-19T11:59:00.000Z'
  });
  const rawOperation = createInitialYouTubeProviderOperation({ queueId: base.id, post: base, attemptNumber: 1 });
  rawOperation.sessionLocatorEnvelope = {
    v: 1, alg: 'aes-256-gcm', iv: 'CANARY-IV', ct: 'CANARY-CIPHERTEXT', tag: 'CANARY-TAG'
  };
  const safeOperation = sanitizeProviderOperation(rawOperation);
  applicationService.reconcileProviderOperation = async (context, input) => {
    calls.push({ context, input });
    return {
      classification: 'outcome_unknown',
      post: { ...base, providerOperation: safeOperation }
    };
  };
  t.after(() => { applicationService.reconcileProviderOperation = original; });

  const app = express();
  app.use('/api/runtime', runtimeControlRoutes);
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/api/runtime/posts/${base.id}/provider/reconcile`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-chanter-runtime-token': TOKEN,
        'x-chanter-workspace-id': 'workspace-owner'
      },
      body: JSON.stringify({ accountId: 'UC-exact' })
    }
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].input, { postId: base.id, accountId: 'UC-exact' });
  assert.equal(body.classification, 'outcome_unknown');
  assert.equal(body.post.providerOperation.providerOperationId, safeOperation.providerOperationId);
  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes('sessionLocator'), false);
  assert.equal(serialized.includes('CANARY-CIPHERTEXT'), false);
});
