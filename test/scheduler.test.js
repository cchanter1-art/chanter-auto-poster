'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

test('cron tick atomically publishes a due scheduled Firestore job', async (t) => {
  const firestorePath = require.resolve('../src/firestore');
  const tiktokPath = require.resolve('../src/tiktok');
  const instagramPath = require.resolve('../src/instagram');
  const mapperPath = require.resolve('../src/postsMapper');
  const schedulerPath = require.resolve('../src/scheduler');
  for (const modulePath of [firestorePath, tiktokPath, instagramPath, mapperPath, schedulerPath]) {
    delete require.cache[modulePath];
  }

  const fixedNow = new Date('2026-06-20T12:00:00.000Z');
  const timestamp = (value) => ({
    toDate: () => new Date(value),
    toMillis: () => new Date(value).getTime()
  });
  const serverTimestamp = timestamp(fixedNow);
  const records = new Map([['due-job', {
    userId: 'owner',
    platform: 'tiktok',
    accountId: 'account-b',
    tiktokOpenId: 'account-b',
    username: 'account_b',
    originalName: 'scheduled.mp4',
    mediaType: 'video',
    mediaUrl: 'https://res.cloudinary.com/test/video/upload/scheduled.mp4',
    status: 'scheduled',
    scheduledAt: timestamp('2026-06-20T11:59:00.000Z'),
    approvedAt: timestamp('2026-06-20T10:30:00.000Z'),
    approvedBy: 'admin:owner',
    createdAt: timestamp('2026-06-20T10:00:00.000Z'),
    updatedAt: timestamp('2026-06-20T10:00:00.000Z'),
    claimAttempts: 0
  }], ['instagram-job', {
    userId: 'owner',
    platform: 'instagram',
    originalName: 'story.mp4',
    mediaType: 'video',
    mediaUrl: 'https://cdn.example.com/story.mp4',
    status: 'scheduled',
    scheduledAt: timestamp('2026-06-20T11:57:00.000Z'),
    approvedAt: timestamp('2026-06-20T08:30:00.000Z'),
    approvedBy: 'admin:owner',
    createdAt: timestamp('2026-06-20T08:00:00.000Z'),
    updatedAt: timestamp('2026-06-20T08:00:00.000Z'),
    claimAttempts: 0
  }], ['legacy-job', {
    userId: 'owner',
    platform: 'tiktok',
    originalName: 'legacy.jpg',
    mediaType: 'photo',
    mediaUrl: 'https://cdn.example.com/legacy.jpg',
    status: 'scheduled',
    scheduledAt: timestamp('2026-06-20T11:58:00.000Z'),
    approvedAt: timestamp('2026-06-20T09:30:00.000Z'),
    approvedBy: 'admin:owner',
    createdAt: timestamp('2026-06-20T09:00:00.000Z'),
    updatedAt: timestamp('2026-06-20T09:00:00.000Z'),
    claimAttempts: 0
  }], ['unapproved-due-job', {
    userId: 'owner',
    platform: 'tiktok',
    accountId: 'account-c',
    tiktokOpenId: 'account-c',
    username: 'account_c',
    originalName: 'draft.mp4',
    mediaType: 'video',
    mediaUrl: 'https://res.cloudinary.com/test/video/upload/draft.mp4',
    status: 'scheduled',
    scheduledAt: timestamp('2026-06-20T11:56:00.000Z'),
    createdAt: timestamp('2026-06-20T07:00:00.000Z'),
    updatedAt: timestamp('2026-06-20T07:00:00.000Z'),
    claimAttempts: 0
  }], ['future-job', {
    userId: 'owner',
    platform: 'tiktok',
    accountId: 'account-future',
    tiktokOpenId: 'account-future',
    status: 'scheduled',
    scheduledAt: timestamp('2026-06-20T12:01:00.000Z'),
    approvedAt: timestamp('2026-06-20T10:30:00.000Z'),
    approvedBy: 'admin:owner',
    createdAt: timestamp('2026-06-20T10:00:00.000Z'),
    updatedAt: timestamp('2026-06-20T10:00:00.000Z'),
    claimAttempts: 0
  }]]);
  const queries = [];
  const logs = [];
  const publishedJobs = [];
  let instagramHealthChecks = 0;
  let instagramPublishCalls = 0;

  const document = (id) => ({
    id,
    ref: { id },
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
      queries.push({ filters, orderField, limit: queryLimit });
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
          response: { data: { publish_id: 'publish-123', status: 'PROCESSING_UPLOAD' } }
        };
      }
    }
  };
  require.cache[instagramPath] = {
    id: instagramPath,
    filename: instagramPath,
    loaded: true,
    exports: {
      getInstagramHealth: async () => {
        instagramHealthChecks += 1;
        return {
          success: true,
          platform: 'instagram',
          configured: false,
          canPublish: false,
          mode: 'dry-run',
          missing: ['META_APP_ID']
        };
      },
      publishInstagramMedia: async () => {
        instagramPublishCalls += 1;
        throw new Error('Instagram Graph API must not be called when configuration is missing');
      }
    }
  };

  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  t.after(() => {
    console.log = originalLog;
    for (const modulePath of [firestorePath, tiktokPath, instagramPath, mapperPath, schedulerPath]) {
      delete require.cache[modulePath];
    }
  });

  const scheduler = require('../src/scheduler');
  const boundedSelection = await scheduler._private.findDueJobs(timestamp(fixedNow), 2);
  assert.deepEqual(
    boundedSelection.map((job) => job.id),
    ['unapproved-due-job', 'instagram-job'],
    'the exact ordered due query is bounded before any claim'
  );
  const result = await scheduler.runSchedulerTick({ now: fixedNow, batchSize: 10 });

  assert.deepEqual(result, {
    ok: true,
    now: fixedNow.toISOString(),
    batchSize: 10,
    checked: 4,
    due: 4,
    posted: 1,
    failed: 2,
    blockedUnapproved: 1,
    errors: [
      {
        id: 'instagram-job',
        error: 'Instagram publishing is not configured.'
      },
      {
        id: 'legacy-job',
        error: 'TikTok account is unassigned for this job; publishing was blocked.'
      }
    ]
  });
  assert.equal(records.get('due-job').status, 'posted');
  assert.equal(records.get('due-job').lockedBy, null);
  assert.equal(records.get('due-job').claimAttempts, 1);
  assert.match(records.get('due-job').dispatchOperation.operationId, /^[a-f0-9]{64}$/);
  assert.equal(records.get('due-job').dispatchOperation.state, 'succeeded');
  assert.equal(records.get('due-job').dispatchOperation.providerMutationStarted, true);
  // Approval gate: the due-but-unapproved draft is untouched — never
  // claimed, never published, no attempt recorded, not marked failed.
  assert.equal(records.get('unapproved-due-job').status, 'scheduled');
  assert.equal(records.get('unapproved-due-job').claimAttempts, 0);
  assert.equal(records.get('unapproved-due-job').lockedBy, undefined);
  assert.equal(records.get('future-job').status, 'scheduled');
  assert.equal(records.get('future-job').claimAttempts, 0);
  assert.equal(records.get('legacy-job').status, 'failed');
  assert.match(records.get('legacy-job').errorMessage, /unassigned/i);
  assert.equal(records.get('instagram-job').status, 'failed');
  assert.equal(records.get('instagram-job').errorMessage, 'Instagram publishing is not configured.');
  assert.equal(instagramHealthChecks, 1);
  assert.equal(instagramPublishCalls, 0);
  assert.equal(publishedJobs.length, 1);
  assert.equal(publishedJobs[0].accountId, 'account-b');
  assert.equal(publishedJobs[0].tiktokOpenId, 'account-b');
  assert.ok(queries.some((query) =>
    query.filters.some((filter) => filter.field === 'status' && filter.value === 'scheduled') &&
    query.filters.some((filter) => filter.field === 'scheduledAt' && filter.operator === '<=') &&
    query.orderField === 'scheduledAt'
  ));
  assert.ok(queries.some((query) => query.limit === 2));
  const repeated = await scheduler.runSchedulerTick({ now: fixedNow, batchSize: 10 });
  assert.equal(repeated.posted, 0);
  assert.equal(publishedJobs.length, 1, 'repeated ticks never redispatch terminal success');
  for (const marker of ['[CRON_TICK]', '[CRON_QUERY]', '[JOB_FOUND]', '[JOB_DUE]', '[POST_START]', '[POST_SUCCESS]']) {
    assert.ok(logs.some((line) => line.includes(marker)), `missing log marker ${marker}`);
  }
});

