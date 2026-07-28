'use strict';

process.env.ADMIN_PASSWORD = 'platform-mission-admin-password';
process.env.ADMIN_SESSION_SECRET = 'platform-mission-session-secret';
process.env.APP_DEFAULT_USER_ID = 'owner';
process.env.PLATFORM_CANONICAL_EXECUTION_ENABLED = 'false';

// Platform batch slice: intake -> persisted batch/items -> bounded-parallel
// resumable preparation -> review edits -> staggered human acceptance.
// The REAL application service (staggered schedule mode included) runs over
// an in-memory storage fake; only Firestore, Cloudinary, FFmpeg, and AI
// providers are faked. The transactional storage functions themselves are
// covered separately in batch-storage.test.js.

const assert = require('node:assert/strict');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const express = require('express');
const { chromium } = require('playwright-core');
const { createCommercialFixture } = require('./helpers/commercial-fixture');
const mediaPolicy = require('../src/mediaPolicy');
const { postFromDoc } = require('../src/postsMapper');
const { computeBatchStaggerPlan } = require('../src/maxScheduler');
const {
  createAutoPosterApplicationService,
  createExecutionContext
} = require('../src/autoposterApplicationService');
const { createBatchService, BatchServiceError } = require('../src/batchService');

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
  return {
    path: `/tmp/${name}`,
    originalname: name,
    filename: name,
    mimetype: 'video/mp4',
    size: 1024
  };
}

