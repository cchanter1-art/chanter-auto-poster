'use strict';

// Requested YouTube visibility: who may ask for it, what binds it, and what
// counts as proof that the provider honored it.
//
// The rules under test, in one sentence each:
//   - private is the default and the fail-closed value everywhere;
//   - a job may request public only if it says so explicitly AND the
//     deployment authorizes it;
//   - the approved visibility is hashed into the provider operation id, so
//     post-approval drift cannot reach the provider;
//   - a completion is proven against the visibility that was approved, and a
//     provider artifact MORE exposed than approved is always a contradiction.
//
// The real storage receipt-recording transaction runs here against a
// Firestore fake, so the completion predicate under test is the production
// one, not a restatement of it.

const assert = require('node:assert/strict');
const test = require('node:test');
const { randomBytes } = require('node:crypto');

const {
  canonicalSha256,
  completionStateForVisibility,
  createInitialYouTubeProviderOperation,
  operationMediaBinding,
  providerUploadStatus,
  sanitizeProviderOperation,
  sanitizeProviderStatusReceipt,
  sanitizeRequestedVisibility,
  visibilityExceedsRequest
} = require('../src/youtubeProviderOperation');
const { sanitizeProviderVerification } = require('../src/postsMapper');

const ACCOUNT_ID = 'UC-chanter';
const MEDIA_SHA = 'b'.repeat(64);

function approvedPost(visibility, overrides = {}) {
  return {
    userId: 'owner',
    workspaceId: 'workspace-owner',
    accountId: ACCOUNT_ID,
    connectedAccountId: `youtube:${ACCOUNT_ID}`,
    approvedBy: 'admin:owner',
    approvedAt: '2026-08-13T10:00:00.000Z',
    runtimeMissionId: 'graph:g1:node:n1',
    runtimeGraphId: 'g1',
    runtimeAction: 'autoposter.post.schedule',
    runtimePayloadHash: 'a'.repeat(64),
    providerProofMode: true,
    approvedMedia: {
      sha256: MEDIA_SHA, byteSize: 2048, mimeType: 'video/mp4',
      fileName: 'proof.mp4', container: 'mp4'
    },
    providerMetadata: {
      youtube: { title: 'Exact proof title', description: '', privacyStatus: visibility, notifySubscribers: false }
    },
    ...overrides
  };
}

/** An operation that has reached the provider and owns one confirmed video. */
function uploadedOperation(visibility) {
  const base = createInitialYouTubeProviderOperation({
    queueId: 'queue-1',
    post: approvedPost(visibility),
    attemptNumber: 1,
    now: '2026-08-13T10:00:01.000Z'
  });
  const media = {
    mediaSha256: MEDIA_SHA, mediaByteSize: 2048, mediaMimeType: 'video/mp4',
    mediaContainer: 'mp4', mediaFileName: 'proof.mp4', mediaSourceId: 'uploads/proof.mp4'
  };
  return {
    ...base,
    ...media,
    bindingSha256: canonicalSha256(operationMediaBinding(base, media)),
    operationState: 'uploading',
    sessionCreatedAt: '2026-08-13T10:00:02.000Z',
    externalVideoId: 'ytProofVideo01'
  };
}

function receiptFor(operation, { privacyStatus, requestedVisibility }) {
  const providerFacts = {
    videoId: 'ytProofVideo01',
    channelId: ACCOUNT_ID,
    channelOwnedByAuthenticatedIdentity: true,
    title: 'Exact proof title',
    privacyStatus,
    uploadStatus: 'processed',
    processingStatus: 'succeeded'
  };
  return {
    provider: 'youtube',
    queueId: operation.queueId,
    providerOperationId: operation.providerOperationId,
    providerAttemptId: operation.providerAttemptId,
    userId: operation.userId,
    workspaceId: operation.workspaceId,
    runtimeMissionId: operation.runtimeMissionId,
    graphId: operation.graphId,
    mediaSha256: MEDIA_SHA,
    approvedMedia: operation.approvedMedia,
    providerProofMode: true,
    configuredAccountId: ACCOUNT_ID,
    connectedAccountId: `youtube:${ACCOUNT_ID}`,
    verifiedChannelId: ACCOUNT_ID,
    authenticatedChannelId: ACCOUNT_ID,
    safeChannelTitle: 'chanter',
    safeChannelHandle: '@chantercy',
    externalVideoId: 'ytProofVideo01',
    expectedTitle: 'Exact proof title',
    exactTitleMatch: true,
    artifactExists: true,
    requestedVisibility,
    privacyStatus,
    uploadStatus: 'processed',
    processingStatus: 'succeeded',
    verificationMethod: 'youtube.videos.list+youtube.channels.list',
    verificationTimestamp: '2026-08-13T10:00:30.000Z',
    canonicalResponseSha256: canonicalSha256(providerFacts)
  };
}