function createSchedulerHarness(t, { record, publishResult }) {
  const firestorePath = require.resolve('../src/firestore');
  const tiktokPath = require.resolve('../src/tiktok');
  const instagramPath = require.resolve('../src/instagram');
  const mapperPath = require.resolve('../src/postsMapper');
  const schedulerPath = require.resolve('../src/scheduler');
  for (const modulePath of [firestorePath, tiktokPath, instagramPath, mapperPath, schedulerPath]) {
    delete require.cache[modulePath];
  }

  const timestamp = (value) => ({
    toDate: () => new Date(value),
    toMillis: () => new Date(value).getTime()
  });
  const serverTimestamp = timestamp(new Date());
  const records = new Map([['job-1', record]]);
  const publishCalls = [];

  const document = (id) => ({
    id,
    ref: { id },
    get exists() { return records.has(id); },
    data: () => records.get(id)
  });
  const applyUpdate = (id, patch) => {
    const current = records.get(id);
    const next = { ...current };
    for (const [key, value] of Object.entries(patch)) {
      next[key] = value && value.__increment ? Number(next[key] || 0) + value.__increment : value;
    }
    records.set(id, next);
  };
  const createQuery = (filters = []) => ({
    where(field, operator, value) {
      return createQuery([...filters, { field, operator, value }]);
    },
    async get() {
      const docs = [...records.keys()].map(document).filter((doc) =>
        filters.every((filter) => {
          const value = doc.data()[filter.field];
          if (filter.operator === '==') return value === filter.value;
          if (filter.operator === '<=') {
            return value && typeof value.toMillis === 'function'
              && value.toMillis() <= filter.value.toMillis();
          }
          return false;
        })
      );
      return { docs };
    }
  });

  require.cache[firestorePath] = {
    id: firestorePath,
    filename: firestorePath,
    loaded: true,
    exports: {
      postsCollection: () => ({
        doc: (id) => ({ id }),
        where: (...args) => createQuery().where(...args)
      }),
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
        publishCalls.push(job);
        return publishResult;
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
        throw new Error('Instagram must not be called in this test');
      }
    }
  };

  t.after(() => {
    for (const modulePath of [firestorePath, tiktokPath, instagramPath, mapperPath, schedulerPath]) {
      delete require.cache[modulePath];
    }
  });

  return { scheduler: require('../src/scheduler'), records, publishCalls };
}

