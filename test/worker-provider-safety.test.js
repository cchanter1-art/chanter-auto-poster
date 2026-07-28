'use strict';

process.env.YOUTUBE_ENABLED = 'false';

// Worker provider safety: the publish worker must keep processing legacy
// and explicit TikTok jobs, must refuse a job whose EXPLICIT provider has
// no publish handler (never falling through to the TikTok path), and must
// keep the human-approval gate closed — all without any live publishing.

const assert = require('node:assert/strict');
const test = require('node:test');

test('worker publishes TikTok jobs, refuses unsupported explicit providers, and keeps gates closed', async (t) => {
  const firestorePath = require.resolve('../src/firestore');
  const tiktokPath = require.resolve('../src/tiktok');
  const instagramPath = require.resolve('../src/instagram');
  const mapperPath = require.resolve('../src/postsMapper');
  const schedulerPath = require.resolve('../src/scheduler');
  for (const modulePath of [firestorePath, tiktokPath, instagramPath, mapperPath, schedulerPath]) {
    delete require.cache[modulePath];
  }

  const fixedNow = new Date('2026-07-10T12:00:00.000Z');
  const timestamp = (value) => ({
    toDate: () => new Date(value),
    toMillis: () => new Date(value).getTime()
  });
  const serverTimestamp = timestamp(fixedNow);
  const baseJob = (overrides) => ({
    userId: 'owner',
    accountId: 'account-a',
    tiktokOpenId: 'account-a',
    username: 'account_a',
    originalName: 'clip.mp4',
    mediaType: 'video',
    mediaUrl: 'https://res.cloudinary.com/test/video/upload/clip.mp4',
    status: 'scheduled',
    scheduledAt: timestamp('2026-07-10T11:59:00.000Z'),
    approvedAt: timestamp('2026-07-10T10:00:00.000Z'),
    approvedBy: 'admin:owner',
    createdAt: timestamp('2026-07-10T09:00:00.000Z'),
    updatedAt: timestamp('2026-07-10T09:00:00.000Z'),
    claimAttempts: 0,
    ...overrides
  });
  const records = new Map([
    // Explicit TikTok job (new-style document with provider identity).
    ['explicit-tiktok-job', baseJob({ platform: 'tiktok', provider: 'tiktok', connectedAccountId: 'tiktok:account-a' })],
    // Legacy job: no provider/platform stored at all — normalizes to TikTok.
    ['legacy-tiktok-job', baseJob({ accountId: 'account-b', tiktokOpenId: 'account-b', username: 'account_b' })],
    // Explicit unknown provider: must be refused, never sent to TikTok.
    ['unknown-provider-job', baseJob({ platform: 'mastodon', provider: 'mastodon' })],
    // Explicit known-but-unsupported provider: must also be refused.
    ['youtube-job', baseJob({ platform: 'youtube', provider: 'youtube' })],
    // Unapproved TikTok job: the approval gate stays closed.
    ['unapproved-job', baseJob({ platform: 'tiktok', approvedAt: undefined, approvedBy: undefined })]
  ]);
  const publishedJobs = [];
  let instagramPublishCalls = 0;

  const document = (id) => ({
    id,
    get exists() { return records.has(id); },
    data: () => records.get(id)
  });
  const ref = (id) => ({ id });
  const applyUpdate = (id, patch) => {
    const current = records.get(id);
    const next = { ...current };
    for (const [key, value] of Object.entries(patch)) {
      next[key] = value && value.__increment ? Number(next[key] || 0) + value.__increment : value;
    }
    records.set(id, next);
  };
  const createQuery = (filters = [], orderField = null, queryLimit = null) => ({
    where(field, operator, value) {
      return createQuery([...filters, { field, operator, value }], orderField, queryLimit);
    },
    orderBy(field) { return createQuery(filters, field, queryLimit); },
    limit(value) { return createQuery(filters, orderField, value); },
    async get() {
      let docs = [...records.keys()].map(document);
      for (const filter of filters) {
        docs = docs.filter((doc) => {
          const value = doc.data()[filter.field];
          if (filter.operator === '==') return value === filter.value;
          if (filter.operator === '<=') return value && value.toMillis() <= filter.value.toMillis();
          return false;
        });
      }
      if (orderField) docs.sort((a, b) => a.data()[orderField].toMillis() - b.data()[orderField].toMillis());
      return { docs: queryLimit ? docs.slice(0, queryLimit) : docs };
    }
  });
  const collection = {
    where: (...args) => createQuery().where(...args),
    doc: (id) => ref(id)
  };

  require.cache[firestorePath] = {
    id: firestorePath,
    filename: firestorePath,
    loaded: true,
    exports: {
      postsCollection: () => collection,
      getFirestore: () => ({
        runTransaction: async (callback) => callback({
          get: async (documentRef) => document(documentRef.id),
          update: (documentRef, patch) => applyUpdate(documentRef.id, patch)
        })
      }),
      Timestamp: {
        now: () => serverTimestamp,
        fromDate: timestamp,
        fromMillis: (value) => timestamp(new Date(value))
      },
      FieldValue: {
        serverTimestamp: () => serverTimestamp,
        increment: (value) => ({ __increment: value })
      }
    }
  };
  require.cache[tiktokPath] = {
    id: tiktokPath,
    filename: tiktokPath,
    loaded: true,
    exports: {
      publishPhotoPost: async (job) => {
        publishedJobs.push(job);
        return {
          ok: true,
          mode: 'api',
          response: { data: { publish_id: `publish-${job.id}`, status: 'PROCESSING_UPLOAD' } }
        };
      }
    }
  };
  require.cache[instagramPath] = {
    id: instagramPath,
    filename: instagramPath,
    loaded: true,
    exports: {
      getInstagramHealth: async () => ({ configured: false, canPublish: false }),
      publishInstagramMedia: async () => {
        instagramPublishCalls += 1;
        throw new Error('Instagram must not be called by this test');
      }
    }
  };

  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  t.after(() => {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
    for (const modulePath of [firestorePath, tiktokPath, instagramPath, mapperPath, schedulerPath]) {
      delete require.cache[modulePath];
    }
  });

  const scheduler = require('../src/scheduler');
  const summary = await scheduler.runSchedulerTick({ now: fixedNow, batchSize: 10 });

  // Both TikTok-bound jobs (explicit + legacy) published through the one
  // existing TikTok boundary; nothing else reached it.
  assert.equal(summary.posted, 2);
  assert.equal(summary.blockedUnapproved, 1);
  assert.equal(summary.failed, 2);
  assert.deepEqual(publishedJobs.map((job) => job.id).sort(), ['explicit-tiktok-job', 'legacy-tiktok-job']);
  assert.equal(instagramPublishCalls, 0);

  assert.equal(records.get('explicit-tiktok-job').status, 'posted');
  assert.equal(records.get('legacy-tiktok-job').status, 'posted');

  // Unknown explicit providers fail closed: terminal failure, coded
  // refusal, no retry, no TikTok fallback.
  const unknownRecord = records.get('unknown-provider-job');
  assert.equal(unknownRecord.status, 'failed', 'unknown-provider-job must be terminally refused');
  assert.match(unknownRecord.errorMessage, /not supported/i);
  assert.equal(unknownRecord.lastResult.code, scheduler.PROVIDER_UNSUPPORTED);
  assert.equal(unknownRecord.lastResult.willRetry, undefined, 'a provider refusal must not schedule a retry');
  const unknownError = summary.errors.find((entry) => entry.id === 'unknown-provider-job');
  assert.match(unknownError.error, /mastodon/);

  // Part 3: an explicit YouTube job now dispatches to the real YouTube
  // adapter, which fails closed on this unconfigured deployment — terminal
  // failure, truthful reason, no retry, and still no TikTok fallback.
  const youtubeRecord = records.get('youtube-job');
  assert.equal(youtubeRecord.status, 'failed', 'youtube-job must be terminally refused when unconfigured');
  assert.match(youtubeRecord.errorMessage, /not configured/i);
  assert.equal(youtubeRecord.lastResult.willRetry, false, 'an unconfigured provider must not schedule a retry');
  assert.equal(youtubeRecord.lastResult.code, 'PUBLISH_ATTEMPT_BUDGET_EXHAUSTED');
  assert.equal(youtubeRecord.providerStatus, 'attempt_budget_exhausted');
  const youtubeError = summary.errors.find((entry) => entry.id === 'youtube-job');
  assert.match(youtubeError.error, /not configured/i);

  // The approval gate is untouched by provider dispatch: unapproved jobs
  // are never claimed.
  assert.equal(records.get('unapproved-job').status, 'scheduled');
  assert.equal(records.get('unapproved-job').claimAttempts, 0);
});
