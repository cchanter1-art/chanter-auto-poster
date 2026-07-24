'use strict';

// P0 image batch intake + TikTok auto-music. One canonical image -> batch
// intake -> multiple TikTok destinations -> independent caption/schedule/
// soundMode -> PHOTO Direct Post -> tiktok_recommended => auto_add_music:true.
//
// Deterministic and offline: the REAL mediaPolicy, application service, and
// batchService run over an in-memory storage fake (only Firestore, Cloudinary,
// and AI providers are faked) — the same pattern as platform-batch-fanout.test.js.
// The fake storage.addUploadedPosts mirrors the real media-type derivation
// (getUploadMediaType) so a photo source persists mediaType 'photo' with an
// image mediaUrl, exactly as production storage would.

const assert = require('node:assert/strict');
const test = require('node:test');
const { createCommercialFixture } = require('./helpers/commercial-fixture');
const mediaPolicy = require('../src/mediaPolicy');
const { postFromDoc } = require('../src/postsMapper');
const { buildPhotoPayload } = require('../src/tiktok');
const {
  createAutoPosterApplicationService,
  createExecutionContext
} = require('../src/autoposterApplicationService');
const { createBatchService } = require('../src/batchService');

const BASE_NOW = Date.parse('2026-07-10T10:00:00.000Z');

const TEST_BATCH_CONFIG = {
  batchIntake: {
    maxItems: 10,
    prepareConcurrency: 2,
    prepareMaxAttempts: 3,
    prepareLeaseMinutes: 10,
    staggerDefaultMinutes: 30,
    staggerMinMinutes: 5,
    staggerMaxMinutes: 24 * 60,
    safetyBufferMinutes: 10,
    downloadTimeoutMs: 5_000,
    maxDownloadBytes: 250 * 1024 * 1024
  }
};

function imageFile(name = 'canonical.jpg', mimetype = 'image/jpeg') {
  return { path: `/tmp/${name}`, originalname: name, filename: name, mimetype, size: 2048 };
}
function videoFile(name = 'clip.mp4') {
  return { path: `/tmp/${name}`, originalname: name, filename: name, mimetype: 'video/mp4', size: 1024 };
}
function unsupportedFile(name = 'doc.pdf') {
  return { path: `/tmp/${name}`, originalname: name, filename: name, mimetype: 'application/pdf', size: 512 };
}

// Mirror of the real storage.getUploadMediaType: canonical field wins, never a
// misleading filename.
function uploadMediaType(file) {
  const mime = String(file.mimetype || '').toLowerCase();
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('image/')) return 'photo';
  const name = String(file.originalname || '').toLowerCase();
  return ['.mp4', '.mov', '.webm'].some((ext) => name.endsWith(ext)) ? 'video' : 'photo';
}

