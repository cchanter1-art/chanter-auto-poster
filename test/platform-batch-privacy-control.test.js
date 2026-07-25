'use strict';

// P0 per-destination TikTok privacy control. One canonical image fans out to
// multiple TikTok destinations, each carrying an independently selectable,
// persisted `privacyLevel` that survives edit → reload → acceptance and is used
// verbatim in the PHOTO/VIDEO payloads. Unknown or account-unsupported values
// fail closed BEFORE any provider call; SELF_ONLY is never converted to public.
//
// Deterministic and offline: the REAL tiktokPrivacy, postsMapper, application
// service, batchService, and tiktok payload builders run over in-memory fakes
// (Firestore, Cloudinary, AI, and — for the provider fail-closed tests — the
// TikTok HTTP endpoints via a fetch mock). No live provider mutation occurs.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { createCommercialFixture } = require('./helpers/commercial-fixture');
const mediaPolicy = require('../src/mediaPolicy');
const { postFromDoc, mapPatchToFirestore } = require('../src/postsMapper');
const {
  isTikTokPrivacyLevel,
  normalizeTikTokPrivacyLevel,
  DEFAULT_TIKTOK_PRIVACY_LEVEL,
  TIKTOK_PRIVACY_LEVELS
} = require('../src/tiktokPrivacy');
const { buildPhotoPayload, buildVideoPayload } = require('../src/tiktok');
const {
  createAutoPosterApplicationService,
  createExecutionContext
} = require('../src/autoposterApplicationService');
const { createBatchService } = require('../src/batchService');

const BASE_NOW = Date.parse('2026-07-10T10:00:00.000Z');

const TEST_BATCH_CONFIG = {
  batchIntake: {
    maxItems: 10, prepareConcurrency: 2, prepareMaxAttempts: 3, prepareLeaseMinutes: 10,
    staggerDefaultMinutes: 30, staggerMinMinutes: 5, staggerMaxMinutes: 24 * 60,
    safetyBufferMinutes: 10, downloadTimeoutMs: 5_000, maxDownloadBytes: 250 * 1024 * 1024
  }
};

function imageFile(name = 'canonical.jpg') {
  return { path: `/tmp/${name}`, originalname: name, filename: name, mimetype: 'image/jpeg', size: 2048 };
}

