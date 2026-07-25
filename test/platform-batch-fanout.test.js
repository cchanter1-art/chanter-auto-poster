'use strict';

// V1.2 multi-account fan-out: N source videos x M selected destinations ->
// N x M canonical AutoPoster posts, each an independent draft. The REAL
// application service runs over an in-memory storage fake (only Firestore,
// Cloudinary, and AI providers are faked) — the same pattern as
// platform-batch.test.js / platform-destination.test.js.

const assert = require('node:assert/strict');
const test = require('node:test');
const { createCommercialFixture } = require('./helpers/commercial-fixture');
const mediaPolicy = require('../src/mediaPolicy');
const { postFromDoc } = require('../src/postsMapper');
const {
  createAutoPosterApplicationService,
  createExecutionContext
} = require('../src/autoposterApplicationService');
const { createBatchService, BatchServiceError } = require('../src/batchService');

const UPLOAD_SCOPE = 'https://www.googleapis.com/auth/youtube.upload';
const READONLY_SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';
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

function uploadFile(name) {
  return { path: `/tmp/${name}`, originalname: name, filename: name, mimetype: 'video/mp4', size: 1024 };
}

function makeWorld({ nowMs = BASE_NOW, failSchedulePostForProvider = null } = {}) {
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
  const youtubeAccounts = [
    {
      accountId: 'UC-chanter', id: 'UC-chanter', userId: 'owner', provider: 'youtube', platform: 'youtube',
      channelId: 'UC-chanter', username: 'chanterCy', displayName: 'chanterCy', connected: true,
      tokenPresent: true, refreshTokenPresent: true,
      accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
      grantedScopes: `${UPLOAD_SCOPE} ${READONLY_SCOPE}`,
      scope: `${UPLOAD_SCOPE} ${READONLY_SCOPE}`,
      reauthorizationRequired: false,
      connectedAt: '2026-07-01T00:00:00.000Z'
    }
  ];
  const posts = [];
  const batchRecords = new Map();
  const calls = { add: [], batchSourceSchedule: [], approve: [], deletePost: [] };
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
    async getYouTubeAccounts(userId) { return userId === 'owner' ? youtubeAccounts : []; },
    async getYouTubeAccount(userId, channelId) {
      return userId === 'owner' ? (youtubeAccounts.find((a) => a.accountId === channelId) || null) : null;
    },
    async getPosts(userId, accountId) {
      return userId === 'owner' ? posts.filter((post) => !accountId || post.accountId === accountId) : [];
    },
    async getPost(userId, id, accountId) {
      if (userId !== 'owner') return null;
      return posts.find((post) => post.id === id && (!accountId || post.accountId === accountId)) || null;
    },
    async addUploadedPosts(userId, files, defaults) {
      if (failSchedulePostForProvider && defaults.provider === failSchedulePostForProvider) {
        throw new Error(`simulated failure creating ${defaults.provider} posts`);
      }
      // Mirrors the real storage.addUploadedPosts contract: `defaults.accounts`
      // (plural) carries every selected target account for this provider;
      // `accountId` alone is only the legacy single-account fallback.
      const targets = Array.isArray(defaults.accounts) && defaults.accounts.length > 0
        ? defaults.accounts
        : [{ accountId: defaults.accountId, tiktokOpenId: defaults.tiktokOpenId, username: defaults.username, soundMode: defaults.soundMode }];
      calls.add.push({ userId, provider: defaults.provider, accountIds: targets.map((t) => t.accountId), soundModes: targets.map((t) => t.soundMode), files });
      const sources = Array.isArray(files) && files.length > 0 ? files : [null];
      const created = [];
      for (const target of targets) {
        for (let sourceIdx = 0; sourceIdx < sources.length; sourceIdx += 1) {
          const file = sources[sourceIdx];
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
              mediaType: 'video',
              mediaUrl: `https://cdn.example.com/${target.accountId}/${file ? file.originalname : 'url'}`,
              cloudinaryPublicId: `cld-${target.accountId}-${file ? file.originalname : 'url'}`,
              caption: defaults.caption,
              hashtags: defaults.hashtags,
              soundMode: target.soundMode,
              // Mirrors the real contract: bounded provider metadata is stored
              // as supplied (storage locks YouTube privacy/notify at write time).
              providerMetadata: defaults.providerMetadata || null,
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
    async applyBatchSourceSchedule(userId, created, plan) {
      calls.batchSourceSchedule.push({ userId, created, plan });
      const slotsByIndex = new Map((plan.slots || []).map((slot) => [slot.index, slot]));
      let count = 0;
      created.forEach((created_post) => {
        const stored = posts.find((post) => post.id === created_post.id);
        const slot = slotsByIndex.get(stored.sourceIndex);
        if (!slot) throw new Error(`No schedule slot found for source video index ${stored.sourceIndex}.`);
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
        ...allowed
      } = patch;
      Object.assign(post, allowed);
      if ('scheduledAt' in allowed) post.status = allowed.scheduledAt ? 'scheduled' : 'pending';
      return post;
    },
    async approvePost(userId, id, { approvedBy }, accountId) {
      calls.approve.push({ userId, id, approvedBy, accountId });
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
      calls.deletePost.push({ userId, id, accountId });
      const post = posts.find((item) => item.id === id && item.userId === userId && (!accountId || item.accountId === accountId));
      if (!post) return false;
      if (!['pending', 'scheduled', 'ready', 'failed'].includes(post.status)) {
        const error = new Error('This queue state cannot be deleted safely.');
        error.status = 409;
        error.code = 'queue_transition_blocked';
        throw error;
      }
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
    async incrementBatchDeletedCount(userId, batchId, delta) {
      const record = batchRecords.get(batchId);
      if (!record || record.userId !== userId || !Number.isInteger(delta) || delta <= 0) return record ? { ...record } : null;
      record.deletedCount = Number(record.deletedCount || 0) + delta;
      return { ...record };
    },
    async deleteBatchRecord(userId, batchId) {
      const record = batchRecords.get(batchId);
      if (!record || record.userId !== userId) return false;
      batchRecords.delete(batchId);
      return true;
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
        post.preparation = { ...post.preparation, status: 'succeeded', leaseAt: null, provider: result.provider || '', fallbackUsed: false, error: '' };
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
  const autoCaption = {
    async analyzeVideoForCaption(videoPath, draft, options) {
      return { caption: `Generated for ${options.filename}`, hashtags: '#auto', provider: 'fake-ai', fallbackUsed: false };
    }
  };
  const batchService = createBatchService({
    config: TEST_BATCH_CONFIG, storage, autoCaption, applicationService,
    downloadMedia: async () => ({ bytes: 1 }), now: () => now, logger: { warn() {} }
  });

  return {
    posts, calls, batchRecords, tiktokAccounts, youtubeAccounts,
    applicationService, batchService,
    setNow(value) { now = Date.parse(value); },
    get nowMs() { return now; }
  };
}

function websiteContext(overrides = {}) {
  return createExecutionContext({ userId: 'owner', actorId: 'admin:owner', source: 'website', ...overrides });
}
function approverContext() {
  return websiteContext({ approval: { approvedBy: 'admin:owner' } });
}

const FANOUT_INTAKE = {
  scheduleMode: 'interval',
  startDate: '2026-07-11',
  startTime: '09:00',
  timezoneOffsetMinutes: 0,
  staggerMinutes: 60,
  intakeKey: 'fanout-1'
};

test('1 video x 2 accounts = 2 canonical posts, sharing one synchronized slot', async () => {
  const world = makeWorld();
  const result = await world.batchService.createBatch(websiteContext(), {
    ...FANOUT_INTAKE,
    destinations: [
      { provider: 'tiktok', accountId: 'account-a' },
      { provider: 'tiktok', accountId: 'account-b' }
    ],
    files: [uploadFile('a.mp4')]
  });
  assert.equal(result.items.length, 2);
  assert.equal(result.batch.itemCount, 2);
  const scheduledTimes = new Set(result.items.map((item) => item.scheduledAt));
  assert.equal(scheduledTimes.size, 1, 'both destination copies of the same video share one slot');
  assert.deepEqual(new Set(result.items.map((item) => item.accountId)), new Set(['account-a', 'account-b']));
  assert.deepEqual(new Set(result.items.map((item) => item.sourceIndex)), new Set([0]));
});

test('N videos x M accounts = N x M posts, each an independent canonical copy', async () => {
  const world = makeWorld();
  const result = await world.batchService.createBatch(websiteContext(), {
    ...FANOUT_INTAKE,
    destinations: [
      { provider: 'tiktok', accountId: 'account-a' },
      { provider: 'tiktok', accountId: 'account-b' }
    ],
    files: [uploadFile('a.mp4'), uploadFile('b.mp4')]
  });
  assert.equal(result.items.length, 4, '2 videos x 2 destinations = 4 posts');
  assert.equal(result.batch.itemCount, 4);
  assert.equal(result.batch.videoCount, 2);
  assert.equal(result.batch.destinationCount, 2);

  // Every destination copy is a distinct canonical post with its own media.
  const mediaUrls = new Set(result.items.map((item) => item.mediaUrl));
  assert.equal(mediaUrls.size, 4, 'every destination copy has its own independent media asset');

  // Copies of the same source video share a slot; different videos do not.
  const bySource = { 0: [], 1: [] };
  result.items.forEach((item) => bySource[item.sourceIndex].push(item.scheduledAt));
  assert.equal(new Set(bySource[0]).size, 1);
  assert.equal(new Set(bySource[1]).size, 1);
  assert.notEqual(bySource[0][0], bySource[1][0]);
});

test('a disconnected/unknown destination is rejected before any post is created', async () => {
  const world = makeWorld();
  await assert.rejects(
    world.batchService.createBatch(websiteContext(), {
      ...FANOUT_INTAKE,
      destinations: [
        { provider: 'tiktok', accountId: 'account-a' },
        { provider: 'tiktok', accountId: 'account-does-not-exist' }
      ],
      files: [uploadFile('a.mp4')]
    }),
    /not connected and publishing-ready/
  );
  assert.equal(world.posts.length, 0, 'no partial creation for a rejected destination list');
});

// YouTube's substantive rule is unchanged: a title must be HUMAN-ENTERED, never
// derived from a caption. What changed is only when it can be supplied — the
// canonical composer collects it at intake. These three cases pin the whole
// rule, including the ambiguity a single title would create across many videos.
test('YouTube at intake is refused without a human-entered title', async () => {
  const world = makeWorld();
  await assert.rejects(
    world.batchService.createBatch(websiteContext(), {
      ...FANOUT_INTAKE,
      destinations: [
        { provider: 'tiktok', accountId: 'account-a' },
        { provider: 'youtube', accountId: 'UC-chanter' }
      ],
      files: [uploadFile('a.mp4')]
    }),
    (error) => {
      assert.equal(error.code, 'provider_not_batchable');
      assert.match(error.message, /requires a human-entered title/);
      return true;
    }
  );
  assert.equal(world.posts.length, 0, 'nothing durable is created by the refusal');

  // A blank/whitespace title is not a title.
  await assert.rejects(
    world.batchService.createBatch(websiteContext(), {
      ...FANOUT_INTAKE,
      destinations: [{ provider: 'youtube', accountId: 'UC-chanter' }],
      youtube: { title: '   ' },
      files: [uploadFile('a.mp4')]
    }),
    /requires a human-entered title/
  );
  assert.equal(world.posts.length, 0);
});

test('one YouTube title may not silently describe several videos', async () => {
  const world = makeWorld();
  await assert.rejects(
    world.batchService.createBatch(websiteContext(), {
      ...FANOUT_INTAKE,
      destinations: [{ provider: 'youtube', accountId: 'UC-chanter' }],
      youtube: { title: 'One title', description: 'd' },
      files: [uploadFile('a.mp4'), uploadFile('b.mp4')]
    }),
    (error) => {
      assert.equal(error.code, 'provider_title_ambiguous');
      return true;
    }
  );
  assert.equal(world.posts.length, 0);
});

test('YouTube at intake succeeds with a typed title and carries it to the draft', async () => {
  const world = makeWorld();
  const result = await world.batchService.createBatch(websiteContext(), {
    ...FANOUT_INTAKE,
    destinations: [{ provider: 'youtube', accountId: 'UC-chanter' }],
    youtube: { title: 'Composed title', description: 'Composed description' },
    files: [uploadFile('a.mp4')]
  });

  assert.equal(result.items.length, 1);
  const item = result.items[0];
  assert.equal(item.provider, 'youtube');
  assert.equal(item.providerMetadata.youtube.title, 'Composed title');
  assert.equal(item.providerMetadata.youtube.description, 'Composed description');
  // The title is never taken from the caption.
  assert.notEqual(item.providerMetadata.youtube.title, item.caption);
  // Still a draft behind the human approval gate.
  assert.notEqual(item.approved, true);
});

test('idempotent repeated fan-out intake: same intakeKey never multiplies destination copies', async () => {
  const world = makeWorld();
  const input = {
    ...FANOUT_INTAKE,
    destinations: [
      { provider: 'tiktok', accountId: 'account-a' },
      { provider: 'tiktok', accountId: 'account-b' }
    ],
    files: [uploadFile('a.mp4'), uploadFile('b.mp4')]
  };
  const first = await world.batchService.createBatch(websiteContext(), input);
  const replay = await world.batchService.createBatch(websiteContext(), input);
  assert.equal(replay.replayed, true);
  assert.equal(replay.batch.batchId, first.batch.batchId);
  assert.equal(world.posts.length, 4, 'exactly N x M posts, never duplicated by the retry');
});

test('creation failure is compensated: the reserved batch record does not survive, retry starts clean', async () => {
  const world = makeWorld({ failSchedulePostForProvider: 'tiktok' });
  const input = {
    ...FANOUT_INTAKE,
    intakeKey: 'fanout-partial-1',
    destinations: [
      { provider: 'tiktok', accountId: 'account-a' },
      { provider: 'tiktok', accountId: 'account-b' }
    ],
    files: [uploadFile('a.mp4')]
  };
  await assert.rejects(world.batchService.createBatch(websiteContext(), input));
  assert.equal(world.posts.length, 0, 'nothing was created');
  assert.equal(world.batchRecords.size, 0, 'the reserved batch record was removed, not left half-created');

  // A retry (schedulePost failure lifted) with the SAME intakeKey must
  // succeed cleanly rather than being blocked by leftover state.
  const world2 = makeWorld();
  const retryResult = await world2.batchService.createBatch(websiteContext(), input);
  assert.equal(retryResult.replayed, false);
  assert.equal(retryResult.items.length, 2);
});

test('independent edit: editing one destination copy never touches its sibling', async () => {
  const world = makeWorld();
  const result = await world.batchService.createBatch(websiteContext(), {
    ...FANOUT_INTAKE,
    destinations: [
      { provider: 'tiktok', accountId: 'account-a' },
      { provider: 'tiktok', accountId: 'account-b' }
    ],
    files: [uploadFile('a.mp4')]
  });
  const [copyA, copyB] = result.items;
  const originalCaptionB = copyB.caption;
  await world.batchService.updateItem(websiteContext(), result.batch.batchId, copyA.id, {
    caption: 'Only copy A changes'
  });
  const view = await world.batchService.getBatchView(websiteContext(), result.batch.batchId);
  const freshA = view.items.find((item) => item.id === copyA.id);
  const freshB = view.items.find((item) => item.id === copyB.id);
  assert.equal(freshA.caption, 'Only copy A changes');
  assert.equal(freshB.caption, originalCaptionB, 'sibling caption untouched');
});

test('independent approval + independent failure: accepting together keeps synchronized slots, a disconnected sibling blocks only itself', async () => {
  const world = makeWorld();
  const result = await world.batchService.createBatch(websiteContext(), {
    ...FANOUT_INTAKE,
    destinations: [
      { provider: 'tiktok', accountId: 'account-a' },
      { provider: 'tiktok', accountId: 'account-b' }
    ],
    files: [uploadFile('a.mp4')]
  });
  await world.batchService.startPreparation(websiteContext(), result.batch.batchId);
  const [copyA, copyB] = result.items;

  // Disconnect account-b entirely between intake and acceptance.
  world.tiktokAccounts.find((a) => a.accountId === 'account-b').connected = false;

  const outcome = await world.batchService.acceptItems(approverContext(), result.batch.batchId, { postIds: 'all' });
  assert.equal(outcome.accepted.length, 1);
  assert.equal(outcome.accepted[0].id, copyA.id);
  assert.equal(outcome.failed.length, 1);
  assert.equal(outcome.failed[0].id, copyB.id);
  assert.match(outcome.failed[0].reason, /destination channel is no longer available/);

  const view = await world.batchService.getBatchView(websiteContext(), result.batch.batchId);
  assert.equal(view.items.find((item) => item.id === copyA.id).approved, true);
  assert.equal(view.items.find((item) => item.id === copyB.id).approved, false);
});

test('two accounts sharing one canonical asset persist independent sound modes', async () => {
  const world = makeWorld();
  const result = await world.batchService.createBatch(websiteContext(), {
    ...FANOUT_INTAKE,
    intakeKey: 'fanout-sound-1',
    destinations: [
      { provider: 'tiktok', accountId: 'account-a', soundMode: 'mute' },
      { provider: 'tiktok', accountId: 'account-b', soundMode: 'tiktok_recommended' }
    ],
    files: [uploadFile('a.mp4')]
  });
  assert.equal(result.items.length, 2);

  const byAccount = new Map(result.items.map((item) => [item.accountId, item]));
  // Same source video (one sourceIndex, one synchronized slot) but each
  // destination keeps its OWN sound mode.
  assert.equal(new Set(result.items.map((item) => item.sourceIndex)).size, 1);
  assert.equal(byAccount.get('account-a').soundMode, 'mute');
  assert.equal(byAccount.get('account-b').soundMode, 'tiktok_recommended');
});

test('fan-out preserves each destination sound mode independently across N x M', async () => {
  const world = makeWorld();
  const result = await world.batchService.createBatch(websiteContext(), {
    ...FANOUT_INTAKE,
    intakeKey: 'fanout-sound-2',
    destinations: [
      { provider: 'tiktok', accountId: 'account-a', soundMode: 'keep_original' },
      { provider: 'tiktok', accountId: 'account-b', soundMode: 'mute' }
    ],
    files: [uploadFile('a.mp4'), uploadFile('b.mp4')]
  });
  assert.equal(result.items.length, 4);

  // Every copy for account-a keeps keep_original; every copy for account-b
  // keeps mute — regardless of which source video it came from.
  for (const item of result.items) {
    const expected = item.accountId === 'account-a' ? 'keep_original' : 'mute';
    assert.equal(item.soundMode, expected, `${item.accountId} copy should stay ${expected}`);
  }

  // An unspecified destination defaults safely to keep_original.
  const world2 = makeWorld();
  const defaulted = await world2.batchService.createBatch(websiteContext(), {
    ...FANOUT_INTAKE,
    intakeKey: 'fanout-sound-default',
    destinations: [{ provider: 'tiktok', accountId: 'account-a' }],
    files: [uploadFile('a.mp4')]
  });
  assert.equal(defaulted.items[0].soundMode, 'keep_original');
});

test('independent delete: deleting one destination copy leaves its sibling intact with its own media', async () => {
  const world = makeWorld();
  const result = await world.batchService.createBatch(websiteContext(), {
    ...FANOUT_INTAKE,
    destinations: [
      { provider: 'tiktok', accountId: 'account-a' },
      { provider: 'tiktok', accountId: 'account-b' }
    ],
    files: [uploadFile('a.mp4')]
  });
  const [copyA, copyB] = result.items;
  await world.batchService.deleteItem(websiteContext(), result.batch.batchId, copyA.id);

  const view = await world.batchService.getBatchView(websiteContext(), result.batch.batchId);
  assert.equal(view.items.length, 1);
  assert.equal(view.items[0].id, copyB.id);
  assert.equal(view.items[0].mediaUrl.includes('account-b'), true, 'sibling media untouched');
  assert.equal(view.batch.itemCount, 1);
  assert.equal(view.batch.deletedCount, 1);
});