function makeWorld({ nowMs = BASE_NOW } = {}) {
  // Acceptance re-validates each item's destination, so the fixture account
  // must be genuinely publishing-ready (token + video.publish scope).
  const accounts = [
    {
      accountId: 'account-a',
      open_id: 'open-a',
      userId: 'owner',
      platform: 'tiktok',
      username: 'creator_a',
      connected: true,
      access_token: 'tt-access',
      refresh_token: 'tt-refresh',
      scope: 'user.info.basic,video.publish'
    }
  ];
  const posts = [];
  const batchRecords = new Map();
  const calls = { add: [], staggered: [], batchSourceSchedule: [], approve: [], update: [] };
  let sequence = 0;
  let now = nowMs;

  const storage = {
    async getCanonicalTikTokAccount(userId, accountId) {
      if (userId !== 'owner') return null;
      return accounts.find((account) => account.accountId === accountId) || null;
    },
    async getCanonicalTikTokAccounts(userId) {
      return userId === 'owner' ? accounts : [];
    },
    async getTikTokAccount(userId, accountId) {
      if (userId !== 'owner') return null;
      return accounts.find((account) => account.accountId === accountId) || null;
    },
    async getPosts(userId, accountId) {
      if (userId !== 'owner') return [];
      return posts.filter((post) => !accountId || post.accountId === accountId);
    },
    async getPost(userId, id, accountId) {
      if (userId !== 'owner') return null;
      return posts.find((post) => post.id === id && (!accountId || post.accountId === accountId)) || null;
    },
    async addUploadedPosts(userId, files, defaults) {
      calls.add.push({ userId, files, defaults });
      const sources = Array.isArray(files) && files.length > 0 ? files : [null];
      return sources.map((file, index) => {
        const post = postFromDoc({
          id: `post-${++sequence}`,
          data: () => ({
            userId,
            workspaceId: defaults.workspaceId,
            platform: defaults.provider,
            provider: defaults.provider,
            accountId: defaults.accountId,
            tiktokOpenId: defaults.tiktokOpenId,
            username: defaults.username,
            originalName: file ? file.originalname : '',
            fileName: file ? file.originalname : '',
            mediaType: 'video',
            mediaUrl: `https://cdn.example.com/${file ? file.originalname : 'url'}`,
            caption: defaults.caption,
            hashtags: defaults.hashtags,
            scheduledAt: null,
            status: 'pending',
            approvedAt: null,
            approvedBy: null,
            createdAt: { toDate: () => new Date(now) },
            updatedAt: { toDate: () => new Date(now) },
            batchId: defaults.batchId || '',
            batchOrder: defaults.batchId ? index : null,
            sourceIndex: defaults.batchId ? index : null,
            preparation: defaults.batchId
              ? { status: 'pending', attempts: 0, leaseAt: null, finishedAt: null, provider: '', fallbackUsed: false, error: '' }
              : null
          })
        });
        posts.push(post);
        return post;
      });
    },
    async applyStaggeredSchedule(userId, created, plan) {
      calls.staggered.push({ userId, created, plan });
      created.forEach((created_post, index) => {
        const slot = plan.slots[index];
        const stored = posts.find((post) => post.id === created_post.id);
        stored.scheduledAt = slot.scheduledAt;
        stored.status = 'scheduled';
        stored.channelOffsetMinutes = slot.offsetMinutes;
        stored.campaignStartAt = plan.baseAt;
      });
      return created.length;
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
    async updatePost(userId, id, patch, accountId, historyEvent) {
      calls.update.push({ userId, id, patch, accountId, historyEvent });
      const post = posts.find((item) => item.id === id && (!accountId || item.accountId === accountId));
      if (!post) return null;
      Object.assign(post, patch);
      if ('scheduledAt' in patch) post.status = patch.scheduledAt ? 'scheduled' : 'pending';
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

    // Batch record CRUD (in-memory mirror of the Firestore-backed functions).
    async createBatchRecord(record) {
      if (batchRecords.has(record.batchId)) {
        const error = new Error('already exists');
        error.code = 6;
        throw error;
      }
      const stored = {
        ...record,
        preparedCount: 0,
        failedCount: 0,
        acceptedCount: 0,
        createdAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString()
      };
      batchRecords.set(record.batchId, stored);
      return { ...stored };
    },
    async getBatchRecord(userId, batchId) {
      const record = batchRecords.get(batchId);
      if (!record || record.userId !== userId) return null;
      return { ...record };
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
      record.updatedAt = new Date(now).toISOString();
      return { ...record };
    },
    async deleteBatchRecord(userId, batchId) {
      const record = batchRecords.get(batchId);
      if (!record || record.userId !== userId) return false;
      batchRecords.delete(batchId);
      return true;
    },
    async getBatchPosts(userId, batchId) {
      return posts
        .filter((post) => post.userId === userId && post.batchId === batchId)
        .sort((a, b) => (a.batchOrder ?? 0) - (b.batchOrder ?? 0));
    },
    async claimBatchItemPreparation(userId, postId, options) {
      const post = posts.find((item) => item.id === postId && item.userId === userId);
      if (!post) return { outcome: 'not_found' };
      if (!post.batchId) return { outcome: 'not_batch_item' };
      if (!['pending', 'scheduled'].includes(post.status)) return { outcome: 'not_preparable', post };
      const preparation = post.preparation || {};
      const attempts = Number(preparation.attempts || 0);
      if (preparation.status === 'succeeded') return { outcome: 'already_succeeded', post };
      if (preparation.status === 'running') {
        const leaseAtMs = preparation.leaseAt ? Date.parse(preparation.leaseAt) : 0;
        if (leaseAtMs && Date.now() - leaseAtMs < options.leaseMs) {
          return { outcome: 'in_progress', post };
        }
      }
      if (attempts >= options.maxAttempts) return { outcome: 'attempts_exhausted', post };
      post.preparation = {
        ...preparation,
        status: 'running',
        attempts: attempts + 1,
        leaseAt: new Date(now).toISOString(),
        error: ''
      };
      return { outcome: 'claimed', post: { ...post }, attempt: attempts + 1 };
    },
    async recordBatchItemPreparationResult(userId, postId, result) {
      const post = posts.find((item) => item.id === postId && item.userId === userId);
      if (!post) return null;
      const preparation = post.preparation || {};
      if (preparation.status !== 'running') return null;
      if (result.ok) {
        if (result.caption && !String(post.caption || '').trim()) post.caption = result.caption;
        if (result.hashtags && !String(post.hashtags || '').trim()) post.hashtags = result.hashtags;
        post.preparation = {
          ...preparation,
          status: 'succeeded',
          leaseAt: null,
          finishedAt: new Date(now).toISOString(),
          provider: result.provider || '',
          fallbackUsed: Boolean(result.fallbackUsed),
          error: ''
        };
      } else {
        post.preparation = {
          ...preparation,
          status: 'failed',
          leaseAt: null,
          finishedAt: new Date(now).toISOString(),
          error: String(result.error || 'Preparation failed.')
        };
      }
      return { ok: Boolean(result.ok) };
    }
  };

  const commercial = createCommercialFixture(storage, { planId: 'legacy_full_access' });
  const applicationService = createAutoPosterApplicationService({
    storage,
    mediaPolicy,
    commercialService: commercial,
    now: () => now
  });

  // Preparation fakes: no disk, no FFmpeg, no AI provider network.
  let concurrent = 0;
  let maxConcurrent = 0;
  const failFor = new Set();
  const autoCaption = {
    async analyzeVideoForCaption(videoPath, draft, options) {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 15));
      concurrent -= 1;
      if (failFor.has(options.filename)) {
        throw new Error(`analysis failed for ${options.filename}`);
      }
      return {
        caption: `Generated caption for ${options.filename}`,
        hashtags: '#chanter #auto',
        provider: 'fake-ai',
        fallbackUsed: false
      };
    }
  };
  const downloadCalls = [];
  const downloadMedia = async (mediaUrl, options) => {
    downloadCalls.push({ mediaUrl, targetPath: options.targetPath });
    return { bytes: 10 };
  };

  const batchService = createBatchService({
    config: TEST_BATCH_CONFIG,
    storage,
    autoCaption,
    applicationService,
    downloadMedia,
    now: () => now,
    logger: { warn() {} }
  });

  return {
    accounts,
    posts,
    calls,
    batchRecords,
    storage,
    applicationService,
    batchService,
    downloadCalls,
    failFor,
    stats: { get maxConcurrent() { return maxConcurrent; } },
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

const INTAKE_DEFAULTS = {
  destinations: [{ provider: 'tiktok', accountId: 'account-a' }],
  scheduleMode: 'interval',
  startDate: '2026-07-11',
  startTime: '09:00',
  timezoneOffsetMinutes: 0,
  staggerMinutes: 30,
  intakeKey: 'intake-1'
};

// ── Pure stagger plan ───────────────────────────────────────────────────────

test('computeBatchStaggerPlan staggers items on one channel and rejects multi-channel input', () => {
  const plan = computeBatchStaggerPlan({
    startDate: '2026-07-11',
    startTime: '09:00',
    timezoneOffsetMinutes: 0,
    staggerMinutes: 20,
    sourceCount: 3,
    channels: [{ accountId: 'account-a', connected: true }]
  });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.slots.map((slot) => slot.scheduledAt), [
    '2026-07-11T09:00:00.000Z',
    '2026-07-11T09:20:00.000Z',
    '2026-07-11T09:40:00.000Z'
  ]);
  assert.equal(plan.jobCount, 3);

  const multi = computeBatchStaggerPlan({
    startDate: '2026-07-11',
    startTime: '09:00',
    timezoneOffsetMinutes: 0,
    sourceCount: 2,
    channels: [{ accountId: 'a' }, { accountId: 'b' }]
  });
  assert.equal(multi.ok, false);
  assert.match(multi.reason, /exactly one publishing channel/);

  const badStagger = computeBatchStaggerPlan({
    startDate: '2026-07-11',
    startTime: '09:00',
    timezoneOffsetMinutes: 0,
    staggerMinutes: 0,
    sourceCount: 2,
    channels: [{ accountId: 'a' }]
  });
  assert.equal(badStagger.ok, false);
});

// ── Intake ─────────────────────────────────────────────────────────────────

test('batch intake persists batch + items with staggered future times, all unapproved drafts', async () => {
  const world = makeWorld();
  const result = await world.batchService.createBatch(websiteContext(), {
    ...INTAKE_DEFAULTS,
    files: [uploadFile('a.mp4'), uploadFile('b.mp4'), uploadFile('c.mp4')]
  });

  assert.equal(result.replayed, false);
  assert.equal(result.batch.itemCount, 3);
  assert.equal(result.items.length, 3);
  assert.deepEqual(result.items.map((item) => item.scheduledAt), [
    '2026-07-11T09:00:00.000Z',
    '2026-07-11T09:30:00.000Z',
    '2026-07-11T10:00:00.000Z'
  ]);
  for (const item of result.items) {
    assert.equal(item.approved, false, 'intake must never approve');
    assert.equal(item.status, 'scheduled');
    assert.equal(item.batchId, result.batch.batchId);
  }
  assert.equal(world.calls.add.length, 1);
  assert.equal(world.calls.add[0].defaults.batchId, result.batch.batchId);
  // V1.2: single-destination intake now goes through the channel-agnostic
  // batch_sync schedule application (applyBatchSourceSchedule), not the
  // single-channel 'staggered' mode it replaced.
  assert.equal(world.calls.staggered.length, 0);
  assert.equal(world.calls.batchSourceSchedule.length, 1);

  // Preparation kicked off automatically; wait for it to settle.
  await world.batchService.startPreparation(websiteContext(), result.batch.batchId);
  const view = await world.batchService.getBatchView(websiteContext(), result.batch.batchId);
  assert.equal(view.batch.status, 'ready');
  for (const item of view.items) {
    assert.equal(item.preparation.status, 'succeeded');
    assert.match(item.caption, /^Generated caption for/);
    assert.equal(item.approved, false, 'preparation must never approve');
  }
});

test('exact intake replay returns the existing batch without creating duplicates', async () => {
  const world = makeWorld();
  const first = await world.batchService.createBatch(websiteContext(), {
    ...INTAKE_DEFAULTS,
    files: [uploadFile('a.mp4')]
  });
  await world.batchService.startPreparation(websiteContext(), first.batch.batchId);

  const replay = await world.batchService.createBatch(websiteContext(), {
    ...INTAKE_DEFAULTS,
    files: [uploadFile('a.mp4')]
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.batch.batchId, first.batch.batchId);
  assert.equal(world.calls.add.length, 1, 'no second queue creation');
  assert.equal(world.posts.length, 1);
});

test('intake validation fails closed: no files, bad stagger, unavailable destination', async () => {
  const world = makeWorld();
  await assert.rejects(
    world.batchService.createBatch(websiteContext(), { ...INTAKE_DEFAULTS, files: [] }),
    BatchServiceError
  );
  await assert.rejects(
    world.batchService.createBatch(websiteContext(), {
      ...INTAKE_DEFAULTS,
      files: [uploadFile('a.mp4')],
      staggerMinutes: 1
    }),
    /stagger interval/
  );
  // Fan-out (V1.2) validates every requested destination against connected,
  // publishing-ready accounts before any upload/creation work — nothing is
  // invented for a provider/account this fixture never connected.
  await assert.rejects(
    world.batchService.createBatch(websiteContext(), {
      ...INTAKE_DEFAULTS,
      files: [uploadFile('a.mp4')],
      destinations: [{ provider: 'tiktok', accountId: 'account-does-not-exist' }]
    }),
    /not connected and publishing-ready/
  );
  assert.equal(world.posts.length, 0);
});

// ── Preparation ────────────────────────────────────────────────────────────

test('preparation runs with bounded parallelism', async () => {
  const world = makeWorld();
  const result = await world.batchService.createBatch(websiteContext(), {
    ...INTAKE_DEFAULTS,
    files: ['a', 'b', 'c', 'd', 'e'].map((name) => uploadFile(`${name}.mp4`))
  });
  await world.batchService.startPreparation(websiteContext(), result.batch.batchId);
  assert.ok(world.stats.maxConcurrent <= 2, `expected concurrency <= 2, saw ${world.stats.maxConcurrent}`);
  assert.equal(world.downloadCalls.length, 5, 'every item downloaded exactly once');
});

test('a failed item does not corrupt the batch; the rest prepare and stay acceptable', async () => {
  const world = makeWorld();
  world.failFor.add('bad.mp4');
  const result = await world.batchService.createBatch(websiteContext(), {
    ...INTAKE_DEFAULTS,
    files: [uploadFile('good1.mp4'), uploadFile('bad.mp4'), uploadFile('good2.mp4')]
  });
  await world.batchService.startPreparation(websiteContext(), result.batch.batchId);

  // The failed item is retried up to prepareMaxAttempts by later resumes.
  world.failFor.delete('never'); // keep failing 'bad.mp4'
  await world.batchService.resumePreparation(websiteContext(), result.batch.batchId);
  await world.batchService.startPreparation(websiteContext(), result.batch.batchId);

  const view = await world.batchService.getBatchView(websiteContext(), result.batch.batchId, { autoResume: false });
  const states = Object.fromEntries(view.items.map((item) => [item.originalName, item.preparation.status]));
  assert.equal(states['good1.mp4'], 'succeeded');
  assert.equal(states['good2.mp4'], 'succeeded');
  assert.equal(states['bad.mp4'], 'failed');
  assert.equal(view.batch.status, 'attention_required');

  const failedItem = view.items.find((item) => item.originalName === 'bad.mp4');
  assert.equal(failedItem.itemState, 'needs_attention');
  assert.match(failedItem.preparation.error, /analysis failed/);
  const goodItem = view.items.find((item) => item.originalName === 'good1.mp4');
  assert.equal(goodItem.readyToAccept, true);
});

test('preparation resumes after interruption: stale running lease is reclaimed and finished', async () => {
  const world = makeWorld();
  const result = await world.batchService.createBatch(websiteContext(), {
    ...INTAKE_DEFAULTS,
    files: [uploadFile('a.mp4'), uploadFile('b.mp4')]
  });
  await world.batchService.startPreparation(websiteContext(), result.batch.batchId);

  // Simulate a crash mid-preparation: durable state says one item is still
  // running with a stale lease and one is pending again.
  const [first, second] = world.posts;
  first.caption = '';
  first.preparation = {
    status: 'running',
    attempts: 1,
    leaseAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    finishedAt: null,
    provider: '',
    fallbackUsed: false,
    error: ''
  };
  second.caption = '';
  second.preparation = { status: 'pending', attempts: 0, leaseAt: null, finishedAt: null, provider: '', fallbackUsed: false, error: '' };

  await world.batchService.resumePreparation(websiteContext(), result.batch.batchId);
  await world.batchService.startPreparation(websiteContext(), result.batch.batchId);

  const view = await world.batchService.getBatchView(websiteContext(), result.batch.batchId, { autoResume: false });
  for (const item of view.items) {
    assert.equal(item.preparation.status, 'succeeded');
    assert.match(item.caption, /^Generated caption/);
  }
  assert.equal(view.batch.status, 'ready');
});

// ── Review: edit + accept ──────────────────────────────────────────────────

test('item edits persist independently and human edits win over preparation copy', async () => {
  const world = makeWorld();
  const result = await world.batchService.createBatch(websiteContext(), {
    ...INTAKE_DEFAULTS,
    files: [uploadFile('a.mp4'), uploadFile('b.mp4')]
  });
  await world.batchService.startPreparation(websiteContext(), result.batch.batchId);

  const view = await world.batchService.getBatchView(websiteContext(), result.batch.batchId);
  const target = view.items[0];
  const edited = await world.batchService.updateItem(websiteContext(), result.batch.batchId, target.id, {
    caption: 'Χειροκίνητη λεζάντα',
    hashtags: '#custom',
    scheduleInput: { value: '2026-07-12T18:30', timezoneOffsetMinutes: 0 }
  });
  assert.equal(edited.item.caption, 'Χειροκίνητη λεζάντα');
  assert.equal(edited.item.hashtags, '#custom');
  assert.equal(edited.item.scheduledAt, '2026-07-12T18:30:00.000Z');

  const after = await world.batchService.getBatchView(websiteContext(), result.batch.batchId);
  assert.equal(after.items[1].caption.startsWith('Generated caption'), true, 'other item untouched');

  await assert.rejects(
    world.batchService.updateItem(websiteContext(), result.batch.batchId, 'missing-post', { caption: 'x' }),
    /does not belong/
  );
});

test('acceptance requires an explicit human approver context', async () => {
  const world = makeWorld();
  const result = await world.batchService.createBatch(websiteContext(), {
    ...INTAKE_DEFAULTS,
    files: [uploadFile('a.mp4')]
  });
  await world.batchService.startPreparation(websiteContext(), result.batch.batchId);
  await assert.rejects(
    world.batchService.acceptItems(websiteContext(), result.batch.batchId, { postIds: 'all' }),
    /human approver/
  );
  assert.equal(world.calls.approve.length, 0);
});

test('accepting one item approves exactly that item and keeps its safe future slot', async () => {
  const world = makeWorld();
  const result = await world.batchService.createBatch(websiteContext(), {
    ...INTAKE_DEFAULTS,
    files: [uploadFile('a.mp4'), uploadFile('b.mp4')]
  });
  await world.batchService.startPreparation(websiteContext(), result.batch.batchId);
  const view = await world.batchService.getBatchView(websiteContext(), result.batch.batchId);

  const outcome = await world.batchService.acceptItems(approverContext(), result.batch.batchId, {
    postIds: [view.items[0].id]
  });
  assert.deepEqual(outcome.failed, []);
  assert.equal(outcome.accepted.length, 1);
  assert.equal(outcome.accepted[0].scheduledAt, '2026-07-11T09:00:00.000Z', 'future slot kept as proposed');

  const after = await world.batchService.getBatchView(websiteContext(), result.batch.batchId);
  assert.equal(after.items[0].approved, true);
  assert.equal(after.items[1].approved, false, 'sibling untouched');
  assert.equal(world.calls.approve.length, 1);
});

test('Accept All approves every ready item with staggered future times and never immediately', async () => {
  const world = makeWorld();
  const result = await world.batchService.createBatch(websiteContext(), {
    ...INTAKE_DEFAULTS,
    files: [uploadFile('a.mp4'), uploadFile('b.mp4'), uploadFile('c.mp4')]
  });
  await world.batchService.startPreparation(websiteContext(), result.batch.batchId);

  // Time passes: the original slots (07-11 09:00/09:30/10:00) are now in the
  // past. Acceptance must push everything to safe staggered future slots.
  world.setNow('2026-07-11T12:00:00.000Z');

  const outcome = await world.batchService.acceptItems(approverContext(), result.batch.batchId, { postIds: 'all' });
  assert.deepEqual(outcome.failed, []);
  assert.equal(outcome.accepted.length, 3);

  const bufferMs = 10 * 60_000;
  const staggerMs = 30 * 60_000;
  const times = outcome.accepted.map((item) => Date.parse(item.scheduledAt));
  for (const timeMs of times) {
    assert.ok(timeMs >= world.nowMs + bufferMs, 'every accepted slot is at least the safety buffer in the future');
  }
  for (let i = 1; i < times.length; i += 1) {
    assert.ok(times[i] - times[i - 1] >= staggerMs, 'accepted slots keep the stagger spacing');
  }

  const after = await world.batchService.getBatchView(websiteContext(), result.batch.batchId);
  assert.equal(after.batch.status, 'completed');
  for (const item of after.items) assert.equal(item.approved, true);

  // Accept All again: nothing left, nothing double-approved.
  const again = await world.batchService.acceptItems(approverContext(), result.batch.batchId, { postIds: 'all' });
  assert.equal(again.accepted.length, 0);
  assert.equal(world.calls.approve.length, 3);
});

test('an unready item (failed preparation, empty caption) cannot be accepted until fixed', async () => {
  const world = makeWorld();
  world.failFor.add('bad.mp4');
  const result = await world.batchService.createBatch(websiteContext(), {
    ...INTAKE_DEFAULTS,
    files: [uploadFile('bad.mp4')]
  });
  await world.batchService.startPreparation(websiteContext(), result.batch.batchId);

  const view = await world.batchService.getBatchView(websiteContext(), result.batch.batchId, { autoResume: false });
  assert.equal(view.items[0].readyToAccept, false);

  const refused = await world.batchService.acceptItems(approverContext(), result.batch.batchId, {
    postIds: [view.items[0].id]
  });
  assert.equal(refused.accepted.length, 0);
  assert.equal(refused.failed.length, 1);
  assert.match(refused.failed[0].reason, /not ready/);

  // Operator fixes it by hand; acceptance then succeeds.
  await world.batchService.updateItem(websiteContext(), result.batch.batchId, view.items[0].id, {
    caption: 'Manual rescue caption'
  });
  const accepted = await world.batchService.acceptItems(approverContext(), result.batch.batchId, {
    postIds: [view.items[0].id]
  });
  assert.equal(accepted.accepted.length, 1);
  assert.deepEqual(accepted.failed, []);
});

test('authenticated Platform HTTP mission persists through review, acceptance, replay, and reopen', async (t) => {
  const world = makeWorld();
  const batchServiceModule = require('../src/batchService');
  const auth = require('../src/auth');
  const delegatedMethods = [
    'createBatch',
    'getBatchView',
    'listBatches',
    'listDestinations',
    'listSeries',
    'getComposerCapabilities',
    'resumePreparation',
    'updateItem',
    'changeItemDestination',
    'acceptItems'
  ];
  const originals = Object.fromEntries(
    delegatedMethods.map((name) => [name, batchServiceModule[name]])
  );
  for (const name of delegatedMethods) {
    batchServiceModule[name] = (...args) => world.batchService[name](...args);
  }
  t.after(() => {
    for (const [name, implementation] of Object.entries(originals)) {
      batchServiceModule[name] = implementation;
    }
  });

  const platformRoutes = require('../src/platformRoutes');
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'src', 'views'));
  app.use(auth.attachUser);
  app.use(auth.csrfOriginCheck);
  app.use(platformRoutes);
  app.use((error, req, res, next) => {
    if (!error) {
      next();
      return;
    }
    res.status(error.status || 500).json({
      ok: false,
      code: error.code || 'mission_test_error',
      reason: error.message || 'Mission request failed.'
    });
  });
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const cookie = `${auth.ADMIN_SESSION_COOKIE}=${auth.createAdminSessionToken()}`;

  function missionForm({
    intakeKey = 'customer-mission-proof-1',
    accountId = 'account-a',
    fileNames = ['mission-a.mp4', 'mission-b.mp4']
  } = {}) {
    const form = new FormData();
    for (const fileName of fileNames) {
      form.append('videos', new Blob([`fixture:${fileName}`], { type: 'video/mp4' }), fileName);
    }
    form.append('destinations', JSON.stringify([{
      provider: 'tiktok',
      accountId,
      soundMode: 'keep_original'
    }]));
    form.append('caption', 'Customer mission caption');
    form.append('hashtags', '#chanter #mission');
    form.append('scheduleMode', 'interval');
    form.append('startDate', '2026-07-11');
    form.append('startTime', '09:00');
    form.append('timezoneName', 'UTC');
    form.append('timezoneOffsetMinutes', '0');
    form.append('intakeKey', intakeKey);
    form.append('userId', 'browser-spoofed-owner');
    form.append('workspaceId', 'browser-spoofed-workspace');
    form.append('status', 'posted');
    form.append('approved', 'true');
    return form;
  }

  async function missionRequest(route, {
    method = 'GET',
    body,
    authenticated = true,
    json = false
  } = {}) {
    const headers = { Accept: json ? 'application/json' : 'text/html' };
    if (authenticated) headers.Cookie = cookie;
    const permitsBody = method !== 'GET' && method !== 'HEAD';
    if (permitsBody) headers.Origin = baseUrl;
    if (json) headers['Content-Type'] = 'application/json';
    return fetch(`${baseUrl}${route}`, {
      method,
      headers,
      body: permitsBody ? (json ? JSON.stringify(body || {}) : body) : undefined,
      redirect: 'manual'
    });
  }

  const unauthenticated = await missionRequest('/platform/autoposter/compose', {
    authenticated: false
  });
  assert.equal(unauthenticated.status, 302);
  assert.match(unauthenticated.headers.get('location'), /^\/admin-login/);

  const composer = await missionRequest('/platform/autoposter/compose');
  assert.equal(composer.status, 200);
  const composerHtml = await composer.text();
  assert.match(composerHtml, /id="compose-form"/);
  assert.match(composerHtml, /data-account-id="account-a"/);
  assert.match(composerHtml, /window\.location\.assign/);

  const createdResponse = await missionRequest('/api/platform/batches', {
    method: 'POST',
    body: missionForm()
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  assert.equal(created.ok, true);
  assert.equal(created.replayed, false);
  const batchId = created.batch.batchId;
  assert.ok(batchId);
  assert.equal(world.posts.length, 2);
  assert.ok(world.posts.every((post) => post.userId === 'owner'));
  assert.ok(world.posts.every((post) => post.workspaceId !== 'browser-spoofed-workspace'));
  assert.ok(world.posts.every((post) => post.accountId === 'account-a'));
  assert.ok(world.posts.every((post) => post.caption === 'Customer mission caption'));
  assert.deepEqual(
    world.posts.map((post) => post.scheduledAt),
    ['2026-07-11T09:00:00.000Z', '2026-07-11T09:30:00.000Z']
  );
  assert.ok(world.posts.every((post) => post.status === 'scheduled'));
  assert.ok(world.posts.every((post) => post.approved !== true));

  const uploadedPaths = world.calls.add
    .flatMap((call) => call.files || [])
    .map((file) => file && file.path)
    .filter(Boolean);
  t.after(async () => {
    for (const filePath of uploadedPaths) {
      await fs.unlink(filePath).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  });

  const replayResponse = await missionRequest('/api/platform/batches', {
    method: 'POST',
    body: missionForm()
  });
  assert.equal(replayResponse.status, 200);
  const replay = await replayResponse.json();
  assert.equal(replay.replayed, true);
  assert.equal(replay.batch.batchId, batchId);
  assert.equal(world.posts.length, 2, 'duplicate submit creates no duplicate scheduled work');

  const reviewPage = await missionRequest(
    `/platform/autoposter/compose/${encodeURIComponent(batchId)}`
  );
  assert.equal(reviewPage.status, 200);
  assert.match(await reviewPage.text(), new RegExp(batchId));

  const preparedResponse = await missionRequest(
    `/api/platform/batches/${encodeURIComponent(batchId)}/prepare`,
    { method: 'POST', json: true }
  );
  assert.equal(preparedResponse.status, 200);
  const prepared = await preparedResponse.json();
  assert.equal(prepared.ok, true);

  const beforeAcceptResponse = await missionRequest(
    `/api/platform/batches/${encodeURIComponent(batchId)}`,
    { json: true }
  );
  const beforeAccept = await beforeAcceptResponse.json();
  assert.equal(beforeAccept.batch.status, 'ready');
  assert.equal(beforeAccept.items.length, 2);
  assert.ok(beforeAccept.items.every((item) => item.readyToAccept));
  assert.ok(beforeAccept.items.every((item) => item.caption === 'Customer mission caption'));

  const queueBefore = await missionRequest('/platform/autoposter/queue');
  assert.equal(queueBefore.status, 200);
  assert.match(await queueBefore.text(), new RegExp(batchId.slice(0, 8)));

  const acceptResponse = await missionRequest(
    `/api/platform/batches/${encodeURIComponent(batchId)}/accept-all`,
    { method: 'POST', json: true }
  );
  assert.equal(acceptResponse.status, 200);
  const accepted = await acceptResponse.json();
  assert.equal(accepted.ok, true);
  assert.equal(accepted.accepted.length, 2);
  assert.deepEqual(accepted.failed, []);

  const repeatedAcceptResponse = await missionRequest(
    `/api/platform/batches/${encodeURIComponent(batchId)}/accept-all`,
    { method: 'POST', json: true }
  );
  const repeatedAccept = await repeatedAcceptResponse.json();
  assert.equal(repeatedAccept.accepted.length, 0);
  assert.equal(world.calls.approve.length, 2);

  const reopenedResponse = await missionRequest(
    `/api/platform/batches/${encodeURIComponent(batchId)}`,
    { json: true }
  );
  const reopened = await reopenedResponse.json();
  assert.equal(reopened.batch.status, 'completed');
  assert.ok(reopened.items.every((item) => item.approved));
  assert.ok(reopened.items.every((item) => item.status === 'scheduled'));
  assert.ok(reopened.items.every((item) => item.caption === 'Customer mission caption'));

  const activity = await missionRequest('/platform/autoposter/activity');
  assert.equal(activity.status, 200);
  const activityHtml = await activity.text();
  assert.match(activityHtml, new RegExp(batchId.slice(0, 8)));
  assert.match(activityHtml, />Review completed</);

  const blockedResponse = await missionRequest('/api/platform/batches', {
    method: 'POST',
    body: missionForm({
      intakeKey: 'customer-mission-blocked',
      accountId: 'account-not-connected',
      fileNames: ['blocked.mp4']
    })
  });
  assert.equal(blockedResponse.status, 409);
  const blocked = await blockedResponse.json();
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'destination_unavailable');
  assert.match(blocked.reason, /not connected and publishing-ready/);
  assert.equal(world.posts.length, 2, 'blocked operation creates no partial scheduled work');

  assert.ok(world.posts.every((post) => post.status === 'scheduled'));
  assert.ok(world.posts.every((post) => post.postedAt == null));
  console.log('[PLATFORM_CUSTOMER_MISSION_EVIDENCE]', JSON.stringify({
    batchId,
    postIds: world.posts.map((post) => post.id),
    destinationIds: [...new Set(world.posts.map((post) => post.accountId))],
    scheduledAt: world.posts.map((post) => post.scheduledAt),
    captions: [...new Set(world.posts.map((post) => post.caption))],
    finalBatchStatus: reopened.batch.status,
    finalItemStatuses: reopened.items.map((item) => item.status),
    approvedCount: reopened.items.filter((item) => item.approved).length,
    duplicatePostCount: world.posts.length - 2,
    providerPublishCalls: 0
  }));
});

test('real Chrome customer mission persists, replays safely, and recovers from a disconnected destination', {
  timeout: 90_000
}, async (t) => {
  const chromeExecutable = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
  ].filter(Boolean).find((candidate) => fsSync.existsSync(candidate));
  assert.ok(chromeExecutable, 'A local Chrome/Chromium executable is required for the browser mission.');

  const world = makeWorld();
  const batchServiceModule = require('../src/batchService');
  const auth = require('../src/auth');
  const delegatedMethods = [
    'createBatch',
    'getBatchView',
    'listBatches',
    'listDestinations',
    'listSeries',
    'getComposerCapabilities',
    'resumePreparation',
    'updateItem',
    'changeItemDestination',
    'acceptItems'
  ];
  const originals = Object.fromEntries(
    delegatedMethods.map((name) => [name, batchServiceModule[name]])
  );
  for (const name of delegatedMethods) {
    batchServiceModule[name] = (...args) => world.batchService[name](...args);
  }
  t.after(() => {
    for (const [name, implementation] of Object.entries(originals)) {
      batchServiceModule[name] = implementation;
    }
  });

  const platformRoutes = require('../src/platformRoutes');
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'src', 'views'));
  app.use(auth.attachUser);
  app.use(auth.csrfOriginCheck);
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use(platformRoutes);
  app.use((error, req, res, next) => {
    if (!error) {
      next();
      return;
    }
    res.status(error.status || 500).json({
      ok: false,
      code: error.code || 'mission_browser_error',
      reason: error.message || 'Browser mission request failed.'
    });
  });
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authCookie = {
    name: auth.ADMIN_SESSION_COOKIE,
    value: auth.createAdminSessionToken(),
    url: baseUrl,
    httpOnly: true,
    sameSite: 'Lax'
  };

  const evidenceDir = path.join(__dirname, 'evidence', 'platform-customer-mission-p1');
  await fs.mkdir(evidenceDir, { recursive: true });
  const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chanter-platform-p1-'));
  const fixturePaths = [
    path.join(fixtureDir, 'browser-mission-a.mp4'),
    path.join(fixtureDir, 'browser-mission-b.mp4')
  ];
  await Promise.all(fixturePaths.map((filePath, index) =>
    fs.writeFile(filePath, Buffer.from(`deterministic-browser-video-${index + 1}`))
  ));
  t.after(async () => {
    for (const filePath of fixturePaths) {
      await fs.unlink(filePath).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
    await fs.rmdir(fixtureDir).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    const uploadedPaths = world.calls.add
      .flatMap((call) => call.files || [])
      .map((file) => file && file.path)
      .filter(Boolean);
    for (const filePath of uploadedPaths) {
      await fs.unlink(filePath).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  });

  const browser = await chromium.launch({
    executablePath: chromeExecutable,
    headless: true
  });
  t.after(() => browser.close());

  const consoleErrors = [];
  const requestFailures = [];
  const unexpectedHttpFailures = [];
  const externalRequests = [];
  function observePage(page, { allowDestinationUnavailable = false } = {}) {
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => consoleErrors.push(error.message));
    page.on('requestfailed', (request) => {
      requestFailures.push({
        url: request.url(),
        reason: request.failure() && request.failure().errorText
      });
    });
    page.on('response', (response) => {
      if (response.status() < 400) return;
      const expectedDestinationFailure =
        allowDestinationUnavailable &&
        response.status() === 409 &&
        response.url().endsWith('/api/platform/batches');
      if (!expectedDestinationFailure) {
        unexpectedHttpFailures.push({ url: response.url(), status: response.status() });
      }
    });
  }
  async function isolateNetwork(context) {
    await context.route(/^https?:\/\/.*/, async (route) => {
      const requestUrl = new URL(route.request().url());
      if (requestUrl.hostname === '127.0.0.1') {
        await route.continue();
        return;
      }
      if (requestUrl.hostname === 'cdn.example.com') {
        await route.fulfill({
          status: 200,
          contentType: 'video/mp4',
          body: Buffer.from('deterministic-local-media-response')
        });
        return;
      }
      externalRequests.push(route.request().url());
      await route.abort('blockedbyclient');
    });
  }
  async function createContext(intakeKey) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      timezoneId: 'UTC'
    });
    await context.addInitScript((stableIntakeKey) => {
      Object.defineProperty(window.crypto, 'randomUUID', {
        configurable: true,
        value: () => stableIntakeKey
      });
    }, intakeKey);
    await context.addCookies([authCookie]);
    await isolateNetwork(context);
    return context;
  }
  async function fillComposer(page, files = fixturePaths) {
    await page.goto(`${baseUrl}/platform/autoposter/compose`, { waitUntil: 'networkidle' });
    assert.equal(page.url(), `${baseUrl}/platform/autoposter/compose`);
    await page.setInputFiles('#file-input', files);
    await page.locator('#compose-workflow:not(.hidden)').waitFor();
    await page.fill('#startDate', '2026-08-01');
    await page.fill('#startTime', '09:00');
    await page.fill('#caption', 'Customer browser mission caption');
    await page.locator('#customer-options > summary').click();
    await page.fill('#hashtags', '#chanter #browser');
    await page.check('.destination-checkbox[data-account-id="account-a"]');
    await page.waitForFunction(() => !document.getElementById('submit-btn').disabled);
  }

  const context = await createContext('customer-browser-mission-proof-1');
  t.after(() => context.close());
  const page = await context.newPage();
  observePage(page);
  await fillComposer(page);
  await page.evaluate(() => {
    const spoofed = {
      userId: 'browser-spoofed-owner',
      workspaceId: 'browser-spoofed-workspace',
      status: 'posted',
      approved: 'true'
    };
    for (const [name, value] of Object.entries(spoofed)) {
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = name;
      input.value = value;
      document.getElementById('compose-form').appendChild(input);
    }
  });
  await page.screenshot({
    path: path.join(evidenceDir, '01-composer-before-submit.png'),
    fullPage: true
  });

  await Promise.all([
    page.waitForURL(/\/platform\/autoposter\/compose\/batch-[a-f0-9]+$/),
    page.click('#submit-btn')
  ]);
  const reviewUrl = page.url();
  const batchId = reviewUrl.split('/').pop();
  assert.match(batchId, /^batch-[a-f0-9]+$/);
  assert.equal(world.posts.length, 2);
  assert.ok(world.posts.every((post) => post.userId === 'owner'));
  assert.ok(world.posts.every((post) => post.workspaceId !== 'browser-spoofed-workspace'));
  assert.ok(world.posts.every((post) => post.accountId === 'account-a'));
  assert.ok(world.posts.every((post) => post.caption === 'Customer browser mission caption'));
  assert.deepEqual(
    world.posts.map((post) => post.scheduledAt),
    ['2026-08-01T09:00:00.000Z', '2026-08-01T09:30:00.000Z']
  );
  assert.ok(world.posts.every((post) => post.status === 'scheduled' && !post.approved));

  await page.locator('.item-card').first().waitFor();
  assert.equal(await page.locator('.item-card').count(), 2);
  const preparation = await page.evaluate(async (id) => {
    const response = await fetch(`/api/platform/batches/${encodeURIComponent(id)}/prepare`, {
      method: 'POST',
      headers: { Accept: 'application/json' }
    });
    return { status: response.status, payload: await response.json() };
  }, batchId);
  assert.equal(preparation.status, 200);
  assert.equal(preparation.payload.ok, true);
  await Promise.all([
    page.waitForResponse((response) =>
      response.request().method() === 'GET' &&
      response.url().endsWith(`/api/platform/batches/${batchId}`)
    ),
    page.click('#refresh-btn')
  ]);
  await page.waitForFunction(() => {
    const cards = Array.from(document.querySelectorAll('.item-card'));
    return cards.length === 2 &&
      cards.every((card) => card.querySelector('.accept-btn:not([disabled])'));
  });
  const readyView = await page.evaluate(async (id) => {
    const response = await fetch(`/api/platform/batches/${encodeURIComponent(id)}`, {
      headers: { Accept: 'application/json' }
    });
    return response.json();
  }, batchId);
  assert.equal(readyView.batch.status, 'ready');
  assert.deepEqual(readyView.items.map((item) => item.id), ['post-1', 'post-2']);
  assert.ok(readyView.items.every((item) => item.readyToAccept));
  await page.screenshot({
    path: path.join(evidenceDir, '02-exact-batch-review-ready.png'),
    fullPage: true
  });

  const acceptResponsePromise = page.waitForResponse((response) =>
    response.request().method() === 'POST' &&
    response.url().endsWith(`/api/platform/batches/${batchId}/accept-all`)
  );
  await page.click('#accept-all-btn');
  const acceptResponse = await acceptResponsePromise;
  const acceptPayload = await acceptResponse.json();
  assert.equal(acceptResponse.status(), 200);
  assert.equal(acceptPayload.accepted.length, 2);
  assert.deepEqual(acceptPayload.failed, []);
  await page.waitForFunction(() => {
    const cards = Array.from(document.querySelectorAll('.item-card'));
    return document.querySelector('.chip-completed') &&
      cards.length === 2 &&
      cards.every((card) => card.classList.contains('accepted'));
  });
  await page.screenshot({
    path: path.join(evidenceDir, '03-after-accept-all.png'),
    fullPage: true
  });

  const repeatedAccept = await page.evaluate(async (id) => {
    const response = await fetch(`/api/platform/batches/${encodeURIComponent(id)}/accept-all`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: '{}'
    });
    return response.json();
  }, batchId);
  assert.deepEqual(repeatedAccept.accepted, []);
  assert.equal(world.calls.approve.length, 2);

  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(page.url(), reviewUrl);
  await page.locator('.item-card').first().waitFor();
  assert.equal(await page.locator('.item-card').count(), 2);
  const refreshedItemIds = await page.locator('.item-card').evaluateAll((cards) =>
    cards.map((card) => card.dataset.postId)
  );
  assert.deepEqual(refreshedItemIds, ['post-1', 'post-2']);
  const refreshedView = await page.evaluate(async (id) => {
    const response = await fetch(`/api/platform/batches/${encodeURIComponent(id)}`, {
      headers: { Accept: 'application/json' }
    });
    return response.json();
  }, batchId);
  assert.equal(refreshedView.batch.status, 'completed');
  assert.ok(refreshedView.items.every((item) =>
    item.approved &&
    item.status === 'scheduled' &&
    item.caption === 'Customer browser mission caption' &&
    item.accountId === 'account-a'
  ));
  assert.deepEqual(
    refreshedView.items.map((item) => item.scheduledAt),
    ['2026-08-01T09:00:00.000Z', '2026-08-01T09:30:00.000Z']
  );
  await page.screenshot({
    path: path.join(evidenceDir, '04-after-refresh.png'),
    fullPage: true
  });

  await fillComposer(page);
  await Promise.all([
    page.waitForURL(new RegExp(`/platform/autoposter/compose/${batchId}$`)),
    page.click('#submit-btn')
  ]);
  assert.equal(page.url(), reviewUrl);
  assert.equal(world.posts.length, 2);
  assert.equal(world.calls.approve.length, 2);

  await page.goto(`${baseUrl}/platform/autoposter/queue`, { waitUntil: 'networkidle' });
  const queueText = await page.locator('main').innerText();
  assert.match(queueText, new RegExp(`Batch ${batchId.slice(0, 8)}`));
  assert.match(queueText, /Scheduled/);
  await page.screenshot({
    path: path.join(evidenceDir, '05-queue.png'),
    fullPage: true
  });

  await page.goto(`${baseUrl}/platform/autoposter/activity`, { waitUntil: 'networkidle' });
  const activityText = await page.locator('main').innerText();
  assert.match(activityText, new RegExp(`Batch ${batchId.slice(0, 8)}`));
  assert.match(activityText, /Review completed/);
  await page.screenshot({
    path: path.join(evidenceDir, '06-activity.png'),
    fullPage: true
  });

  await page.goto(reviewUrl, { waitUntil: 'networkidle' });
  await page.locator('.item-card').first().waitFor();
  assert.equal(await page.locator('.item-card').count(), 2);
  assert.equal(world.posts.length, 2);

  const blockedContext = await createContext('customer-browser-mission-blocked');
  t.after(() => blockedContext.close());
  const blockedPage = await blockedContext.newPage();
  observePage(blockedPage, { allowDestinationUnavailable: true });
  await fillComposer(blockedPage, [fixturePaths[0]]);
  await blockedPage.evaluate(() => {
    const connected = document.querySelector('.destination-checkbox[data-account-id="account-a"]');
    connected.value = 'tiktok|account-not-connected';
    connected.dataset.accountId = 'account-not-connected';
  });
  await Promise.all([
    blockedPage.waitForResponse((response) =>
      response.status() === 409 &&
      response.url().endsWith('/api/platform/batches')
    ),
    blockedPage.click('#submit-btn')
  ]);
  await blockedPage.locator('#notice:not(.hidden)').waitFor();
  const blockedNotice = await blockedPage.locator('#notice').innerText();
  assert.match(blockedNotice, /Could not schedule 1 item\./);
  assert.match(blockedNotice, /not connected and publishing-ready/);
  assert.equal(blockedPage.url(), `${baseUrl}/platform/autoposter/compose`);
  assert.equal(await blockedPage.locator('#success-state:not(.hidden)').count(), 0);
  assert.equal(world.posts.length, 2);
  assert.equal(world.batchRecords.size, 1);
  await blockedPage.screenshot({
    path: path.join(evidenceDir, '07-disconnected-destination-error.png'),
    fullPage: true
  });
  await blockedPage.evaluate(() => {
    const connected = document.querySelector('.destination-checkbox[data-account-id="account-not-connected"]');
    connected.value = 'tiktok|account-a';
    connected.dataset.accountId = 'account-a';
    connected.checked = true;
    connected.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await blockedPage.waitForFunction(() => !document.getElementById('submit-btn').disabled);

  assert.ok(world.posts.every((post) => post.postedAt == null));
  assert.ok(world.posts.every((post) => post.status === 'scheduled'));
  const expectedRecoveryConsoleErrors = consoleErrors.filter((message) =>
    /status of 409 \(Conflict\)/.test(message)
  );
  const unexpectedConsoleErrors = consoleErrors.filter((message) =>
    !/status of 409 \(Conflict\)/.test(message)
  );
  assert.equal(expectedRecoveryConsoleErrors.length, 1);
  assert.deepEqual(unexpectedConsoleErrors, []);
  assert.deepEqual(requestFailures, []);
  assert.deepEqual(unexpectedHttpFailures, []);
  assert.deepEqual(externalRequests, []);
  console.log('[PLATFORM_CUSTOMER_BROWSER_EVIDENCE]', JSON.stringify({
    browser: 'system Chrome via playwright-core',
    finalUrl: reviewUrl,
    batchId,
    itemIds: world.posts.map((post) => post.id),
    destinationIds: [...new Set(world.posts.map((post) => post.accountId))],
    scheduledAt: world.posts.map((post) => post.scheduledAt),
    caption: 'Customer browser mission caption',
    finalBatchStatus: refreshedView.batch.status,
    finalItemStatuses: refreshedView.items.map((item) => item.status),
    approvedCount: refreshedView.items.filter((item) => item.approved).length,
    duplicateItemCount: world.posts.length - 2,
    duplicateApprovalCount: world.calls.approve.length - 2,
    providerPublishCalls: 0,
    postedAtValues: world.posts.map((post) => post.postedAt || null),
    expectedRecoveryConsoleErrors,
    unexpectedConsoleErrors,
    requestFailures,
    unexpectedHttpFailures,
    externalRequests,
    screenshots: [
      '01-composer-before-submit.png',
      '02-exact-batch-review-ready.png',
      '03-after-accept-all.png',
      '04-after-refresh.png',
      '05-queue.png',
      '06-activity.png',
      '07-disconnected-destination-error.png'
    ]
  }));
});