function makeWorld({ nowMs = BASE_NOW } = {}) {
  const tiktokAccounts = [
    { accountId: 'account-a', open_id: 'open-a', userId: 'owner', platform: 'tiktok', username: 'creator_a', connected: true, access_token: 'tt-a', refresh_token: 'r-a', scope: 'user.info.basic,video.publish' },
    { accountId: 'account-b', open_id: 'open-b', userId: 'owner', platform: 'tiktok', username: 'creator_b', connected: true, access_token: 'tt-b', refresh_token: 'r-b', scope: 'user.info.basic,video.publish' }
  ];
  const posts = [];
  const batchRecords = new Map();
  let sequence = 0;
  let now = nowMs;

  const storage = {
    async getCanonicalTikTokAccount(userId, accountId) { return userId === 'owner' ? (tiktokAccounts.find((a) => a.accountId === accountId) || null) : null; },
    async getCanonicalTikTokAccounts(userId) { return userId === 'owner' ? tiktokAccounts : []; },
    async getTikTokAccount(userId, accountId) { return userId === 'owner' ? (tiktokAccounts.find((a) => a.accountId === accountId) || null) : null; },
    async getYouTubeAccounts() { return []; },
    async getYouTubeAccount() { return null; },
    async getPosts(userId, accountId) { return userId === 'owner' ? posts.filter((p) => !accountId || p.accountId === accountId) : []; },
    async getPost(userId, id, accountId) { return userId === 'owner' ? (posts.find((p) => p.id === id && (!accountId || p.accountId === accountId)) || null) : null; },
    async addUploadedPosts(userId, files, defaults) {
      const targets = Array.isArray(defaults.accounts) && defaults.accounts.length > 0
        ? defaults.accounts
        : [{ accountId: defaults.accountId, tiktokOpenId: defaults.tiktokOpenId, username: defaults.username, soundMode: defaults.soundMode }];
      const sources = Array.isArray(files) && files.length > 0 ? files : [null];
      const created = [];
      for (const target of targets) {
        for (let sourceIdx = 0; sourceIdx < sources.length; sourceIdx += 1) {
          const file = sources[sourceIdx];
          const mediaUrl = `https://cdn.example.com/${target.accountId}/${file ? file.originalname : 'url'}`;
          const post = postFromDoc({
            id: `post-${++sequence}`,
            data: () => ({
              userId, workspaceId: defaults.workspaceId, platform: defaults.provider, provider: defaults.provider,
              accountId: target.accountId, tiktokOpenId: target.tiktokOpenId, username: target.username,
              originalName: file ? file.originalname : '', fileName: file ? file.originalname : '',
              mediaType: 'photo', mediaUrl, mediaPath: mediaUrl, imagePath: mediaUrl,
              publicMediaUrl: mediaUrl, publicImageUrl: mediaUrl,
              caption: defaults.caption, hashtags: defaults.hashtags, soundMode: target.soundMode,
              // Canonical privacy field, defaulting SELF_ONLY exactly like real storage.
              privacyLevel: String(defaults.privacyLevel || 'SELF_ONLY'),
              scheduledAt: null, status: 'pending', approvedAt: null, approvedBy: null,
              createdAt: { toDate: () => new Date(now) }, updatedAt: { toDate: () => new Date(now) },
              batchId: defaults.batchId || '', batchOrder: defaults.batchId ? created.length : null,
              sourceIndex: defaults.batchId ? sourceIdx : null,
              preparation: defaults.batchId ? { status: 'pending', attempts: 0, leaseAt: null, finishedAt: null, provider: '', fallbackUsed: false, error: '' } : null
            })
          });
          posts.push(post);
          created.push(post);
        }
      }
      return created;
    },
    async applyBatchSourceSchedule(userId, createdPosts, plan) {
      const slotsByIndex = new Map((plan.slots || []).map((slot) => [slot.index, slot]));
      let count = 0;
      createdPosts.forEach((cp) => {
        const stored = posts.find((p) => p.id === cp.id);
        const slot = slotsByIndex.get(stored.sourceIndex);
        if (!slot) throw new Error(`No slot for source ${stored.sourceIndex}.`);
        stored.scheduledAt = slot.scheduledAt; stored.status = 'scheduled';
        stored.campaignStartAt = plan.baseAt || slot.scheduledAt; count += 1;
      });
      return count;
    },
    // Real mapPatchToFirestore validation is unit-tested separately; the fake
    // mirrors its allow/strip behavior and applies the (already normalized)
    // privacyLevel the batch service put in the patch.
    async updatePost(userId, id, patch, accountId) {
      const post = posts.find((p) => p.id === id && (!accountId || p.accountId === accountId));
      if (!post) return null;
      const { provider, platform, accountId: _a, connectedAccountId, tiktokOpenId, username, providerMetadata, publishAttemptBudget, sourceIndex, batchId, batchOrder, preparation, mediaType, ...allowed } = patch;
      Object.assign(post, allowed);
      if ('scheduledAt' in allowed) post.status = allowed.scheduledAt ? 'scheduled' : 'pending';
      return post;
    },
    async approvePost(userId, id, { approvedBy }, accountId) {
      const post = posts.find((p) => p.id === id && (!accountId || p.accountId === accountId));
      if (!post) return null;
      if (!['pending', 'scheduled', 'failed', 'ready'].includes(post.status)) return null;
      post.approved = true; post.approvalState = 'approved'; post.approvedAt = new Date(now).toISOString(); post.approvedBy = approvedBy;
      return post;
    },
    async deletePost(userId, id, accountId) {
      const post = posts.find((p) => p.id === id && p.userId === userId && (!accountId || p.accountId === accountId));
      if (!post) return false;
      posts.splice(posts.indexOf(post), 1); return true;
    },
    async createBatchRecord(record) {
      if (batchRecords.has(record.batchId)) { const e = new Error('already exists'); e.code = 6; throw e; }
      const stored = { ...record, preparedCount: 0, failedCount: 0, acceptedCount: 0, deletedCount: 0, createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() };
      batchRecords.set(record.batchId, stored); return { ...stored };
    },
    async getBatchRecord(userId, batchId) { const r = batchRecords.get(batchId); return r && r.userId === userId ? { ...r } : null; },
    async listBatchRecords(userId) { return [...batchRecords.values()].filter((r) => r.userId === userId).map((r) => ({ ...r })); },
    async updateBatchRecord(userId, batchId, patch) { const r = batchRecords.get(batchId); if (!r || r.userId !== userId) return null; Object.assign(r, patch, { updatedAt: new Date(now).toISOString() }); return { ...r }; },
    async deleteBatchRecord(userId, batchId) { const r = batchRecords.get(batchId); if (!r || r.userId !== userId) return false; batchRecords.delete(batchId); return true; },
    async incrementBatchDeletedCount(userId, batchId, delta) { const r = batchRecords.get(batchId); if (!r || r.userId !== userId) return r ? { ...r } : null; r.deletedCount = Number(r.deletedCount || 0) + delta; return { ...r }; },
    async getBatchPosts(userId, batchId) { return posts.filter((p) => p.userId === userId && p.batchId === batchId).sort((a, b) => (a.batchOrder ?? 0) - (b.batchOrder ?? 0)); },
    async claimBatchItemPreparation(userId, postId, options) {
      const post = posts.find((p) => p.id === postId && p.userId === userId);
      if (!post) return { outcome: 'not_found' };
      const prep = post.preparation || {};
      if (prep.status === 'succeeded') return { outcome: 'already_succeeded', post };
      if (Number(prep.attempts || 0) >= options.maxAttempts) return { outcome: 'attempts_exhausted', post };
      post.preparation = { ...prep, status: 'running', attempts: Number(prep.attempts || 0) + 1, leaseAt: new Date(now).toISOString() };
      return { outcome: 'claimed', post: { ...post } };
    },
    async recordBatchItemPreparationResult(userId, postId, result) {
      const post = posts.find((p) => p.id === postId && p.userId === userId);
      if (!post || !post.preparation || post.preparation.status !== 'running') return null;
      if (result.ok) post.preparation = { ...post.preparation, status: 'succeeded', leaseAt: null, provider: result.provider || '', fallbackUsed: Boolean(result.fallbackUsed), error: '' };
      else post.preparation = { ...post.preparation, status: 'failed', leaseAt: null, error: String(result.error || '') };
      return { ok: Boolean(result.ok) };
    }
  };

  const commercial = createCommercialFixture(storage, { planId: 'legacy_full_access' });
  const applicationService = createAutoPosterApplicationService({ storage, mediaPolicy, commercialService: commercial, now: () => now });
  const autoCaption = { async analyzeVideoForCaption() { return { caption: 'x', hashtags: '', provider: 'fake-ai', fallbackUsed: false }; } };
  const batchService = createBatchService({ config: TEST_BATCH_CONFIG, storage, autoCaption, applicationService, downloadMedia: async () => ({ bytes: 1 }), now: () => now, logger: { warn() {} } });

  return { posts, batchRecords, tiktokAccounts, applicationService, batchService };
}

