'use strict';

// A YouTube attempt that fails before the provider owns anything must stay
// resumable. The persisted provider operation blocks a fresh claim only once
// it has actually reached the provider — otherwise a re-approved job could
// never publish, because nothing exists to reconcile either.

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  appendProviderOperationEvent,
  createInitialYouTubeProviderOperation,
  providerOperationAllowsFreshAttempt,
  transitionProviderOperation
} = require('../src/youtubeProviderOperation');

function timestamp(value) {
  return {
    toDate: () => new Date(value),
    toMillis: () => new Date(value).getTime()
  };
}

function youtubeJob(overrides = {}) {
  return {
    userId: 'owner',
    workspaceId: 'workspace-owner',
    provider: 'youtube',
    platform: 'youtube',
    accountId: 'UC-chanter',
    connectedAccountId: 'youtube:UC-chanter',
    username: 'chantercy',
    mediaType: 'video',
    mediaUrl: 'https://media.example.test/proof.mp4',
    providerMetadata: {
      youtube: { title: 'Exact proof title', description: '' }
    },
    status: 'scheduled',
    scheduledAt: timestamp('2026-07-18T11:05:00.000Z'),
    approvedAt: timestamp('2026-07-18T11:01:40.847Z'),
    approvedBy: 'admin:owner',
    claimAttempts: 0,
    publishAttemptBudget: 1,
    providerOperation: null,
    history: [],
    createdAt: timestamp('2026-07-18T10:59:00.000Z'),
    updatedAt: timestamp('2026-07-18T10:59:00.000Z'),
    ...overrides
  };
}

/**
 * The operation shape a worker claim writes, at the requested attempt. The
 * claim builds it from postFromDoc(), so approval timestamps arrive as ISO
 * strings rather than the Firestore Timestamps on the raw record.
 */
function claimedOperation(queueId, attemptNumber, overrides = {}) {
  return {
    ...createInitialYouTubeProviderOperation({
      queueId,
      post: {
        ...youtubeJob(),
        approvedAt: '2026-07-18T11:01:40.847Z',
        approvedBy: 'admin:owner'
      },
      attemptNumber,
      now: '2026-07-18T11:05:04.892Z'
    }),
    ...overrides
  };
}

const CREDENTIAL_GATE_FAILURE = {
  ok: false,
  mode: 'api',
  code: 'reauthorization_required',
  providerMutationStarted: false,
  failureBoundary: 'before_provider_upload_session',
  reason: 'YouTube channel requires reauthorization; reconnect it before publishing.'
};

const VERIFIED_PRIVATE_UPLOAD = {
  ok: true,
  mode: 'api',
  providerMutationStarted: true,
  providerStatus: 'uploaded_private',
  response: {
    video_id: 'ytVideoProof001',
    privacy_status: 'private',
    upload_status: 'uploaded',
    channel_id: 'UC-chanter',
    upload_method: 'resumable'
  },
  providerVerification: {
    ok: true,
    provider: 'youtube',
    externalVideoId: 'ytVideoProof001',
    channelId: 'UC-chanter',
    channelTitle: 'CHANTER',
    channelHandle: '@chanterCy',
    title: 'Exact proof title',
    privacyStatus: 'private',
    uploadStatus: 'uploaded',
    processingStatus: 'succeeded',
    verifiedAt: '2026-07-18T12:05:00.000Z',
    uploadMethod: 'resumable'
  }
};

