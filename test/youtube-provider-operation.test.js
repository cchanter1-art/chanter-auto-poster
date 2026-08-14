'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  PROVIDER_OPERATION_EVENT_LIMIT,
  PROVIDER_RECONCILIATION_ATTEMPT_BUDGET,
  RECEIPT_METHOD,
  appendProviderOperationEvent,
  canonicalSha256,
  createInitialYouTubeProviderOperation,
  deriveMutationSummary,
  operationMediaBinding,
  sanitizeProviderOperation,
  sanitizeProviderStatusReceipt
} = require('../src/youtubeProviderOperation');
const { mapPatchToFirestore, postFromDoc } = require('../src/postsMapper');

function post() {
  return {
    userId: 'owner',
    workspaceId: 'workspace-1',
    accountId: 'UC-exact',
    connectedAccountId: 'youtube:UC-exact',
    runtimeMissionId: 'graph:g:node:n',
    runtimeGraphId: 'graph:g',
    runtimeAction: 'autoposter.post.schedule',
    runtimePayloadHash: 'a'.repeat(64),
    approvedBy: 'founder',
    approvedAt: '2026-07-19T11:59:00.000Z'
  };
}

function operation() {
  return createInitialYouTubeProviderOperation({
    queueId: 'queue-1', post: post(), attemptNumber: 1, now: '2026-07-19T12:00:00.000Z'
  });
}

function boundOperation() {
  const value = operation();
  const media = {
    mediaSha256: 'b'.repeat(64),
    mediaByteSize: 4096,
    mediaMimeType: 'video/mp4',
    mediaContainer: 'mp4',
    mediaFileName: 'proof.mp4',
    mediaSourceId: `local:${'c'.repeat(64)}`
  };
  Object.assign(value, media, {
    bindingSha256: canonicalSha256(operationMediaBinding(value, media)),
    operationState: 'media_preflighted'
  });
  value.events = appendProviderOperationEvent(value, 'media_preflight_bound').events;
  return value;
}

function receipt(overrides = {}) {
  const facts = {
    provider: 'youtube',
    queueId: 'queue-1',
    providerOperationId: operation().providerOperationId,
    providerAttemptId: operation().providerAttemptId,
    userId: 'owner',
    workspaceId: 'workspace-1',
    runtimeMissionId: 'graph:g:node:n',
    graphId: 'graph:g',
    mediaSha256: 'b'.repeat(64),
    approvedMedia: {
      sha256: 'b'.repeat(64), byteSize: 4096, mimeType: 'video/mp4', fileName: 'proof.mp4', container: 'mp4'
    },
    providerProofMode: true,
    configuredAccountId: 'UC-exact',
    connectedAccountId: 'youtube:UC-exact',
    verifiedChannelId: 'UC-exact',
    authenticatedChannelId: 'UC-exact',
    safeChannelTitle: 'CHANTER',
    safeChannelHandle: '@chanter',
    externalVideoId: 'video-1',
    expectedTitle: 'Exact proof title',
    exactTitleMatch: true,
    artifactExists: true,
    privacyStatus: 'private',
    uploadStatus: 'processed',
    processingStatus: 'succeeded',
    verificationMethod: RECEIPT_METHOD,
    verificationTimestamp: '2026-07-19T12:00:00.000Z',
    canonicalResponseSha256: 'd'.repeat(64),
    ...overrides
  };
  return facts;
}

test('initial provider operation durably binds exact queue, mission, account, and attempt identity', () => {
  const value = sanitizeProviderOperation(operation());
  assert.equal(value.queueId, 'queue-1');
  assert.equal(value.accountId, 'UC-exact');
  assert.equal(value.connectedAccountId, 'youtube:UC-exact');
  assert.equal(value.runtimeMissionId, 'graph:g:node:n');
  assert.match(value.providerOperationId, /^ytop_[a-f0-9]{64}$/);
  assert.match(value.providerAttemptId, /^ytatt_[a-f0-9]{64}$/);
  assert.equal(value.operationState, 'operation_pending');
});

test('provider operation and attempt IDs are deterministic for the exact durable input', () => {
  assert.equal(operation().providerOperationId, operation().providerOperationId);
  assert.equal(operation().providerAttemptId, operation().providerAttemptId);
  const second = createInitialYouTubeProviderOperation({ queueId: 'queue-1', post: post(), attemptNumber: 2 });
  assert.notEqual(second.providerOperationId, operation().providerOperationId);
  assert.notEqual(second.providerAttemptId, operation().providerAttemptId);
});

test('media SHA-256, byte size, MIME, name, source, and full identity produce one binding digest', () => {
  const safe = sanitizeProviderOperation(boundOperation());
  assert.equal(safe.mediaSha256, 'b'.repeat(64));
  assert.equal(safe.mediaByteSize, 4096);
  assert.equal(safe.mediaMimeType, 'video/mp4');
  assert.equal(safe.mediaFileName, 'proof.mp4');
  assert.match(safe.bindingSha256, /^[a-f0-9]{64}$/);
});

test('incomplete media identity is never partially exposed', () => {
  const value = boundOperation();
  value.mediaSha256 = 'bad';
  const safe = sanitizeProviderOperation(value);
  assert.equal(safe.mediaSha256, null);
  assert.equal(safe.mediaByteSize, null);
  assert.equal(safe.bindingSha256, null);
});