/**
 * Loads the real storage module over a Firestore fake holding one queue
 * document, so recordYouTubeProviderStatusReceipt runs its production
 * transaction.
 */
function loadStorageOver(record, t) {
  const firestorePath = require.resolve('../src/firestore');
  const storagePath = require.resolve('../src/storage');
  for (const modulePath of [firestorePath, storagePath]) delete require.cache[modulePath];

  const now = { toDate: () => new Date('2026-08-13T10:00:31.000Z'), toMillis: () => Date.parse('2026-08-13T10:00:31.000Z') };
  const records = new Map([['queue-1', record]]);
  const document = (id) => ({ id, get exists() { return records.has(id); }, data: () => records.get(id) });
  require.cache[firestorePath] = {
    id: firestorePath, filename: firestorePath, loaded: true,
    exports: {
      postsCollection: () => ({ doc: (id) => ({ id }) }),
      getFirestore: () => ({
        runTransaction: async (callback) => callback({
          get: async (ref) => document(ref.id),
          update: (ref, patch) => records.set(ref.id, { ...records.get(ref.id), ...patch })
        })
      }),
      Timestamp: { now: () => now, fromDate: () => now, fromMillis: () => now },
      FieldValue: { serverTimestamp: () => now, increment: (value) => ({ __increment: value }) }
    }
  };
  t.after(() => {
    for (const modulePath of [firestorePath, storagePath]) delete require.cache[modulePath];
  });
  return { storage: require('../src/storage'), records };
}

async function recordReceipt(t, { approvedVisibility, providerVisibility, receiptVisibility }) {
  const operation = uploadedOperation(approvedVisibility);
  const { storage, records } = loadStorageOver({
    userId: 'owner',
    workspaceId: 'workspace-owner',
    accountId: ACCOUNT_ID,
    provider: 'youtube',
    providerOperation: operation
  }, t);
  const receipt = receiptFor(operation, {
    privacyStatus: providerVisibility,
    requestedVisibility: receiptVisibility ?? approvedVisibility
  });
  const result = await storage.recordYouTubeProviderStatusReceipt({
    userId: 'owner',
    postId: 'queue-1',
    accountId: ACCOUNT_ID,
    providerOperationId: operation.providerOperationId,
    providerAttemptId: operation.providerAttemptId,
    providerStatusReceipt: receipt,
    providerStatusReceiptSha256: canonicalSha256(sanitizeProviderStatusReceipt(receipt))
  });
  return { result, records };
}

// ── Fail-closed defaults ──────────────────────────────────────────────────

test('every unreadable or unimplemented visibility falls back to private', () => {
  for (const value of ['unlisted', '', null, undefined, 42, {}, 'publi', 'x'.repeat(64)]) {
    assert.equal(sanitizeRequestedVisibility(value), 'private');
  }
  assert.equal(sanitizeRequestedVisibility('public'), 'public');
  assert.equal(sanitizeRequestedVisibility('private'), 'private');
  // Case and surrounding whitespace are normalized, not widened: the stored
  // form is always canonical, so this only makes reads of it forgiving.
  assert.equal(sanitizeRequestedVisibility('PUBLIC '), 'public');
  assert.equal(sanitizeRequestedVisibility(' Private'), 'private');
});

test('a queue record without an explicit visibility is a private operation', () => {
  const post = approvedPost('private');
  delete post.providerMetadata;
  const operation = createInitialYouTubeProviderOperation({ queueId: 'queue-1', post, attemptNumber: 1 });
  assert.equal(sanitizeProviderOperation(operation).requestedVisibility, 'private');
});

// ── Identity binding ──────────────────────────────────────────────────────

test('the approved visibility is part of the provider operation identity', () => {
  const asPrivate = createInitialYouTubeProviderOperation({
    queueId: 'queue-1', post: approvedPost('private'), attemptNumber: 1, now: '2026-08-13T10:00:01.000Z'
  });
  const asPublic = createInitialYouTubeProviderOperation({
    queueId: 'queue-1', post: approvedPost('public'), attemptNumber: 1, now: '2026-08-13T10:00:01.000Z'
  });
  // Same queue, same approval, same media, same attempt — only the approved
  // visibility differs, and that alone must mint a different operation id.
  assert.notEqual(asPrivate.providerOperationId, asPublic.providerOperationId);
  assert.notEqual(asPrivate.providerAttemptId, asPublic.providerAttemptId);
  assert.equal(sanitizeProviderOperation(asPublic).requestedVisibility, 'public');
});