function websiteContext(overrides = {}) {
  return createExecutionContext({ userId: 'owner', actorId: 'admin:owner', source: 'website', ...overrides });
}
function approverContext() { return websiteContext({ approval: { approvedBy: 'admin:owner' } }); }

const INTAKE = { scheduleMode: 'interval', startDate: '2026-07-11', startTime: '09:00', timezoneOffsetMinutes: 0, staggerMinutes: 60 };

async function createTwoTikTokImageBatch(world, intakeKey) {
  return world.batchService.createBatch(websiteContext(), {
    ...INTAKE, intakeKey,
    destinations: [
      { provider: 'tiktok', accountId: 'account-a' },
      { provider: 'tiktok', accountId: 'account-b' }
    ],
    files: [imageFile('canonical.jpg')]
  });
}

// ── A. Canonical privacy vocabulary ─────────────────────────────────────────

test('tiktokPrivacy: valid levels, case-insensitive, safe default SELF_ONLY', () => {
  assert.equal(DEFAULT_TIKTOK_PRIVACY_LEVEL, 'SELF_ONLY');
  for (const level of TIKTOK_PRIVACY_LEVELS) assert.equal(isTikTokPrivacyLevel(level), true);
  assert.equal(isTikTokPrivacyLevel('self_only'), true);
  assert.equal(isTikTokPrivacyLevel('garbage'), false);
  assert.equal(isTikTokPrivacyLevel(''), false);
  assert.equal(isTikTokPrivacyLevel(undefined), false);
  assert.equal(normalizeTikTokPrivacyLevel('public_to_everyone'), 'PUBLIC_TO_EVERYONE');
  assert.equal(normalizeTikTokPrivacyLevel('garbage'), 'SELF_ONLY');
  assert.equal(normalizeTikTokPrivacyLevel(undefined), 'SELF_ONLY');
});