function dueTikTokRecord(overrides = {}) {
  const timestamp = (value) => ({
    toDate: () => new Date(value),
    toMillis: () => new Date(value).getTime()
  });
  return {
    userId: 'owner',
    platform: 'tiktok',
    accountId: 'account-a',
    tiktokOpenId: 'account-a',
    username: 'account_a',
    originalName: 'due.jpg',
    mediaType: 'photo',
    mediaUrl: 'https://res.cloudinary.com/test/image/upload/due.jpg',
    status: 'scheduled',
    scheduledAt: timestamp('2026-06-20T11:59:00.000Z'),
    approvedAt: timestamp('2026-06-20T10:30:00.000Z'),
    approvedBy: 'admin:owner',
    createdAt: timestamp('2026-06-20T10:00:00.000Z'),
    updatedAt: timestamp('2026-06-20T10:00:00.000Z'),
    claimAttempts: 0,
    ...overrides
  };
}

test('approval gate blocks unapproved jobs on every publish path, including force', async (t) => {
  const { scheduler, records, publishCalls } = createSchedulerHarness(t, {
    record: dueTikTokRecord({ approvedAt: null, approvedBy: null }),
    publishResult: { ok: true, mode: 'api', response: { data: { publish_id: 'must-never-happen' } } }
  });

  // Scheduled path (cron tick / due claim).
  const scheduled = await scheduler.processPost('job-1', { now: new Date('2026-06-20T12:00:00.000Z') });
  assert.equal(scheduled.ok, false);
  assert.equal(scheduled.mode, 'blocked');
  assert.equal(scheduled.code, 'APPROVAL_REQUIRED');
  assert.match(scheduled.reason, /not been approved/i);

  // Manual "Publish Now" path (force: true) must fail closed too.
  const forced = await scheduler.processPost('job-1', { force: true, now: new Date('2026-06-20T12:00:00.000Z') });
  assert.equal(forced.ok, false);
  assert.equal(forced.code, 'APPROVAL_REQUIRED');

  assert.equal(publishCalls.length, 0);
  const record = records.get('job-1');
  assert.equal(record.status, 'scheduled');
  assert.equal(record.claimAttempts, 0);
  assert.equal(record.lockedBy, undefined);
});