// ── Completion and contradiction ──────────────────────────────────────────

test('exposure ranking treats only over-exposure as a contradiction', () => {
  assert.equal(visibilityExceedsRequest('public', 'private'), true);
  assert.equal(visibilityExceedsRequest('unlisted', 'private'), true);
  assert.equal(visibilityExceedsRequest('private', 'private'), false);
  assert.equal(visibilityExceedsRequest('public', 'public'), false);
  assert.equal(visibilityExceedsRequest('unlisted', 'public'), false);
  assert.equal(visibilityExceedsRequest('private', 'public'), false);
  assert.equal(visibilityExceedsRequest('nonsense', 'private'), false);
  assert.equal(completionStateForVisibility('public'), 'completed_public');
  assert.equal(completionStateForVisibility('private'), 'completed_private');
  assert.equal(providerUploadStatus('public'), 'uploaded_public');
  assert.equal(providerUploadStatus('private'), 'uploaded_private');
});

test('an approved public job that reads back public completes as completed_public', async (t) => {
  const { result } = await recordReceipt(t, { approvedVisibility: 'public', providerVisibility: 'public' });
  assert.equal(result.outcome, 'completed_public');
  assert.equal(result.safeOperation.operationState, 'completed_public');
  assert.equal(result.safeOperation.lastOperationErrorCode, null);
  assert.equal(result.safeOperation.providerStatusReceipt.privacyStatus, 'public');
});

test('an approved private job that reads back private still completes as completed_private', async (t) => {
  const { result } = await recordReceipt(t, { approvedVisibility: 'private', providerVisibility: 'private' });
  assert.equal(result.outcome, 'completed_private');
  assert.equal(result.safeOperation.lastOperationErrorCode, null);
});

test('an approved private job that reads back public is a visibility contradiction', async (t) => {
  const { result } = await recordReceipt(t, { approvedVisibility: 'private', providerVisibility: 'public' });
  assert.equal(result.outcome, 'contradictory_public');
  assert.equal(result.safeOperation.lastOperationErrorCode, 'CONTRADICTORY_PUBLIC');
});

test('an approved private job that reads back unlisted is a visibility contradiction', async (t) => {
  const { result } = await recordReceipt(t, { approvedVisibility: 'private', providerVisibility: 'unlisted' });
  assert.equal(result.outcome, 'contradictory_public');
});

test('an approved public job that reads back private is unresolved, never a success', async (t) => {
  const { result } = await recordReceipt(t, { approvedVisibility: 'public', providerVisibility: 'private' });
  assert.equal(result.outcome, 'outcome_unknown');
  assert.equal(result.safeOperation.operationState, 'outcome_unknown');
});

test('a receipt for a different visibility than the operation was approved for is rejected', async (t) => {
  const { result } = await recordReceipt(t, {
    approvedVisibility: 'private',
    providerVisibility: 'private',
    receiptVisibility: 'public'
  });
  assert.equal(result.outcome, 'identity_mismatch');
  assert.equal(result.safeOperation.operationState, 'uploading');
});

// ── Deployment authorization ceiling ──────────────────────────────────────