test('encrypted or raw session locator fields are absent from the safe operation projection', () => {
  const value = boundOperation();
  value.sessionLocatorEnvelope = { v: 1, alg: 'aes-256-gcm', iv: 'canary', ct: 'canary', tag: 'canary' };
  value.sessionUrl = 'https://www.googleapis.com/upload/session/canary';
  const serialized = JSON.stringify(sanitizeProviderOperation(value));
  assert.equal(serialized.includes('sessionLocator'), false);
  assert.equal(serialized.includes('/upload/session/'), false);
});

test('generic post patches cannot replace provider-operation custody', () => {
  const patch = mapPatchToFirestore({ providerOperation: operation(), caption: 'safe' });
  assert.equal('providerOperation' in patch, false);
  assert.equal(patch.caption, 'safe');
});

test('post mapping exposes only the safe provider-operation view', () => {
  const raw = boundOperation();
  raw.sessionLocatorEnvelope = { v: 1, alg: 'aes-256-gcm', iv: 'iv', ct: 'ct', tag: 'tag' };
  const mapped = postFromDoc({ id: 'queue-1', data: () => ({ ...post(), provider: 'youtube', providerOperation: raw }) });
  assert.equal(mapped.providerOperation.queueId, 'queue-1');
  assert.equal(JSON.stringify(mapped).includes('sessionLocatorEnvelope'), false);
});

test('mutation accounting is derived from durable events and reports zero update/delete operations', () => {
  let value = boundOperation();
  value = appendProviderOperationEvent(value, 'session_initiated');
  value = appendProviderOperationEvent(value, 'upload_put_attempted', { acceptedByteOffset: 0 });
  value = appendProviderOperationEvent(value, 'artifact_confirmed', { externalVideoId: 'video-1' });
  const summary = deriveMutationSummary(value.events);
  assert.deepEqual(summary, {
    providerSessionInitiationCount: 1,
    mediaUploadAttemptCount: 1,
    confirmedVideoArtifactCount: 1,
    existingResourceUpdateCount: 0,
    deleteCount: 0,
    reconciliationStatusReadCount: 0
  });
});

test('failed encrypted locator persistence still counts the provider-side session initiation', () => {
  const at = '2026-07-19T12:00:00.000Z';
  let operation = createInitialYouTubeProviderOperation({
    queueId: 'job-session-persistence-failed',
    post: post(),
    attemptNumber: 1,
    now: at
  });
  operation = appendProviderOperationEvent(
    operation,
    'session_persistence_failed',
    { errorCode: 'SESSION_PERSISTENCE_FAILED' },
    at
  );
  const safe = sanitizeProviderOperation(operation);
  assert.equal(safe.mutationSummary.providerSessionInitiationCount, 1);
  assert.equal(safe.mutationSummary.mediaUploadAttemptCount, 0);
  assert.equal(safe.mutationSummary.confirmedVideoArtifactCount, 0);
});

test('safe provider receipt uses a closed allowlist and canonical proof hash', () => {
  const safe = sanitizeProviderStatusReceipt({
    ...receipt(),
    rawResponse: { accessToken: 'forbidden' },
    sessionUrl: 'https://example.invalid/session'
  });
  assert.deepEqual(Object.keys(safe).sort(), [
    'approvedMedia', 'artifactExists', 'authenticatedChannelId', 'canonicalResponseSha256', 'configuredAccountId', 'connectedAccountId',
    'exactTitleMatch', 'expectedTitle', 'externalVideoId', 'graphId', 'mediaSha256', 'privacyStatus',
    'processingStatus', 'provider', 'providerAttemptId', 'providerOperationId', 'providerProofMode', 'queueId',
    'requestedVisibility', 'runtimeMissionId',
    'safeChannelHandle', 'safeChannelTitle', 'uploadStatus', 'userId', 'verificationMethod',
    'verificationTimestamp', 'verifiedChannelId', 'workspaceId'
  ]);
  assert.equal(JSON.stringify(safe).includes('rawResponse'), false);
});

test('provider receipt rejects mismatched connected-account identity', () => {
  assert.equal(sanitizeProviderStatusReceipt(receipt({ connectedAccountId: 'youtube:UC-other' })), null);
});

test('bounded operation events retain only the newest safe entries', () => {
  let value = operation();
  for (let index = 0; index < PROVIDER_OPERATION_EVENT_LIMIT + 8; index += 1) {
    value = appendProviderOperationEvent(value, 'session_status_read');
  }
  assert.equal(value.events.length, PROVIDER_OPERATION_EVENT_LIMIT);
  assert.equal(sanitizeProviderOperation(value).eventCount, PROVIDER_OPERATION_EVENT_LIMIT);
});

test('reconciliation budget is explicit and event digests are deterministic', () => {
  const first = sanitizeProviderOperation(operation());
  const second = sanitizeProviderOperation(operation());
  assert.equal(first.reconciliationAttemptBudget, PROVIDER_RECONCILIATION_ATTEMPT_BUDGET);
  assert.equal(first.eventDigestSha256, second.eventDigestSha256);
});