// ── B. Read default + write chokepoint ──────────────────────────────────────

test('postsMapper: legacy record without privacyLevel reads as SELF_ONLY (criterion 10)', () => {
  const post = postFromDoc({ id: 'legacy', data: () => ({ platform: 'tiktok', accountId: 'acc-a' }) });
  assert.equal(post.privacyLevel, 'SELF_ONLY');
});

test('postsMapper: explicit privacyLevel is preserved on read', () => {
  const post = postFromDoc({ id: 'p', data: () => ({ platform: 'tiktok', accountId: 'acc-a', privacyLevel: 'PUBLIC_TO_EVERYONE' }) });
  assert.equal(post.privacyLevel, 'PUBLIC_TO_EVERYONE');
});

test('mapPatchToFirestore: privacyLevel is normalized on generic write patches (fail-safe, never trusts garbage)', () => {
  assert.equal(mapPatchToFirestore({ privacyLevel: 'SELF_ONLY' }).privacyLevel, 'SELF_ONLY');
  assert.equal(mapPatchToFirestore({ privacyLevel: 'public_to_everyone' }).privacyLevel, 'PUBLIC_TO_EVERYONE');
  assert.equal(mapPatchToFirestore({ privacyLevel: 'garbage' }).privacyLevel, 'SELF_ONLY');
});

// ── C. Per-destination persistence through edit / reload / acceptance ────────

test('two destination drafts from one image persist DIFFERENT privacy values (criterion 2)', async () => {
  const world = makeWorld();
  const result = await createTwoTikTokImageBatch(world, 'priv-2');
  const [copyA, copyB] = result.items;
  // Both default to SELF_ONLY before any edit.
  assert.equal(copyA.privacyLevel, 'SELF_ONLY');
  assert.equal(copyB.privacyLevel, 'SELF_ONLY');

  await world.batchService.updateItem(websiteContext(), result.batch.batchId, copyA.id, { privacyLevel: 'SELF_ONLY' });
  await world.batchService.updateItem(websiteContext(), result.batch.batchId, copyB.id, { privacyLevel: 'PUBLIC_TO_EVERYONE' });

  // criterion 3: saving + reloading preserves each item's selected privacy.
  const view = await world.batchService.getBatchView(websiteContext(), result.batch.batchId);
  const byId = new Map(view.items.map((i) => [i.id, i]));
  assert.equal(byId.get(copyA.id).privacyLevel, 'SELF_ONLY');
  assert.equal(byId.get(copyB.id).privacyLevel, 'PUBLIC_TO_EVERYONE', 'siblings hold independent privacy');
});

