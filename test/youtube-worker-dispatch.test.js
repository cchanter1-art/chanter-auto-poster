'use strict';

// Worker dispatch and outcome truth for YouTube jobs: provider routing,
// providerStatus persistence, ambiguous-outcome handling, and duplicate
// prevention. The YouTube adapter itself is faked here (its internals are
// proven in youtube-adapter.test.js); the worker, claim transaction, and
// finalize logic run real against the Firestore fake.

const assert = require('node:assert/strict');
const test = require('node:test');

test('worker routes YouTube jobs to the adapter and persists truthful outcomes', async (t) => {
  const firestorePath = require.resolve('../src/firestore');
  const tiktokPath = require.resolve('../src/tiktok');
  const instagramPath = require.resolve('../src/instagram');
  const mapperPath = require.resolve('../src/postsMapper');
  const schedulerPath = require.resolve('../src/scheduler');
  const youtubePath = require.resolve('../src/youtube');
  for (const modulePath of [firestorePath, tiktokPath, instagramPath, mapperPath, schedulerPath, youtubePath]) {
    delete require.cache[modulePath];
  }

  const fixedNow = new Date('2026-07-11T12:00:00.000Z');
  const timestamp = (value) => ({
    toDate: () => new Date(value),
    toMillis: () => new Date(value).getTime()
  });
  const serverTimestamp = timestamp(fixedNow);
  const baseJob = (overrides) => ({
    userId: 'owner',
    accountId: 'UC-chanter',
    username: 'chanterCy',
    originalName: 'clip.mp4',
    mediaType: 'video',
    mediaUrl: 'https://res.cloudinary.com/test/video/upload/clip.mp4',
    platform: 'youtube',
    provider: 'youtube',
    connectedAccountId: 'youtube:UC-chanter',
    providerMetadata: { youtube: { title: 'Private test', description: '', privacyStatus: 'private', notifySubscribers: false } },
    status: 'scheduled',
    scheduledAt: timestamp('2026-07-11T11:59:00.000Z'),
    approvedAt: timestamp('2026-07-11T10:00:00.000Z'),
    approvedBy: 'admin:owner',
    createdAt: timestamp('2026-07-11T09:00:00.000Z'),
    updatedAt: timestamp('2026-07-11T09:00:00.000Z'),
    claimAttempts: 0,
    ...overrides
  });
  const records = new Map([
    ['youtube-ok-job', baseJob({})],
    ['youtube-unverified-job', baseJob({})],
    ['youtube-ambiguous-job', baseJob({})],
    ['youtube-already-uploaded-job', baseJob({ publishId: 'yt-existing-1' })],
    ['tiktok-job', baseJob({
      platform: 'tiktok', provider: 'tiktok', connectedAccountId: 'tiktok:account-a',
      accountId: 'account-a', tiktokOpenId: 'account-a', username: 'account_a', providerMetadata: null
    })]
  ]);

  const document = (id) => ({ id, get exists() { return records.has(id); }, data: () => records.get(id) });
  const ref = (id) => ({ id });
  const applyUpdate = (id, patch) => {
    const next = { ...records.get(id) };
    for (const [key, value] of Object.entries(patch)) {
      next[key] = value && value.__increment ? Number(next[key] || 0) + value.__increment : value;
    }
    records.set(id, next);
  };
  const createQuery = (filters = []) => ({
    where(field, operator, value) { return createQuery([...filters, { field, operator, value }]); },
    orderBy() { return this; },
    limit() { return this; },
    async get() {
      let docs = [...records.keys()].map(document);
      for (const filter of filters) {
        docs = docs.filter((doc) => {
          const value = doc.data()[filter.field];
          if (filter.operator === '==') return value === filter.value;
          if (filter.operator === '<=') return value && value.toMillis && value.toMillis() <= filter.value.toMillis();
          return false;
        });
      }
      return { docs };
    }
  });
  require.cache[firestorePath] = {
    id: firestorePath, filename: firestorePath, loaded: true,
    exports: {
      postsCollection: () => ({ where: (...args) => createQuery().where(...args), doc: (id) => ref(id) }),
      getFirestore: () => ({
        runTransaction: async (callback) => callback({
          get: async (documentRef) => document(documentRef.id),
          update: (documentRef, patch) => applyUpdate(documentRef.id, patch)
        })
      }),
      Timestamp: { now: () => serverTimestamp, fromDate: timestamp, fromMillis: (value) => timestamp(new Date(value)) },
      FieldValue: { serverTimestamp: () => serverTimestamp, increment: (value) => ({ __increment: value }) }
    }
  };

  const tiktokCalls = [];
  require.cache[tiktokPath] = {
    id: tiktokPath, filename: tiktokPath, loaded: true,
    exports: {
      publishPhotoPost: async (job) => {
        tiktokCalls.push(job.id);
        return { ok: true, mode: 'api', response: { data: { publish_id: `tt-${job.id}` } } };
      }
    }
  };
  require.cache[instagramPath] = {
    id: instagramPath, filename: instagramPath, loaded: true,
    exports: { getInstagramHealth: async () => ({ configured: false, canPublish: false }), publishInstagramMedia: async () => ({ ok: false }) }
  };

  const youtubeCalls = [];
  const youtubeResults = new Map([
    ['youtube-ok-job', {
      ok: true,
      mode: 'api',
      response: { video_id: 'yt-video-777', privacy_status: 'private', upload_status: 'uploaded', channel_id: 'UC-chanter' },
      providerStatus: 'uploaded_private',
      providerVerification: {
        provider: 'youtube',
        externalVideoId: 'yt-video-777',
        channelId: 'UC-chanter',
        channelTitle: 'CHANTER',
        channelHandle: '@chantercy',
        title: 'Private test',
        privacyStatus: 'private',
        uploadStatus: 'uploaded',
        processingStatus: 'succeeded',
        verifiedAt: '2026-07-11T12:00:00.000Z',
        uploadMethod: 'resumable'
      }
    }],
    ['youtube-ambiguous-job', {
      ok: false,
      mode: 'api',
      outcomeUnknown: true,
      code: 'PROVIDER_RECONCILIATION_REQUIRED',
      reason: 'YouTube upload did not return a definitive result. A video may exist; reconcile before retrying.'
    }],
    ['youtube-unverified-job', {
      ok: true,
      mode: 'api',
      response: { video_id: 'yt-video-unverified', privacy_status: 'private', upload_status: 'uploaded', channel_id: 'UC-chanter' },
      providerStatus: 'uploaded_private'
    }]
  ]);
  require.cache[youtubePath] = {
    id: youtubePath, filename: youtubePath, loaded: true,
    exports: {
      publishScheduledYouTubePost: async (job) => {
        youtubeCalls.push(job.id);
        return youtubeResults.get(job.id) || { ok: false, mode: 'api', reason: 'unexpected job reached the adapter' };
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
    for (const modulePath of [firestorePath, tiktokPath, instagramPath, mapperPath, schedulerPath, youtubePath]) {
      delete require.cache[modulePath];
    }
  });

  const scheduler = require('../src/scheduler');
  const summary = await scheduler.runSchedulerTick({ now: fixedNow, batchSize: 10 });

  // Routing: exactly the three runnable YouTube jobs reached the adapter;
  // the TikTok job stayed on the TikTok path; the job that already has a
  // provider video id was never claimed at all.
  assert.deepEqual(youtubeCalls.sort(), ['youtube-ambiguous-job', 'youtube-ok-job', 'youtube-unverified-job']);
  assert.deepEqual(tiktokCalls, ['tiktok-job']);

  // Success: one video id persisted once, provider status truthful.
  const okRecord = records.get('youtube-ok-job');
  assert.equal(okRecord.status, 'posted');
  assert.equal(okRecord.publishId, 'yt-video-777');
  assert.equal(okRecord.providerStatus, 'uploaded_private');
  assert.equal(okRecord.providerVerification.externalVideoId, 'yt-video-777');
  assert.equal(okRecord.providerVerification.privacyStatus, 'private');
  assert.match(okRecord.history.at(-1).detail, /private/i);
  assert.match(okRecord.history.at(-1).detail, /notifications disabled/i);
  assert.equal(JSON.stringify(okRecord).includes('access_token'), false);

  // Ambiguous: not failed-as-if-nothing-happened, not success, not retried.
  const ambiguousRecord = records.get('youtube-ambiguous-job');
  assert.equal(ambiguousRecord.status, 'outcome_unknown');
  assert.equal(ambiguousRecord.providerStatus, 'provider_reconciliation_required');
  assert.equal(ambiguousRecord.lastResult.outcomeUnknown, true);
  assert.equal(ambiguousRecord.lastResult.willRetry, undefined, 'an ambiguous outcome must never blind-retry');
  assert.notEqual(ambiguousRecord.status, 'scheduled', 'the job is out of the claimable pool');

  // An upload response with a real external ID but incomplete read-back is
  // retained as outcome_unknown. The durable ID blocks every replay path.
  const unverifiedRecord = records.get('youtube-unverified-job');
  assert.equal(unverifiedRecord.status, 'outcome_unknown');
  assert.equal(unverifiedRecord.publishId, 'yt-video-unverified');
  assert.equal(unverifiedRecord.providerStatus, 'provider_verification_required');
  assert.equal(unverifiedRecord.lastResult.code, 'PROVIDER_VERIFICATION_FAILED');

  // Duplicate prevention: an existing providerPostId blocks any re-upload.
  const alreadyUploaded = records.get('youtube-already-uploaded-job');
  assert.equal(alreadyUploaded.publishId, 'yt-existing-1');
  assert.equal(alreadyUploaded.claimAttempts, 0, 'the job was never claimed');

  // A second tick cannot double-publish anything: posted jobs are not due,
  // outcome_unknown jobs are not claimable, publishId jobs are refused.
  const secondSummary = await scheduler.runSchedulerTick({ now: fixedNow, batchSize: 10 });
  assert.deepEqual(youtubeCalls.sort(), ['youtube-ambiguous-job', 'youtube-ok-job', 'youtube-unverified-job'], 'no second adapter call for any job');
  assert.equal(tiktokCalls.length, 1);
  assert.equal(secondSummary.posted, 0);

  // Force mode (manual Publish Now) also refuses a job with a video id.
  const forced = await scheduler.processPost('youtube-already-uploaded-job', { force: true, now: fixedNow });
  assert.equal(forced.ok, false);
  assert.equal(forced.mode, 'skipped');
  assert.equal(youtubeCalls.length, 3, 'the adapter was not invoked for the already-uploaded job');

  // Sequential re-processing of a completed job is refused by the claim.
  const reprocess = await scheduler.processPost('youtube-ok-job', { force: true, now: fixedNow });
  assert.equal(reprocess.ok, false);
  assert.equal(reprocess.mode, 'skipped');
  assert.equal(youtubeCalls.length, 3);

  assert.equal(summary.posted, 2, 'one TikTok + one verified YouTube success in the first tick');
});