test('approval gate fails closed on corrupted approval state', async (t) => {
  const { scheduler, publishCalls } = createSchedulerHarness(t, {
    // A string is not a Timestamp — ambiguous/corrupted state must block.
    record: dueTikTokRecord({ approvedAt: 'yes', approvedBy: 'admin:owner' }),
    publishResult: { ok: true, mode: 'api', response: {} }
  });

  const result = await scheduler.processPost('job-1', { force: true, now: new Date('2026-06-20T12:00:00.000Z') });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'APPROVAL_REQUIRED');
  assert.equal(publishCalls.length, 0);
});

test('isExplicitlyApproved accepts only real timestamps', () => {
  const { isExplicitlyApproved } = require('../src/scheduler')._private;
  const timestamp = (value) => ({
    toDate: () => new Date(value),
    toMillis: () => new Date(value).getTime()
  });

  assert.equal(isExplicitlyApproved({ approvedAt: timestamp('2026-06-20T10:00:00.000Z') }), true);
  assert.equal(isExplicitlyApproved({}), false);
  assert.equal(isExplicitlyApproved({ approvedAt: null }), false);
  assert.equal(isExplicitlyApproved({ approvedAt: true }), false);
  assert.equal(isExplicitlyApproved({ approvedAt: 'approved' }), false);
  assert.equal(isExplicitlyApproved({ approvedAt: { toMillis: () => NaN } }), false);
  assert.equal(isExplicitlyApproved({ approvedAt: { toMillis: () => { throw new Error('corrupt'); } } }), false);
  assert.equal(isExplicitlyApproved(null), false);
});

test('transient publish failure reschedules with bounded backoff instead of failing', async (t) => {
  const { scheduler, records } = createSchedulerHarness(t, {
    record: dueTikTokRecord(),
    publishResult: { ok: false, mode: 'api', reason: 'TikTok video init returned HTTP 503' }
  });

  const before = Date.now();
  const result = await scheduler.processPost('job-1', { now: new Date('2026-06-20T12:00:00.000Z') });

  assert.equal(result.ok, false);
  assert.equal(result.retryScheduled, true);
  const record = records.get('job-1');
  assert.equal(record.status, 'scheduled');
  assert.equal(record.lockedAt, null);
  assert.equal(record.lockedBy, null);
  assert.equal(record.failedAt, null);
  assert.equal(record.claimAttempts, 1);
  assert.equal(record.lastResult.willRetry, true);
  assert.equal(record.dispatchOperation.state, 'failed_retryable');
  // First retry backs off by exactly one minute (deterministic schedule).
  const delayMs = record.scheduledAt.toMillis() - before;
  assert.ok(delayMs >= 60_000 && delayMs <= 61_000, `unexpected backoff delay ${delayMs}`);
});

test('non-retryable publish failure is still marked failed', async (t) => {
  const { scheduler, records } = createSchedulerHarness(t, {
    record: dueTikTokRecord(),
    publishResult: { ok: false, mode: 'api', reason: 'TikTok video init returned HTTP 400' }
  });

  const result = await scheduler.processPost('job-1', { now: new Date('2026-06-20T12:00:00.000Z') });

  assert.equal(result.ok, false);
  assert.equal(result.retryScheduled, undefined);
  const record = records.get('job-1');
  assert.equal(record.status, 'failed');
  assert.ok(record.failedAt);
  assert.equal(record.errorMessage, 'TikTok video init returned HTTP 400');
  assert.equal(record.dispatchOperation.state, 'failed_terminal');
});