test('acceptance/scheduling preserves the selected privacy (criterion 4)', async () => {
  const world = makeWorld();
  const result = await createTwoTikTokImageBatch(world, 'priv-4');
  await world.batchService.startPreparation(websiteContext(), result.batch.batchId);
  const [copyA] = result.items;

  await world.batchService.updateItem(websiteContext(), result.batch.batchId, copyA.id, { caption: 'Proof', privacyLevel: 'SELF_ONLY' });
  const outcome = await world.batchService.acceptItems(approverContext(), result.batch.batchId, { postIds: [copyA.id] });
  assert.equal(outcome.accepted.length, 1);

  const view = await world.batchService.getBatchView(websiteContext(), result.batch.batchId);
  const accepted = view.items.find((i) => i.id === copyA.id);
  assert.equal(accepted.approved, true);
  assert.equal(accepted.privacyLevel, 'SELF_ONLY', 'privacy survives approval + safe re-schedule');
});

test('updateItem rejects an unknown privacy value with a typed error (criterion 7 at edit boundary)', async () => {
  const world = makeWorld();
  const result = await createTwoTikTokImageBatch(world, 'priv-invalid');
  const [copyA] = result.items;
  await assert.rejects(
    world.batchService.updateItem(websiteContext(), result.batch.batchId, copyA.id, { privacyLevel: 'TOTALLY_PUBLIC' }),
    (err) => err.name === 'BatchServiceError' && err.code === 'invalid_privacy_level'
  );
  // The draft is untouched — still the safe default.
  const view = await world.batchService.getBatchView(websiteContext(), result.batch.batchId);
  assert.equal(view.items.find((i) => i.id === copyA.id).privacyLevel, 'SELF_ONLY');
});

// ── D. Provider payload + fail-closed ───────────────────────────────────────

test('PHOTO payload with SELF_ONLY emits privacy_level SELF_ONLY and keeps auto_add_music (criterion 5)', () => {
  const recommended = buildPhotoPayload({ privacyLevel: 'SELF_ONLY', soundMode: 'tiktok_recommended', caption: 'c' }, 'https://cdn.example.com/x.jpg');
  assert.equal(recommended.media_type, 'PHOTO');
  assert.equal(recommended.post_info.privacy_level, 'SELF_ONLY');
  assert.equal(recommended.post_info.auto_add_music, true, 'auto_add_music behavior unchanged');

  const original = buildPhotoPayload({ privacyLevel: 'SELF_ONLY', soundMode: 'keep_original', caption: 'c' }, 'https://cdn.example.com/x.jpg');
  assert.equal(original.post_info.privacy_level, 'SELF_ONLY');
  assert.equal(original.post_info.auto_add_music, false);
});