function installHarness(t, seededRecords, adapterResults) {
  const firestorePath = require.resolve('../src/firestore');
  const tiktokPath = require.resolve('../src/tiktok');
  const instagramPath = require.resolve('../src/instagram');
  const mapperPath = require.resolve('../src/postsMapper');
  const schedulerPath = require.resolve('../src/scheduler');
  const youtubePath = require.resolve('../src/youtube');
  const modulePaths = [firestorePath, tiktokPath, instagramPath, mapperPath, schedulerPath, youtubePath];
  for (const modulePath of modulePaths) delete require.cache[modulePath];

  const serverTimestamp = timestamp('2026-07-18T12:29:08.352Z');
  const records = new Map(Object.entries(seededRecords));
  const document = (id) => ({
    id,
    get exists() { return records.has(id); },
    data: () => records.get(id)
  });
  const applyUpdate = (id, patch) => {
    const next = { ...records.get(id) };
    for (const [key, value] of Object.entries(patch)) {
      next[key] = value && value.__increment
        ? Number(next[key] || 0) + value.__increment
        : value;
    }
    records.set(id, next);
  };

  require.cache[firestorePath] = {
    id: firestorePath,
    filename: firestorePath,
    loaded: true,
    exports: {
      postsCollection: () => ({ doc: (id) => ({ id }) }),
      getFirestore: () => ({
        runTransaction: async (callback) => callback({
          get: async (ref) => document(ref.id),
          update: (ref, patch) => applyUpdate(ref.id, patch)
        })
      }),
      Timestamp: {
        now: () => serverTimestamp,
        fromDate: (date) => timestamp(date.toISOString()),
        fromMillis: (value) => timestamp(new Date(value).toISOString())
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
    exports: { publishPhotoPost: async () => { throw new Error('TikTok must not be called'); } }
  };
  require.cache[instagramPath] = {
    id: instagramPath,
    filename: instagramPath,
    loaded: true,
    exports: {
      getInstagramHealth: async () => ({ configured: false, canPublish: false }),
      publishInstagramMedia: async () => { throw new Error('Instagram must not be called'); }
    }
  };

  const adapterCalls = [];
  require.cache[youtubePath] = {
    id: youtubePath,
    filename: youtubePath,
    loaded: true,
    exports: {
      publishScheduledYouTubePost: async (post) => {
        adapterCalls.push(post);
        const step = adapterResults[adapterCalls.length - 1];
        if (!step) throw new Error('Unexpected extra provider attempt.');
        return typeof step === 'function' ? step(post, records) : step;
      }
    }
  };

  const loadScheduler = () => {
    delete require.cache[schedulerPath];
    return require('../src/scheduler');
  };
  t.after(() => {
    for (const modulePath of modulePaths) delete require.cache[modulePath];
  });
  return { records, loadScheduler, adapterCalls };
}

test('a credential-gate failure leaves the job resumable, and one re-approval publishes it', async (t) => {
  const harness = installHarness(t, { proof: youtubeJob() }, [
    // Attempt 1 mirrors the real adapter: it binds the media identity, then
    // fails at the credential gate before creating any provider session.
    (post, records) => {
      const record = records.get('proof');
      records.set('proof', {
        ...record,
        providerOperation: appendProviderOperationEvent(
          transitionProviderOperation(record.providerOperation, 'media_preflighted'),
          'media_preflight_bound',
          {},
          '2026-07-18T11:05:05.100Z'
        )
      });
      return CREDENTIAL_GATE_FAILURE;
    },
    VERIFIED_PRIVATE_UPLOAD
  ]);
  const scheduler = harness.loadScheduler();

  const first = await scheduler.processPost('proof', {
    workerId: 'worker-1',
    now: new Date('2026-07-18T11:05:04.892Z')
  });
  assert.equal(first.ok, false);

  const afterFirst = harness.records.get('proof');
  assert.equal(afterFirst.status, 'failed');
  assert.equal(afterFirst.claimAttempts, 1);
  assert.equal(afterFirst.providerOperation.operationState, 'media_preflighted');
  assert.equal(afterFirst.providerOperation.sessionCreatedAt, null);
  assert.equal(afterFirst.providerOperation.externalVideoId, null);

  // The founder reconnects the channel and approves once more. storage
  // .approvePost grants exactly one further claim.
  harness.records.set('proof', {
    ...afterFirst,
    approvedAt: timestamp('2026-07-18T12:00:00.000Z'),
    approvedBy: 'admin:owner',
    publishAttemptBudget: Number(afterFirst.claimAttempts || 0) + 1
  });

  const second = await scheduler.processPost('proof', { force: true, workerId: 'worker-2' });
  assert.equal(second.ok, true, second.reason);
  assert.equal(harness.adapterCalls.length, 2);

  const posted = harness.records.get('proof');
  assert.equal(posted.status, 'posted');
  assert.equal(posted.publishId, 'ytVideoProof001');
  assert.equal(posted.providerStatus, 'uploaded_private');
  assert.equal(posted.providerVerification.privacyStatus, 'private');
  assert.equal(posted.providerVerification.externalVideoId, 'ytVideoProof001');
  // The replacement operation belongs to the second authorized attempt.
  assert.equal(posted.claimAttempts, 2);
  assert.notEqual(
    posted.providerOperation.providerAttemptId,
    afterFirst.providerOperation.providerAttemptId
  );
});

test('the approval budget still bounds a resumable operation', async (t) => {
  const harness = installHarness(t, {
    proof: youtubeJob({
      status: 'failed',
      claimAttempts: 1,
      publishAttemptBudget: 1,
      providerOperation: claimedOperation('proof', 1)
    })
  }, []);
  const scheduler = harness.loadScheduler();

  const replay = await scheduler.processPost('proof', { force: true, workerId: 'worker-2' });
  assert.equal(replay.code, 'PUBLISH_ATTEMPT_BUDGET_EXHAUSTED');
  assert.equal(harness.adapterCalls.length, 0, 'an exhausted approval never reaches the provider');
});

test('an operation that reached the provider still blocks every fresh claim', async (t) => {
  const reached = {
    session_persisted: appendProviderOperationEvent(
      {
        ...transitionProviderOperation(
          transitionProviderOperation(claimedOperation('proof', 1), 'media_preflighted'),
          'session_persisted'
        ),
        sessionCreatedAt: '2026-07-18T11:05:06.000Z',
        sessionLocatorEnvelope: { v: 1, alg: 'aes-256-gcm', iv: 'iv', tag: 'tag', ciphertext: 'c' }
      },
      'session_initiated',
      {},
      '2026-07-18T11:05:06.000Z'
    ),
    outcome_unknown: appendProviderOperationEvent(
      {
        ...transitionProviderOperation(
          transitionProviderOperation(
            transitionProviderOperation(claimedOperation('proof', 1), 'media_preflighted'),
            'session_persisted'
          ),
          'outcome_unknown'
        ),
        sessionCreatedAt: '2026-07-18T11:05:06.000Z'
      },
      'outcome_unknown',
      { errorCode: 'PROVIDER_OUTCOME_UNKNOWN' },
      '2026-07-18T11:05:09.000Z'
    ),
    terminal_failure: transitionProviderOperation(claimedOperation('proof', 1), 'terminal_failure')
  };

  for (const [label, providerOperation] of Object.entries(reached)) {
    const harness = installHarness(t, {
      proof: youtubeJob({
        status: 'failed',
        claimAttempts: 1,
        publishAttemptBudget: 2,
        providerOperation
      })
    }, []);
    const scheduler = harness.loadScheduler();
    const blocked = await scheduler.processPost('proof', { force: true, workerId: 'worker-2' });
    assert.equal(blocked.code, 'PROVIDER_OPERATION_UNRESOLVED', `${label} must stay blocked`);
    assert.equal(harness.adapterCalls.length, 0, `${label} must not reach the provider`);
  }
});

test('providerOperationAllowsFreshAttempt fails closed on anything it cannot read', () => {
  assert.equal(providerOperationAllowsFreshAttempt(null), true);
  assert.equal(providerOperationAllowsFreshAttempt(claimedOperation('proof', 1)), true);

  const pending = claimedOperation('proof', 1);
  assert.equal(providerOperationAllowsFreshAttempt({ ...pending, schemaVersion: 'other' }), false);
  assert.equal(providerOperationAllowsFreshAttempt({ ...pending, provider: 'tiktok' }), false);
  assert.equal(providerOperationAllowsFreshAttempt({ ...pending, connectedAccountId: 'youtube:other' }), false);
  assert.equal(providerOperationAllowsFreshAttempt({ ...pending, operationState: 'not-a-state' }), false);
  assert.equal(providerOperationAllowsFreshAttempt({ ...pending, externalVideoId: 'ytVideoProof001' }), false);
  assert.equal(providerOperationAllowsFreshAttempt({ ...pending, sessionCreatedAt: '2026-07-18T11:05:06.000Z' }), false);
  assert.equal(providerOperationAllowsFreshAttempt({ ...pending, uploadStartedAt: '2026-07-18T11:05:07.000Z' }), false);
  assert.equal(
    providerOperationAllowsFreshAttempt({ ...pending, sessionLocatorEnvelope: { ciphertext: 'c' } }),
    false,
    'a persisted locator is reconcilable state even if the row lost its timestamps'
  );
  assert.equal(
    providerOperationAllowsFreshAttempt(appendProviderOperationEvent(pending, 'session_persistence_failed', {}, '2026-07-18T11:05:06.000Z')),
    false,
    'a session the provider created but persistence lost must never be replaced'
  );
  assert.equal(
    providerOperationAllowsFreshAttempt(appendProviderOperationEvent(pending, 'upload_put_attempted', { acceptedByteOffset: 0 }, '2026-07-18T11:05:07.000Z')),
    false,
    'a recorded byte attempt must never be replaced'
  );
});