function makeWorld({ nowMs = BASE_NOW } = {}) {
  const tiktokAccounts = [
    {
      accountId: 'account-a', open_id: 'open-a', userId: 'owner', platform: 'tiktok',
      username: 'creator_a', connected: true,
      access_token: 'tt-access', refresh_token: 'tt-refresh', scope: 'user.info.basic,video.publish'
    },
    {
      accountId: 'account-b', open_id: 'open-b', userId: 'owner', platform: 'tiktok',
      username: 'creator_b', connected: true,
      access_token: 'tt-access-b', refresh_token: 'tt-refresh-b', scope: 'user.info.basic,video.publish'
    }
  ];
  const posts = [];
  const batchRecords = new Map();
  const calls = { analyzeVideoForCaption: [], downloadMedia: [], addDefaults: [] };
  let sequence = 0;
  let now = nowMs;

  const storage = {
    async getCanonicalTikTokAccount(userId, accountId) {
      return userId === 'owner' ? (tiktokAccounts.find((a) => a.accountId === accountId) || null) : null;
    },
    async getCanonicalTikTokAccounts(userId) { return userId === 'owner' ? tiktokAccounts : []; },
    async getTikTokAccount(userId, accountId) {
      return userId === 'owner' ? (tiktokAccounts.find((a) => a.accountId === accountId) || null) : null;
    },
    async getYouTubeAccounts() { return []; },
    async getYouTubeAccount() { return null; },
    async getPosts(userId, accountId) {
      return userId === 'owner' ? posts.filter((post) => !accountId || post.accountId === accountId) : [];
    },
    async getPost(userId, id, accountId) {
      if (userId !== 'owner') return null;
      return posts.find((post) => post.id === id && (!accountId || post.accountId === accountId)) || null;
    },
    async addUploadedPosts(userId, files, defaults) {
      calls.addDefaults.push({ provider: defaults.provider, allowImageMedia: defaults.allowImageMedia });
      const targets = Array.isArray(defaults.accounts) && defaults.accounts.length > 0
        ? defaults.accounts
        : [{ accountId: defaults.accountId, tiktokOpenId: defaults.tiktokOpenId, username: defaults.username, soundMode: defaults.soundMode }];
      const sources = Array.isArray(files) && files.length > 0 ? files : [null];
      const created = [];
      for (const target of targets) {
        for (let sourceIdx = 0; sourceIdx < sources.length; sourceIdx += 1) {
          const file = sources[sourceIdx];
          const mediaType = file ? uploadMediaType(file) : 'video';
          const mediaUrl = `https://cdn.example.com/${target.accountId}/${file ? file.originalname : 'url'}`;
          const post = postFromDoc({
            id: `post-${++sequence}`,
            data: () => ({
              userId,
              workspaceId: defaults.workspaceId,
              platform: defaults.provider,
              provider: defaults.provider,
              accountId: target.accountId,
              tiktokOpenId: target.tiktokOpenId,
              username: target.username,
              originalName: file ? file.originalname : '',
              fileName: file ? file.originalname : '',
              mediaType,
              mediaUrl,
              mediaPath: mediaUrl,
              videoPath: mediaType === 'video' ? mediaUrl : '',
              imagePath: mediaType === 'photo' ? mediaUrl : '',
              publicMediaUrl: mediaUrl,
              publicImageUrl: mediaType === 'photo' ? mediaUrl : '',
              cloudinaryPublicId: `cld-${target.accountId}-${file ? file.originalname : 'url'}`,
              caption: defaults.caption,
              hashtags: defaults.hashtags,
              soundMode: target.soundMode,
              privacyLevel: 'SELF_ONLY',
              scheduledAt: null,
              status: 'pending',
              approvedAt: null,
              approvedBy: null,
              createdAt: { toDate: () => new Date(now) },
              updatedAt: { toDate: () => new Date(now) },
              batchId: defaults.batchId || '',
              batchOrder: defaults.batchId ? created.length : null,
              sourceIndex: defaults.batchId ? sourceIdx : null,
              preparation: defaults.batchId
                ? { status: 'pending', attempts: 0, leaseAt: null, finishedAt: null, provider: '', fallbackUsed: false, error: '' }
                : null
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
      createdPosts.forEach((created_post) => {
        const stored = posts.find((post) => post.id === created_post.id);
        const slot = slotsByIndex.get(stored.sourceIndex);
        if (!slot) throw new Error(`No schedule slot found for source index ${stored.sourceIndex}.`);
        stored.scheduledAt = slot.scheduledAt;
        stored.status = 'scheduled';
        stored.channelOffsetMinutes = 0;
        stored.campaignStartAt = plan.baseAt || slot.scheduledAt;
        count += 1;
      });
      return count;
    },
    async updatePost(userId, id, patch, accountId) {
      const post = posts.find((item) => item.id === id && (!accountId || item.accountId === accountId));
      if (!post) return null;
      const {
        provider, platform, accountId: _a, connectedAccountId, tiktokOpenId, username,
        providerMetadata, publishAttemptBudget, sourceIndex, batchId, batchOrder, preparation,
        mediaType, ...allowed
      } = patch;
      Object.assign(post, allowed);
      if ('scheduledAt' in allowed) post.status = allowed.scheduledAt ? 'scheduled' : 'pending';
      return post;
    },
    async approvePost(userId, id, { approvedBy }, accountId) {
      const post = posts.find((item) => item.id === id && (!accountId || item.accountId === accountId));
      if (!post) return null;
      if (!['pending', 'scheduled', 'failed', 'ready'].includes(post.status)) return null;
      post.approved = true;
      post.approvalState = 'approved';
      post.approvedAt = new Date(now).toISOString();
      post.approvedBy = approvedBy;
      return post;
    },
    async deletePost(userId, id, accountId) {
      const post = posts.find((item) => item.id === id && item.userId === userId && (!accountId || item.accountId === accountId));
      if (!post) return false;
      posts.splice(posts.indexOf(post), 1);
      return true;
    },
    async createBatchRecord(record) {
      if (batchRecords.has(record.batchId)) {
        const error = new Error('already exists');
        error.code = 6;
        throw error;
      }
      const stored = {
        ...record, preparedCount: 0, failedCount: 0, acceptedCount: 0, deletedCount: 0,
        createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString()
      };
      batchRecords.set(record.batchId, stored);
      return { ...stored };
    },
    async getBatchRecord(userId, batchId) {
      const record = batchRecords.get(batchId);
      return record && record.userId === userId ? { ...record } : null;
    },
    async listBatchRecords(userId) {
      return [...batchRecords.values()].filter((record) => record.userId === userId).map((record) => ({ ...record }));
    },
    async updateBatchRecord(userId, batchId, patch) {
      const record = batchRecords.get(batchId);
      if (!record || record.userId !== userId) return null;
      Object.assign(record, patch, { updatedAt: new Date(now).toISOString() });
      return { ...record };
    },
    async deleteBatchRecord(userId, batchId) {
      const record = batchRecords.get(batchId);
      if (!record || record.userId !== userId) return false;
      batchRecords.delete(batchId);
      return true;
    },
    async incrementBatchDeletedCount(userId, batchId, delta) {
      const record = batchRecords.get(batchId);
      if (!record || record.userId !== userId) return record ? { ...record } : null;
      record.deletedCount = Number(record.deletedCount || 0) + delta;
      return { ...record };
    },
    async getBatchPosts(userId, batchId) {
      return posts.filter((post) => post.userId === userId && post.batchId === batchId)
        .sort((a, b) => (a.batchOrder ?? 0) - (b.batchOrder ?? 0));
    },
    async claimBatchItemPreparation(userId, postId, options) {
      const post = posts.find((item) => item.id === postId && item.userId === userId);
      if (!post) return { outcome: 'not_found' };
      const preparation = post.preparation || {};
      if (preparation.status === 'succeeded') return { outcome: 'already_succeeded', post };
      if (Number(preparation.attempts || 0) >= options.maxAttempts) return { outcome: 'attempts_exhausted', post };
      post.preparation = { ...preparation, status: 'running', attempts: Number(preparation.attempts || 0) + 1, leaseAt: new Date(now).toISOString() };
      return { outcome: 'claimed', post: { ...post } };
    },
    async recordBatchItemPreparationResult(userId, postId, result) {
      const post = posts.find((item) => item.id === postId && item.userId === userId);
      if (!post || !post.preparation || post.preparation.status !== 'running') return null;
      if (result.ok) {
        if (result.caption && !String(post.caption || '').trim()) post.caption = result.caption;
        if (result.hashtags && !String(post.hashtags || '').trim()) post.hashtags = result.hashtags;
        post.preparation = { ...post.preparation, status: 'succeeded', leaseAt: null, provider: result.provider || '', fallbackUsed: Boolean(result.fallbackUsed), error: '' };
      } else {
        post.preparation = { ...post.preparation, status: 'failed', leaseAt: null, error: String(result.error || '') };
      }
      return { ok: Boolean(result.ok) };
    }
  };

  const commercial = createCommercialFixture(storage, { planId: 'legacy_full_access' });
  const applicationService = createAutoPosterApplicationService({
    storage, mediaPolicy, commercialService: commercial, now: () => now
  });
  // If the image path ever fell through to video analysis, this fake would be
  // invoked — the test asserts it is NEVER called for a photo item.
  const autoCaption = {
    async analyzeVideoForCaption(videoPath, draft, options) {
      calls.analyzeVideoForCaption.push({ videoPath, filename: options && options.filename });
      return { caption: `Generated for ${options.filename}`, hashtags: '#auto', provider: 'fake-ai', fallbackUsed: false };
    }
  };
  const batchService = createBatchService({
    config: TEST_BATCH_CONFIG, storage, autoCaption, applicationService,
    downloadMedia: async (url) => { calls.downloadMedia.push(url); return { bytes: 1 }; },
    now: () => now, logger: { warn() {} }
  });

  return { posts, calls, batchRecords, tiktokAccounts, applicationService, batchService };
}

function websiteContext(overrides = {}) {
  return createExecutionContext({ userId: 'owner', actorId: 'admin:owner', source: 'website', ...overrides });
}
function approverContext() {
  return websiteContext({ approval: { approvedBy: 'admin:owner' } });
}

const INTAKE = {
  scheduleMode: 'interval',
  startDate: '2026-07-11',
  startTime: '09:00',
  timezoneOffsetMinutes: 0,
  staggerMinutes: 60
};

// ── mediaPolicy predicate: the single widened acceptance used by every batch
//    guard (multer filter, validateMedia, storage chokepoint) ────────────────

test('mediaPolicy: image predicates accept supported images and keep video-only unchanged', () => {
  // Supported images
  assert.equal(mediaPolicy.isImageUploadFile({ mimetype: 'image/jpeg', originalname: 'a.jpg' }), true);
  assert.equal(mediaPolicy.isImageUploadFile({ mimetype: 'image/png', originalname: 'a.png' }), true);
  assert.equal(mediaPolicy.isImageUploadFile({ mimetype: 'image/webp', originalname: 'a.webp' }), true);
  assert.equal(mediaPolicy.isImageUploadFile({ mimetype: 'image/jpeg', originalname: 'noext' }), true, 'image MIME with no extension is accepted');
  // Cross-mismatch is rejected by BOTH predicates (never "supported")
  assert.equal(mediaPolicy.isImageUploadFile({ mimetype: 'image/png', originalname: 'a.mp4' }), false, 'image MIME + video ext is a mismatch');
  assert.equal(mediaPolicy.isImageUploadFile({ mimetype: 'video/mp4', originalname: 'a.png' }), false, 'video MIME is not an image');
  // Unsupported image family (gif/bmp) and non-media are rejected
  assert.equal(mediaPolicy.isImageUploadFile({ mimetype: 'image/gif', originalname: 'a.gif' }), false);
  assert.equal(mediaPolicy.isImageUploadFile({ mimetype: 'application/pdf', originalname: 'a.pdf' }), false);

  // Batch acceptance = video OR image
  assert.equal(mediaPolicy.isSupportedBatchUploadFile({ mimetype: 'video/mp4', originalname: 'a.mp4' }), true);
  assert.equal(mediaPolicy.isSupportedBatchUploadFile({ mimetype: 'image/jpeg', originalname: 'a.jpg' }), true);
  assert.equal(mediaPolicy.isSupportedBatchUploadFile({ mimetype: 'application/pdf', originalname: 'a.pdf' }), false);

  // The classic video-only predicate is untouched: it still rejects images.
  assert.equal(mediaPolicy.isVideoUploadFile({ mimetype: 'image/jpeg', originalname: 'a.jpg' }), false);
  assert.equal(mediaPolicy.isVideoUploadFile({ mimetype: 'video/mp4', originalname: 'a.mp4' }), true);
});

// ── 1. Batch upload accepts one valid image; media type persists as photo ───

test('batch upload accepts one valid image and persists mediaType=photo', async () => {
  const world = makeWorld();
  const result = await world.batchService.createBatch(websiteContext(), {
    ...INTAKE, intakeKey: 'img-accept-1',
    destinations: [{ provider: 'tiktok', accountId: 'account-a' }],
    files: [imageFile('canonical.jpg')]
  });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].mediaType, 'photo');
  assert.match(result.items[0].mediaUrl, /canonical\.jpg$/);
  // The batch fan-out is the path that opts into image media.
  assert.equal(world.calls.addDefaults.every((call) => call.allowImageMedia === true), true);
});

// ── 2. Unsupported file types remain rejected (real validateMedia) ──────────

test('unsupported file type is rejected and nothing is created', async () => {
  const world = makeWorld();
  await assert.rejects(
    world.batchService.createBatch(websiteContext(), {
      ...INTAKE, intakeKey: 'img-reject-1',
      destinations: [{ provider: 'tiktok', accountId: 'account-a' }],
      files: [unsupportedFile('doc.pdf')]
    }),
    /video.*image|image.*video/i
  );
  assert.equal(world.posts.length, 0, 'no partial creation for a rejected file');
  assert.equal(world.batchRecords.size, 0, 'the reserved batch record was compensated away');
});

// ── 3. Image preparation does NOT invoke video-only analysis ────────────────

test('image preparation succeeds without downloading or running video analysis', async () => {
  const world = makeWorld();
  const result = await world.batchService.createBatch(websiteContext(), {
    ...INTAKE, intakeKey: 'img-prep-1',
    destinations: [{ provider: 'tiktok', accountId: 'account-a' }],
    files: [imageFile('canonical.jpg')]
  });
  await world.batchService.startPreparation(websiteContext(), result.batch.batchId);
  const view = await world.batchService.getBatchView(websiteContext(), result.batch.batchId);
  const item = view.items[0];
  assert.equal(item.preparation.status, 'succeeded');
  assert.equal(item.preparation.provider, '', 'no AI provider claimed for an image');
  assert.equal(world.calls.analyzeVideoForCaption.length, 0, 'video-only caption analysis never runs for a photo');
  assert.equal(world.calls.downloadMedia.length, 0, 'the image is never downloaded for analysis');
});

// ── 4 & 5. One image fans out to two accounts, sharing one canonical source ──

test('one image fans out to two TikTok accounts referencing the same canonical source', async () => {
  const world = makeWorld();
  const result = await world.batchService.createBatch(websiteContext(), {
    ...INTAKE, intakeKey: 'img-fanout-1',
    destinations: [
      { provider: 'tiktok', accountId: 'account-a' },
      { provider: 'tiktok', accountId: 'account-b' }
    ],
    files: [imageFile('canonical.jpg')]
  });
  assert.equal(result.items.length, 2);
  assert.deepEqual(new Set(result.items.map((i) => i.accountId)), new Set(['account-a', 'account-b']));
  // Same canonical source: one sourceIndex, one original filename, one slot.
  assert.deepEqual(new Set(result.items.map((i) => i.sourceIndex)), new Set([0]));
  assert.deepEqual(new Set(result.items.map((i) => i.originalName)), new Set(['canonical.jpg']));
  assert.equal(new Set(result.items.map((i) => i.scheduledAt)).size, 1, 'destination copies share one synchronized slot');
  // Every copy is an independent PHOTO draft.
  assert.equal(result.items.every((i) => i.mediaType === 'photo'), true);
});

// ── 6. Each destination preserves an independent soundMode ──────────────────

test('two image destinations persist independent sound modes on one canonical source', async () => {
  const world = makeWorld();
  const result = await world.batchService.createBatch(websiteContext(), {
    ...INTAKE, intakeKey: 'img-sound-1',
    destinations: [
      { provider: 'tiktok', accountId: 'account-a', soundMode: 'tiktok_recommended' },
      { provider: 'tiktok', accountId: 'account-b', soundMode: 'keep_original' }
    ],
    files: [imageFile('canonical.jpg')]
  });
  const byAccount = new Map(result.items.map((i) => [i.accountId, i]));
  assert.equal(new Set(result.items.map((i) => i.sourceIndex)).size, 1);
  assert.equal(byAccount.get('account-a').soundMode, 'tiktok_recommended');
  assert.equal(byAccount.get('account-b').soundMode, 'keep_original');
});

// ── 7 & 8. PHOTO payload: tiktok_recommended => auto_add_music true; else false

test('PHOTO + tiktok_recommended emits auto_add_music:true; keep_original emits false', async () => {
  const world = makeWorld();
  const result = await world.batchService.createBatch(websiteContext(), {
    ...INTAKE, intakeKey: 'img-music-1',
    destinations: [
      { provider: 'tiktok', accountId: 'account-a', soundMode: 'tiktok_recommended' },
      { provider: 'tiktok', accountId: 'account-b', soundMode: 'keep_original' }
    ],
    files: [imageFile('canonical.jpg')]
  });
  const byAccount = new Map(result.items.map((i) => [i.accountId, i]));

  const recommended = byAccount.get('account-a');
  const payloadRecommended = buildPhotoPayload(recommended, recommended.mediaUrl);
  assert.equal(payloadRecommended.media_type, 'PHOTO');
  assert.equal(payloadRecommended.post_info.auto_add_music, true);

  const original = byAccount.get('account-b');
  const payloadOriginal = buildPhotoPayload(original, original.mediaUrl);
  assert.equal(payloadOriginal.media_type, 'PHOTO');
  assert.equal(payloadOriginal.post_info.auto_add_music, false);
});

// ── 9. Legacy video batch behavior remains unchanged ────────────────────────

test('a video batch still runs video analysis and generates a caption (legacy path intact)', async () => {
  const world = makeWorld();
  const result = await world.batchService.createBatch(websiteContext(), {
    ...INTAKE, intakeKey: 'vid-legacy-1',
    destinations: [{ provider: 'tiktok', accountId: 'account-a' }],
    files: [videoFile('clip.mp4')]
  });
  await world.batchService.startPreparation(websiteContext(), result.batch.batchId);
  const view = await world.batchService.getBatchView(websiteContext(), result.batch.batchId);
  const item = view.items[0];
  assert.equal(item.mediaType, 'video');
  assert.equal(item.preparation.status, 'succeeded');
  assert.equal(item.preparation.provider, 'fake-ai', 'video still routes through AI caption analysis');
  assert.equal(world.calls.analyzeVideoForCaption.length, 1, 'video analysis ran exactly once');
  assert.equal(world.calls.downloadMedia.length, 1, 'the video was downloaded for analysis');
  assert.match(item.caption, /Generated for clip\.mp4/);
});

// ── 10. Approval / scheduling remains intact for image items ────────────────

test('image item accepts through the approval gate after a manual caption edit', async () => {
  const world = makeWorld();
  const result = await world.batchService.createBatch(websiteContext(), {
    ...INTAKE, intakeKey: 'img-accept-2',
    destinations: [{ provider: 'tiktok', accountId: 'account-a' }],
    files: [imageFile('canonical.jpg')]
  });
  await world.batchService.startPreparation(websiteContext(), result.batch.batchId);
  const item = result.items[0];

  // A captionless photo needs attention until the operator supplies copy —
  // manual caption editing is preserved through the image path.
  let view = await world.batchService.getBatchView(websiteContext(), result.batch.batchId);
  assert.equal(view.items[0].validationProblems.includes('missing_caption'), true);

  await world.batchService.updateItem(websiteContext(), result.batch.batchId, item.id, {
    caption: 'Sunrise over the harbor'
  });

  const outcome = await world.batchService.acceptItems(approverContext(), result.batch.batchId, { postIds: 'all' });
  assert.equal(outcome.accepted.length, 1);
  assert.equal(outcome.failed.length, 0);

  view = await world.batchService.getBatchView(websiteContext(), result.batch.batchId);
  assert.equal(view.items[0].approved, true);
  assert.equal(view.items[0].caption, 'Sunrise over the harbor');
});

// ── Mixed batch: one video + one image in the same intake ───────────────────

test('a mixed video+image batch prepares each source on its own type-correct path', async () => {
  const world = makeWorld();
  const result = await world.batchService.createBatch(websiteContext(), {
    ...INTAKE, intakeKey: 'mixed-1',
    destinations: [{ provider: 'tiktok', accountId: 'account-a' }],
    files: [videoFile('clip.mp4'), imageFile('canonical.jpg')]
  });
  await world.batchService.startPreparation(websiteContext(), result.batch.batchId);
  const view = await world.batchService.getBatchView(websiteContext(), result.batch.batchId);
  const byType = new Map(view.items.map((i) => [i.mediaType, i]));
  assert.equal(byType.get('video').preparation.status, 'succeeded');
  assert.equal(byType.get('photo').preparation.status, 'succeeded');
  // Only the video was analyzed/downloaded — the image took the deterministic path.
  assert.equal(world.calls.analyzeVideoForCaption.length, 1);
  assert.deepEqual(world.calls.analyzeVideoForCaption.map((c) => c.filename), ['clip.mp4']);
  assert.equal(world.calls.downloadMedia.length, 1);
});
