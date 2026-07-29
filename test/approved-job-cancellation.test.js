'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const SCHEDULED_AT = '2026-07-29T14:30:00.000Z';
const APPROVED_AT = '2026-07-29T14:24:46.497Z';
const CANCELLED_AT = '2026-07-29T14:50:00.000Z';
const WORKSPACE_ID = 'workspace-recovery';

function firestoreTimestamp(value) {
  return {
    toDate: () => new Date(value),
    toMillis: () => Date.parse(value)
  };
}

function exactPost(overrides = {}) {
  return {
    id: 'job-exact',
    userId: 'owner',
    workspaceId: WORKSPACE_ID,
    batchId: 'batch-exact',
    provider: 'tiktok',
    accountId: 'account-a',
    status: 'scheduled',
    privacyLevel: 'SELF_ONLY',
    scheduledAt: firestoreTimestamp(SCHEDULED_AT),
    approvedAt: firestoreTimestamp(APPROVED_AT),
    approvedBy: 'admin:owner',
    claimAttempts: 0,
    lockedAt: null,
    lockedBy: null,
    publishId: null,
    providerOperation: null,
    providerStatus: null,
    lastResult: null,
    history: [
      { at: '2026-07-29T14:23:38.072Z', event: 'created' },
      { at: APPROVED_AT, event: 'approved' }
    ],
    ...overrides
  };
}

function exactBatch(overrides = {}) {
  return {
    id: 'batch-exact',
    userId: 'owner',
    workspaceId: WORKSPACE_ID,
    status: 'completed',
    itemCount: 1,
    acceptedCount: 1,
    deletedCount: 0,
    ...overrides
  };
}

function installStorageMocks({ posts = [exactPost()], batches = [exactBatch()] } = {}) {
  const firestorePath = require.resolve('../src/firestore');
  const cloudinaryPath = require.resolve('../src/cloudinary');
  const storagePath = require.resolve('../src/storage');
  const mapperPath = require.resolve('../src/postsMapper');
  for (const modulePath of [storagePath, mapperPath]) delete require.cache[modulePath];

  const stores = {
    posts: new Map(posts.map(({ id, ...data }) => [id, { ...data }])),
    postBatches: new Map(batches.map(({ id, ...data }) => [id, { ...data }]))
  };
  const providerSideEffects = [];
  const committedWrites = [];

  function snapshot(collectionName, id) {
    const records = stores[collectionName];
    return {
      id,
      exists: records.has(id),
      data: () => records.get(id)
    };
  }

  function documentReference(collectionName, id) {
    return {
      id,
      collectionName,
      get: async () => snapshot(collectionName, id)
    };
  }

  function collection(collectionName) {
    return {
      doc: (id) => documentReference(collectionName, id),
      where: (field, operator, value) => ({
        get: async () => ({
          docs: [...stores[collectionName].entries()]
            .filter(([, data]) => operator !== '==' || data[field] === value)
            .map(([id]) => snapshot(collectionName, id))
        })
      })
    };
  }

  const db = {
    async runTransaction(callback) {
      const pending = [];
      const result = await callback({
        get: async (ref) => snapshot(ref.collectionName, ref.id),
        update(ref, patch) {
          pending.push({ ref, patch });
        }
      });
      for (const operation of pending) {
        const records = stores[operation.ref.collectionName];
        if (!records.has(operation.ref.id)) throw new Error('missing update target');
      }
      for (const operation of pending) {
        const records = stores[operation.ref.collectionName];
        records.set(operation.ref.id, {
          ...records.get(operation.ref.id),
          ...operation.patch
        });
        committedWrites.push({
          collection: operation.ref.collectionName,
          id: operation.ref.id,
          patch: operation.patch
        });
      }
      return result;
    }
  };

  require.cache[cloudinaryPath] = {
    id: cloudinaryPath,
    filename: cloudinaryPath,
    loaded: true,
    exports: {
      uploadMediaFile: async () => { providerSideEffects.push('upload'); },
      destroyMediaAsset: async () => { providerSideEffects.push('destroy'); },
      checkCloudinaryHealth: async () => ({ ok: true })
    }
  };
  require.cache[firestorePath] = {
    id: firestorePath,
    filename: firestorePath,
    loaded: true,
    exports: {
      postsCollection: () => collection('posts'),
      postBatchesCollection: () => collection('postBatches'),
      configDoc: () => documentReference('postBatches', 'config-unused'),
      getFirestore: () => db,
      Timestamp: {
        now: () => firestoreTimestamp(CANCELLED_AT),
        fromDate: (date) => firestoreTimestamp(date.toISOString())
      },
      FieldValue: {
        serverTimestamp: () => firestoreTimestamp(CANCELLED_AT),
        increment: (value) => value
      }
    }
  };

  return {
    storage: require('../src/storage'),
    stores,
    committedWrites,
    providerSideEffects,
    cleanup() {
      for (const modulePath of [storagePath, mapperPath, firestorePath, cloudinaryPath]) {
        delete require.cache[modulePath];
      }
    }
  };
}