test('transient failure at max claim attempts becomes terminal failed', async (t) => {
  const { scheduler, records } = createSchedulerHarness(t, {
    record: dueTikTokRecord({ claimAttempts: 4 }),
    publishResult: { ok: false, mode: 'api', reason: 'TikTok video init returned HTTP 503' }
  });

  const result = await scheduler.processPost('job-1', { now: new Date('2026-06-20T12:00:00.000Z') });

  assert.equal(result.ok, false);
  assert.equal(result.retryScheduled, undefined);
  const record = records.get('job-1');
  // claim incremented 4 -> 5 = SCHEDULER_MAX_CLAIM_ATTEMPTS default
  assert.equal(record.claimAttempts, 5);
  assert.equal(record.status, 'failed');
  assert.ok(record.failedAt);
  assert.equal(record.dispatchOperation.state, 'failed_terminal');
});

test('duplicate-publish protection still refuses jobs with a durable publishId', async (t) => {
  const { scheduler, records, publishCalls } = createSchedulerHarness(t, {
    record: dueTikTokRecord({ status: 'posted', publishId: 'publish-123' }),
    publishResult: { ok: true, mode: 'api', response: { data: { publish_id: 'publish-456' } } }
  });

  const result = await scheduler.processPost('job-1', {
    force: true,
    now: new Date('2026-06-20T12:00:00.000Z')
  });

  assert.equal(result.ok, false);
  assert.equal(result.mode, 'skipped');
  assert.equal(publishCalls.length, 0);
  assert.equal(records.get('job-1').status, 'posted');
  assert.equal(records.get('job-1').publishId, 'publish-123');
});

test('dispatch operation identity is stable for one approval attempt and changes across authority or attempts', () => {
  const { createDispatchOperation } = require('../src/scheduler')._private;
  const now = new Date('2026-06-20T12:00:00.000Z');
  const record = dueTikTokRecord();
  const first = createDispatchOperation('job-1', record, 1, now);
  const replay = createDispatchOperation('job-1', record, 1, now);
  const nextAttempt = createDispatchOperation('job-1', record, 2, now);
  const newApproval = createDispatchOperation(
    'job-1',
    dueTikTokRecord({
      approvedAt: {
        toDate: () => new Date('2026-06-20T11:00:00.000Z'),
        toMillis: () => Date.parse('2026-06-20T11:00:00.000Z')
      }
    }),
    1,
    now
  );

  assert.equal(first.operationId, replay.operationId);
  assert.notEqual(first.operationId, nextAttempt.operationId);
  assert.notEqual(first.operationId, newApproval.operationId);
  assert.match(first.operationId, /^[a-f0-9]{64}$/);
});

test('expired pre-provider lease is safely recoverable without a provider call', async (t) => {
  const timestamp = (value) => ({
    toDate: () => new Date(value),
    toMillis: () => Date.parse(value)
  });
  const { scheduler, records, publishCalls } = createSchedulerHarness(t, {
    record: dueTikTokRecord({
      status: 'processing',
      claimAttempts: 1,
      lockedAt: timestamp('2026-06-20T11:00:00.000Z'),
      lockedBy: 'stopped-worker',
      dispatchOperation: {
        version: 1,
        operationId: 'a'.repeat(64),
        attemptNumber: 1,
        provider: 'tiktok',
        state: 'claimed',
        claimedAt: timestamp('2026-06-20T11:00:00.000Z'),
        startedAt: null,
        completedAt: null,
        providerMutationStarted: false
      }
    }),
    publishResult: { ok: true, mode: 'api', response: { data: { publish_id: 'must-not-run' } } }
  });

  await scheduler._private.reclaimStaleLocks(new Date('2026-06-20T12:00:00.000Z'));
  const record = records.get('job-1');
  assert.equal(record.status, 'scheduled');
  assert.equal(record.lockedAt, null);
  assert.equal(record.lockedBy, null);
  assert.equal(record.dispatchOperation.state, 'abandoned_pre_provider');
  assert.equal(record.dispatchOperation.providerMutationStarted, false);
  assert.equal(publishCalls.length, 0);
});