test('public is refused before the provider unless the deployment authorizes it', async (t) => {
  const configPath = require.resolve('../src/config');
  const providersPath = require.resolve('../src/providers');
  const youtubePath = require.resolve('../src/youtube');
  const paths = [configPath, providersPath, youtubePath];
  const previous = {
    privateOnly: process.env.YOUTUBE_PRIVATE_ONLY,
    key: process.env.TOKEN_ENCRYPTION_KEY,
    clientId: process.env.YOUTUBE_CLIENT_ID,
    clientSecret: process.env.YOUTUBE_CLIENT_SECRET,
    redirectUri: process.env.YOUTUBE_REDIRECT_URI
  };
  t.after(() => {
    for (const [name, value] of [
      ['YOUTUBE_PRIVATE_ONLY', previous.privateOnly],
      ['TOKEN_ENCRYPTION_KEY', previous.key],
      ['YOUTUBE_CLIENT_ID', previous.clientId],
      ['YOUTUBE_CLIENT_SECRET', previous.clientSecret],
      ['YOUTUBE_REDIRECT_URI', previous.redirectUri]
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    for (const modulePath of paths) delete require.cache[modulePath];
  });
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  process.env.YOUTUBE_CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
  process.env.YOUTUBE_CLIENT_SECRET = 'test-client-secret';
  process.env.YOUTUBE_REDIRECT_URI = 'http://localhost:10000/auth/youtube/callback';

  const load = () => {
    for (const modulePath of paths) delete require.cache[modulePath];
    return { providers: require('../src/providers'), youtube: require('../src/youtube') };
  };

  // Default deployment: private only.
  delete process.env.YOUTUBE_PRIVATE_ONLY;
  let loaded = load();
  let status = loaded.providers.getYouTubeConfigStatus();
  assert.deepEqual([...status.allowedVisibilities], ['private']);
  // The provider stays configured either way — the ceiling is not a
  // configuration defect.
  assert.equal(status.configured, true);

  const publicJob = {
    id: 'queue-1',
    ...approvedPost('public'),
    mediaType: 'video',
    mediaUrl: 'https://res.cloudinary.com/test/video/upload/proof.mp4',
    providerOperation: uploadedOperation('public')
  };
  let refusal = await loaded.youtube.publishScheduledYouTubePost(publicJob);
  assert.equal(refusal.ok, false);
  assert.equal(refusal.code, 'PROVIDER_VISIBILITY_NOT_AUTHORIZED');
  assert.equal(refusal.providerMutationStarted, false);
  assert.equal(refusal.failureBoundary, 'before_provider_upload_session');

  // A private job on the same deployment passes the visibility gate and is
  // stopped later, by the credential/media gates — never by visibility.
  const privateJob = {
    id: 'queue-1',
    ...approvedPost('private'),
    mediaType: 'video',
    mediaUrl: 'https://res.cloudinary.com/test/video/upload/proof.mp4',
    providerOperation: uploadedOperation('private')
  };
  const privateResult = await loaded.youtube.publishScheduledYouTubePost(privateJob);
  assert.equal(privateResult.ok, false);
  assert.notEqual(privateResult.code, 'PROVIDER_VISIBILITY_NOT_AUTHORIZED');

  // Authorized deployment: public becomes requestable.
  process.env.YOUTUBE_PRIVATE_ONLY = 'false';
  loaded = load();
  status = loaded.providers.getYouTubeConfigStatus();
  assert.deepEqual([...status.allowedVisibilities], ['private', 'public']);
  assert.equal(status.configured, true);
  refusal = await loaded.youtube.publishScheduledYouTubePost(publicJob);
  assert.notEqual(refusal.code, 'PROVIDER_VISIBILITY_NOT_AUTHORIZED');

  // Drift between the approved record and the operation binding never
  // reaches the provider, even on an authorized deployment.
  const drifted = await loaded.youtube.publishScheduledYouTubePost({
    ...publicJob,
    providerOperation: uploadedOperation('private')
  });
  assert.equal(drifted.ok, false);
  assert.equal(drifted.code, 'PROVIDER_OPERATION_IDENTITY_MISMATCH');
  assert.equal(drifted.providerMutationStarted, false);

  // Metadata validation is exact: no silent downgrade of a typo.
  assert.equal(loaded.youtube.validateYouTubeMetadata({ title: 'T' }).privacyStatus, 'private');
  assert.equal(loaded.youtube.validateYouTubeMetadata({ title: 'T', privacyStatus: 'public' }).privacyStatus, 'public');
  assert.equal(loaded.youtube.validateYouTubeMetadata({ title: 'T', privacyStatus: 'unlisted' }).ok, false);
  assert.equal(loaded.youtube.validateYouTubeMetadata({ title: 'T', privacyStatus: 'publi' }).ok, false);
  assert.equal(loaded.youtube.validateYouTubeMetadata({ title: 'T', privacyStatus: ' Public ' }).privacyStatus, 'public');
});

// ── Evidence projection ───────────────────────────────────────────────────

test('read-back evidence may only project an implemented visibility', () => {
  const verification = {
    provider: 'youtube', externalVideoId: 'ytProofVideo01', channelId: ACCOUNT_ID,
    channelTitle: 'chanter', channelHandle: '@chantercy', title: 'Exact proof title',
    uploadStatus: 'processed', processingStatus: 'succeeded',
    verifiedAt: '2026-08-13T10:00:30.000Z', uploadMethod: 'resumable'
  };
  assert.equal(sanitizeProviderVerification({ ...verification, privacyStatus: 'public' }).privacyStatus, 'public');
  assert.equal(sanitizeProviderVerification({ ...verification, privacyStatus: 'private' }).privacyStatus, 'private');
  assert.equal(sanitizeProviderVerification({ ...verification, privacyStatus: 'unlisted' }), null);
  assert.equal(sanitizeProviderVerification({ ...verification, privacyStatus: '' }), null);
});