function cancellationOptions(overrides = {}) {
  return {
    batchId: 'batch-exact',
    expectedScheduledAt: SCHEDULED_AT,
    expectedApprovedAt: APPROVED_AT,
    expectedPrivacyLevel: 'SELF_ONLY',
    cancelledBy: 'admin:owner',
    workspaceScope: { workspaceId: WORKSPACE_ID, allowLegacyOwnerRecords: false },
    now: new Date('2026-07-29T14:47:28.139Z'),
    ...overrides
  };
}

test('exact approved overdue item is atomically revoked and cancelled with history retained', async (t) => {
  const world = installStorageMocks();
  t.after(world.cleanup);

  const result = await world.storage.cancelApprovedPost('owner', 'job-exact', cancellationOptions());
  assert.equal(result.outcome, 'cancelled');
  assert.equal(result.post.status, 'cancelled');
  assert.equal(result.post.approved, false);
  assert.equal(result.post.cancelledAt, CANCELLED_AT);
  assert.equal(result.post.cancellationReason, 'approved_overdue_item_cancelled_before_provider_dispatch');

  const storedPost = world.stores.posts.get('job-exact');
  const storedBatch = world.stores.postBatches.get('batch-exact');
  assert.equal(storedPost.status, 'cancelled');
  assert.equal(storedPost.approvedAt, null);
  assert.equal(storedPost.approvedBy, null);
  assert.deepEqual(
    storedPost.history.map((entry) => entry.event),
    ['created', 'approved', 'approval_revoked', 'cancelled']
  );
  assert.equal(storedBatch.status, 'cancelled');
  assert.equal(storedBatch.acceptedCount, 0);
  assert.equal(storedBatch.cancelledCount, 1);
  assert.equal(storedBatch.lastCancelledPostId, 'job-exact');
  assert.deepEqual(
    world.committedWrites.map(({ collection, id }) => ({ collection, id })),
    [
      { collection: 'posts', id: 'job-exact' },
      { collection: 'postBatches', id: 'batch-exact' }
    ],
    'one transaction writes only the exact post and its exact batch projection'
  );
  assert.deepEqual(world.providerSideEffects, [], 'no provider/media adapter was called');

  const replay = await world.storage.cancelApprovedPost('owner', 'job-exact', cancellationOptions());
  assert.equal(replay.outcome, 'already_cancelled');
  assert.equal(world.committedWrites.length, 2, 'an exact replay performs no second write');
  assert.equal(world.stores.posts.size, 1, 'the durable job and its evidence remain present');
});

test('any provider-dispatch evidence refuses cancellation without a write', async (t) => {
  const cases = [
    ['claimed', { claimAttempts: 1 }],
    ['processing', { status: 'processing', lockedAt: firestoreTimestamp('2026-07-29T14:31:00.000Z'), lockedBy: 'worker-1' }],
    ['publish-history', { history: [{ at: '2026-07-29T14:31:00.000Z', event: 'publish_attempt' }] }],
    ['publish-id', { publishId: 'provider-publish-id' }],
    ['provider-operation', { providerOperation: { state: 'session_created' } }],
    ['provider-result', { lastResult: { providerMutationStarted: true } }]
  ];
  const posts = cases.map(([suffix, patch]) => exactPost({
    ...patch,
    id: `job-${suffix}`,
    batchId: `batch-${suffix}`
  }));
  const batches = cases.map(([suffix]) => exactBatch({ id: `batch-${suffix}` }));
  const world = installStorageMocks({ posts, batches });
  t.after(world.cleanup);

  for (const [suffix] of cases) {
    await assert.rejects(
      world.storage.cancelApprovedPost('owner', `job-${suffix}`, cancellationOptions({
        batchId: `batch-${suffix}`
      })),
      (error) => error && error.code === 'cancellation_dispatch_started'
    );
  }
  assert.deepEqual(world.committedWrites, []);
  assert.deepEqual(world.providerSideEffects, []);
  assert.ok([...world.stores.posts.values()].every((post) => post.status !== 'cancelled'));
});