test('VIDEO payload uses the selected privacy without touching sound-mode behavior (criterion 6)', () => {
  const selfOnly = buildVideoPayload({ privacyLevel: 'SELF_ONLY', soundMode: 'keep_original' }, 1024);
  assert.equal(selfOnly.post_info.privacy_level, 'SELF_ONLY');
  assert.equal(selfOnly.post_mode, 'DIRECT_POST');

  // A different selected value flows through verbatim (options permitting).
  const publicPost = buildVideoPayload({ privacyLevel: 'PUBLIC_TO_EVERYONE' }, 1024, { privacy_level_options: ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'] });
  assert.equal(publicPost.post_info.privacy_level, 'PUBLIC_TO_EVERYONE');
});

// publishPhotoPost is the unified TikTok publish entry (photo + video). These
// tests inject a fake storage + fetch mock, exactly like tiktok-sound-mode.test.js.
function withMockedTikTok(t, { creatorPrivacyOptions }) {
  const storagePath = require.resolve('../src/storage');
  const tiktokPath = require.resolve('../src/tiktok');
  delete require.cache[tiktokPath];
  const originalStorageCache = require.cache[storagePath];
  require.cache[storagePath] = {
    id: storagePath, filename: storagePath, loaded: true,
    exports: { getTikTokAccount: async () => ({ accountId: 'acc-a', open_id: 'acc-a', connected: true, access_token: 'token', expires_at: null }) }
  };
  const state = { reachedInit: false, fetchCalls: 0 };
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    state.fetchCalls += 1;
    if (String(url).includes('creator_info')) {
      return new Response(JSON.stringify({ data: { privacy_level_options: creatorPrivacyOptions }, error: { code: 'ok' } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    state.reachedInit = true;
    return new Response(null, { status: 500 });
  };
  t.after(() => {
    global.fetch = originalFetch;
    delete require.cache[tiktokPath];
    if (originalStorageCache) require.cache[storagePath] = originalStorageCache; else delete require.cache[storagePath];
  });
  return { tiktok: require('../src/tiktok'), state };
}

test('publishPhotoPost rejects an UNKNOWN privacy value before any external call (criterion 7)', async (t) => {
  const { tiktok, state } = withMockedTikTok(t, { creatorPrivacyOptions: ['SELF_ONLY'] });
  const result = await tiktok.publishPhotoPost({ userId: 'owner', accountId: 'acc-a', tiktokOpenId: 'acc-a', mediaType: 'photo', fileName: 'p.jpg', mediaUrl: 'https://cdn.example.com/p.jpg', privacyLevel: 'GARBAGE_LEVEL', soundMode: 'keep_original' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PRIVACY_LEVEL_INVALID');
  assert.equal(state.fetchCalls, 0, 'no external TikTok request is made for an invalid privacy value');
});

test('publishPhotoPost rejects an account-UNSUPPORTED privacy value before init (criterion 8)', async (t) => {
  const { tiktok, state } = withMockedTikTok(t, { creatorPrivacyOptions: ['SELF_ONLY'] });
  const result = await tiktok.publishPhotoPost({ userId: 'owner', accountId: 'acc-a', tiktokOpenId: 'acc-a', mediaType: 'photo', fileName: 'p.jpg', mediaUrl: 'https://cdn.example.com/p.jpg', privacyLevel: 'PUBLIC_TO_EVERYONE', soundMode: 'keep_original' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PRIVACY_LEVEL_UNSUPPORTED');
  assert.equal(state.reachedInit, false, 'the publish/init call is never reached');
});

test('no fallback converts SELF_ONLY to PUBLIC_TO_EVERYONE — it fails closed instead (criterion 9)', async (t) => {
  // Hypothetical: an account whose reported options exclude SELF_ONLY. A
  // requested SELF_ONLY must FAIL, never be silently swapped to a public level.
  const { tiktok, state } = withMockedTikTok(t, { creatorPrivacyOptions: ['PUBLIC_TO_EVERYONE'] });
  const result = await tiktok.publishPhotoPost({ userId: 'owner', accountId: 'acc-a', tiktokOpenId: 'acc-a', mediaType: 'photo', fileName: 'p.jpg', mediaUrl: 'https://cdn.example.com/p.jpg', privacyLevel: 'SELF_ONLY', soundMode: 'keep_original' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PRIVACY_LEVEL_UNSUPPORTED');
  assert.equal(state.reachedInit, false, 'SELF_ONLY is never posted as public');
});

// ── E. Review UI ships a TikTok-only privacy control (criterion 1) ──────────

test('batch-review page ships a per-destination TikTok privacy control', () => {
  const view = fs.readFileSync(path.join(__dirname, '..', 'src', 'views', 'platform-batch.ejs'), 'utf8');
  assert.match(view, /field-privacy/, 'a privacy select is rendered per item');
  assert.match(view, /tiktok-privacy-wrap/, 'the control is wrapped for TikTok-only visibility');
  assert.match(view, /item\.provider === 'tiktok'/, 'the wrap is gated to TikTok items');
  assert.match(view, /body\.privacyLevel = privacyField\.value/, 'the value saves through the existing item-edit PATCH');
  for (const level of ['SELF_ONLY', 'FOLLOWER_OF_CREATOR', 'MUTUAL_FOLLOW_FRIENDS', 'PUBLIC_TO_EVERYONE']) {
    assert.match(view, new RegExp(level), `offers ${level}`);
  }
});