test('expired in-provider lease becomes outcome_unknown and never blind-redispatches', async (t) => {
  const timestamp = (value) => ({
    toDate: () => new Date(value),
    toMillis: () => Date.parse(value)
  });
  const { scheduler, records, publishCalls } = createSchedulerHarness(t, {
    record: dueTikTokRecord({
      status: 'processing',
      claimAttempts: 1,
      lockedAt: timestamp('2026-06-20T11:00:00.000Z'),
      lockedBy: 'stopped-worker',
      dispatchOperation: {
        version: 1,
        operationId: 'b'.repeat(64),
        attemptNumber: 1,
        provider: 'tiktok',
        state: 'dispatching',
        claimedAt: timestamp('2026-06-20T11:00:00.000Z'),
        startedAt: timestamp('2026-06-20T11:00:01.000Z'),
        completedAt: null,
        providerMutationStarted: true
      }
    }),
    publishResult: { ok: true, mode: 'api', response: { data: { publish_id: 'must-not-run' } } }
  });

  await scheduler._private.reclaimStaleLocks(new Date('2026-06-20T12:00:00.000Z'));
  const record = records.get('job-1');
  assert.equal(record.status, 'outcome_unknown');
  assert.equal(record.providerStatus, 'provider_reconciliation_required');
  assert.equal(record.dispatchOperation.state, 'outcome_unknown');
  assert.equal(record.lastResult.code, 'PROVIDER_DISPATCH_OUTCOME_UNKNOWN');
  assert.equal(record.lastResult.outcomeUnknown, true);

  const replay = await scheduler.processPost('job-1', {
    force: true,
    now: new Date('2026-06-20T12:01:00.000Z')
  });
  assert.equal(replay.mode, 'skipped');
  assert.equal(publishCalls.length, 0);
});

test('failure classification separates transient from terminal errors', () => {
  const { isTransientPublishFailure, retryBackoffMs } = require('../src/scheduler')._private;

  assert.equal(isTransientPublishFailure({ ok: false, reason: 'TikTok video upload returned HTTP 502' }), true);
  assert.equal(isTransientPublishFailure({ ok: false, reason: 'fetch failed' }), true);
  assert.equal(isTransientPublishFailure({ ok: false, reason: 'The operation timed out', code: 'ETIMEDOUT' }), true);
  assert.equal(isTransientPublishFailure({ ok: false, reason: 'TikTok API rate limit exceeded' }), true);

  assert.equal(isTransientPublishFailure({ ok: false, reason: 'TikTok photo publish returned HTTP 400' }), false);
  assert.equal(isTransientPublishFailure({ ok: false, reason: 'TikTok account is unassigned for this job; publishing was blocked.' }), false);
  assert.equal(isTransientPublishFailure({ ok: false, reason: 'Instagram publishing is not configured.', code: 'INSTAGRAM_NOT_CONFIGURED' }), false);
  assert.equal(isTransientPublishFailure({ ok: false, reason: 'Token was issued before app approval. Please click Disconnect then reconnect TikTok to get a fresh production token.' }), false);
  assert.equal(isTransientPublishFailure({ ok: false, reason: 'Some unknown error' }), false);
  assert.equal(isTransientPublishFailure({ ok: true }), false);

  assert.equal(retryBackoffMs(1), 60_000);
  assert.equal(retryBackoffMs(2), 5 * 60_000);
  assert.equal(retryBackoffMs(3), 15 * 60_000);
  assert.equal(retryBackoffMs(4), 60 * 60_000);
  assert.equal(retryBackoffMs(99), 60 * 60_000);
});

test('Firestore index failures expose the generated console link', () => {
  const scheduler = require('../src/scheduler');
  const url = 'https://console.firebase.google.com/v1/r/project/test/firestore/indexes?create_composite=abc';
  const described = scheduler._private.describeQueryError(new Error(`The query requires an index. ${url}`));
  assert.equal(described.indexUrl, url);
});