test('changed identity preconditions, future schedules, and multi-item batches fail closed', async (t) => {
  const world = installStorageMocks();
  t.after(world.cleanup);

  await assert.rejects(
    world.storage.cancelApprovedPost('owner', 'job-exact', cancellationOptions({
      expectedApprovedAt: '2026-07-29T14:25:00.000Z'
    })),
    (error) => error && error.code === 'cancellation_precondition_changed'
  );
  await assert.rejects(
    world.storage.cancelApprovedPost('owner', 'job-exact', cancellationOptions({
      now: new Date('2026-07-29T14:20:00.000Z')
    })),
    /not overdue/
  );

  world.stores.postBatches.get('batch-exact').itemCount = 2;
  await assert.rejects(
    world.storage.cancelApprovedPost('owner', 'job-exact', cancellationOptions()),
    (error) => error && error.code === 'cancellation_batch_scope_blocked'
  );
  assert.deepEqual(world.committedWrites, []);
  assert.equal(world.stores.posts.get('job-exact').status, 'scheduled');
});

test('application boundary permits only website context and carries exact preconditions', async () => {
  const calls = [];
  const {
    AutoPosterApplicationError,
    createAutoPosterApplicationService,
    createExecutionContext
  } = require('../src/autoposterApplicationService');
  const service = createAutoPosterApplicationService({
    storage: {
      async cancelApprovedPost(userId, postId, options) {
        calls.push({ userId, postId, options });
        return {
          outcome: 'cancelled',
          post: { id: postId, batchId: options.batchId, status: 'cancelled', approved: false }
        };
      }
    },
    commercialService: {
      async resolveContext({ userId }) {
        return {
          userId,
          workspace: { workspaceId: WORKSPACE_ID },
          workspaceScope: { workspaceId: WORKSPACE_ID, allowLegacyOwnerRecords: false }
        };
      }
    }
  });
  const input = {
    postId: 'job-exact',
    batchId: 'batch-exact',
    expectedScheduledAt: SCHEDULED_AT,
    expectedApprovedAt: APPROVED_AT,
    expectedPrivacyLevel: 'SELF_ONLY'
  };

  const result = await service.cancelApprovedPost(createExecutionContext({
    userId: 'owner',
    actorId: 'admin:owner',
    source: 'website',
    workspaceId: WORKSPACE_ID
  }), input);
  assert.equal(result.outcome, 'cancelled');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].postId, 'job-exact');
  assert.deepEqual(
    {
      batchId: calls[0].options.batchId,
      expectedScheduledAt: calls[0].options.expectedScheduledAt,
      expectedApprovedAt: calls[0].options.expectedApprovedAt,
      expectedPrivacyLevel: calls[0].options.expectedPrivacyLevel
    },
    {
      batchId: 'batch-exact',
      expectedScheduledAt: SCHEDULED_AT,
      expectedApprovedAt: APPROVED_AT,
      expectedPrivacyLevel: 'SELF_ONLY'
    }
  );

  await assert.rejects(
    service.cancelApprovedPost(createExecutionContext({
      userId: 'owner',
      source: 'runtime',
      workspaceId: WORKSPACE_ID
    }), input),
    (error) => error instanceof AutoPosterApplicationError && error.code === 'forbidden'
  );
  assert.equal(calls.length, 1);
});

test('cancelled child truth derives a cancelled batch instead of reopening approval', () => {
  const { createBatchService } = require('../src/batchService');
  const service = createBatchService();
  const derived = service.deriveBatchStatus([{
    itemState: 'cancelled',
    preparation: { status: 'succeeded' }
  }]);
  assert.equal(derived.status, 'cancelled');
  assert.equal(derived.counts.cancelled, 1);
  assert.equal(derived.counts.accepted, 0);
});
