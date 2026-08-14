'use strict';

const { createHash } = require('crypto');
const { sanitizeApprovedMediaIdentity } = require('./approvedMediaIdentity');

const PROVIDER_OPERATION_SCHEMA_VERSION = 'chanter.autoposter.youtube-provider-operation.v1';
const PROVIDER_OPERATION_EVENT_LIMIT = 64;
const PROVIDER_RECONCILIATION_ATTEMPT_BUDGET = 3;

const OPERATION_STATES = new Set([
  'operation_pending',
  'media_preflighted',
  'session_persisted',
  'uploading',
  'resumable',
  'completed_private',
  'completed_public',
  'provider_missing',
  'contradictory_public',
  'outcome_unknown',
  'terminal_failure'
]);

const TERMINAL_OPERATION_STATES = new Set([
  'completed_private',
  'completed_public',
  'contradictory_public',
  'provider_missing',
  'terminal_failure'
]);

// The exact visibilities a job may request. Anything else — including
// 'unlisted', which no publish path implements — sanitizes down to the
// least-exposing value, so an unreadable or tampered field can only ever
// make an upload MORE private than intended, never less.
const REQUESTED_VISIBILITIES = new Set(['private', 'public']);

// How exposed each provider-reported visibility is. Used to tell a safety
// contradiction (the provider is more public than what was approved) from a
// merely unsatisfied completion (the provider is less public than approved).
const VISIBILITY_EXPOSURE_RANK = new Map([
  ['private', 0],
  ['unlisted', 1],
  ['public', 2]
]);

// The two states an operation can hold before the provider owns anything.
// `operation_pending` is the row a worker claim writes; `media_preflighted`
// adds the bound media identity. Neither has a persisted resumable session
// locator, so neither is reconcilable — and neither can correspond to a
// video (see providerOperationAllowsFreshAttempt).
const PRE_SESSION_OPERATION_STATES = new Set([
  'operation_pending',
  'media_preflighted'
]);

const OPERATION_TRANSITIONS = new Map([
  ['operation_pending', new Set(['media_preflighted', 'terminal_failure'])],
  ['media_preflighted', new Set(['session_persisted', 'terminal_failure'])],
  ['session_persisted', new Set(['uploading', 'resumable', 'outcome_unknown', 'provider_missing', 'terminal_failure'])],
  ['uploading', new Set(['uploading', 'resumable', 'completed_private', 'completed_public', 'contradictory_public', 'provider_missing', 'outcome_unknown', 'terminal_failure'])],
  ['resumable', new Set(['uploading', 'resumable', 'completed_private', 'completed_public', 'contradictory_public', 'provider_missing', 'outcome_unknown', 'terminal_failure'])],
  ['outcome_unknown', new Set(['uploading', 'resumable', 'completed_private', 'completed_public', 'contradictory_public', 'provider_missing', 'outcome_unknown', 'terminal_failure'])],
  ['completed_private', new Set()],
  ['completed_public', new Set()],
  ['contradictory_public', new Set()],
  ['provider_missing', new Set()],
  ['terminal_failure', new Set()]
]);

const EVENT_TYPES = new Set([
  'operation_created',
  'media_preflight_bound',
  'media_drift_rejected',
  'session_initiated',
  'session_persistence_failed',
  'upload_put_attempted',
  'accepted_byte_offset',
  'provider_response_recorded',
  'artifact_confirmed',
  'session_status_read',
  'provider_status_read',
  'provider_receipt_recorded',
  'reconciliation_lease_acquired',
  'reconciliation_lease_released',
  'outcome_unknown',
  'terminal_failure',
  'existing_resource_update',
  'provider_delete'
]);

const RECEIPT_METHOD = 'youtube.videos.list+youtube.channels.list';
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalize(value[key])])
  );
}

function canonicalSha256(value) {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function boundedString(value, maxLength) {
  const text = String(value || '');
  if (text.length > maxLength || /[\u0000-\u001f\u007f]/.test(text)) return '';
  return text;
}

/**
 * The one place a requested visibility is decided. Fails closed to 'private'
 * for anything unrecognized, so no unreadable field can widen exposure.
 */
function sanitizeRequestedVisibility(value) {
  const text = boundedString(value, 32).trim().toLowerCase();
  return REQUESTED_VISIBILITIES.has(text) ? text : 'private';
}

/** The terminal success state that proves the approved visibility was met. */
function completionStateForVisibility(visibility) {
  return sanitizeRequestedVisibility(visibility) === 'public'
    ? 'completed_public'
    : 'completed_private';
}

/**
 * The queue-visible provider status for a proven upload. Derived from the
 * visibility the PROVIDER reported back, never from what was requested, so
 * the queue can never advertise a visibility YouTube did not confirm.
 */
function providerUploadStatus(providerReportedVisibility) {
  return sanitizeRequestedVisibility(providerReportedVisibility) === 'public'
    ? 'uploaded_public'
    : 'uploaded_private';
}

/**
 * True when the provider's actual visibility is MORE exposed than what was
 * approved. That, and only that, is the safety contradiction — a provider
 * artifact that ended up less exposed than approved is an unmet completion,
 * not a leak, and stays reconcilable.
 */
function visibilityExceedsRequest(actualVisibility, requestedVisibility) {
  const actual = VISIBILITY_EXPOSURE_RANK.get(boundedString(actualVisibility, 32).trim().toLowerCase());
  const requested = VISIBILITY_EXPOSURE_RANK.get(sanitizeRequestedVisibility(requestedVisibility));
  return Number.isInteger(actual) && actual > requested;
}

function timestampOrNull(value) {
  const text = boundedString(value, 80).trim();
  return text && Number.isFinite(Date.parse(text)) ? text : null;
}

function nonNegativeInteger(value, fallback = 0, maximum = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 && number <= maximum ? number : fallback;
}

function operationIdentityBinding(input) {
  return {
    queueId: boundedString(input.queueId, 256).trim(),
    provider: 'youtube',
    userId: boundedString(input.userId, 256).trim(),
    workspaceId: boundedString(input.workspaceId, 160).trim(),
    accountId: boundedString(input.accountId, 256).trim(),
    connectedAccountId: boundedString(input.connectedAccountId, 512).trim(),
    approvalActorId: boundedString(input.approvalActorId, 256).trim(),
    approvalTimestamp: timestampOrNull(input.approvalTimestamp),
    approvedAttemptNumber: nonNegativeInteger(input.approvedAttemptNumber, 0, 1000),
    runtimeMissionId: boundedString(input.runtimeMissionId, 256).trim(),
    graphId: boundedString(input.graphId, 256).trim(),
    runtimeAction: boundedString(input.runtimeAction, 128).trim(),
    runtimePayloadHash: boundedString(input.runtimePayloadHash, 64).trim(),
    approvedMediaSha256: boundedString(input.approvedMediaSha256, 64).trim().toLowerCase(),
    // The approved visibility is part of WHAT was approved, so it belongs in
    // the identity the provider operation id hashes. Any drift between the
    // approved queue record and the operation executing against it mints a
    // different providerOperationId and fails the identity check closed.
    requestedVisibility: sanitizeRequestedVisibility(input.requestedVisibility)
  };
}

function operationMediaBinding(operation, media) {
  return {
    ...operationIdentityBinding(operation),
    providerOperationId: String(operation.providerOperationId || ''),
    providerAttemptId: String(operation.providerAttemptId || ''),
    mediaSha256: String(media.mediaSha256 || ''),
    mediaByteSize: Number(media.mediaByteSize || 0),
    mediaMimeType: String(media.mediaMimeType || ''),
    mediaContainer: String(media.mediaContainer || ''),
    mediaFileName: String(media.mediaFileName || ''),
    mediaSourceId: String(media.mediaSourceId || '')
  };
}

function safeEvent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const sequence = nonNegativeInteger(value.sequence, 0, PROVIDER_OPERATION_EVENT_LIMIT * 1000);
  const type = boundedString(value.type, 64).trim();
  const at = timestampOrNull(value.at);
  if (sequence < 1 || !EVENT_TYPES.has(type) || !at) return null;
  const event = { sequence, type, at };
  const attemptId = boundedString(value.providerAttemptId, 96).trim();
  if (attemptId) event.providerAttemptId = attemptId;
  if (value.acceptedByteOffset !== undefined) {
    event.acceptedByteOffset = nonNegativeInteger(value.acceptedByteOffset);
  }
  const externalVideoId = boundedString(value.externalVideoId, 128).trim();
  if (externalVideoId) event.externalVideoId = externalVideoId;
  const errorCode = boundedString(value.errorCode, 120).trim();
  if (errorCode) event.errorCode = errorCode;
  const receiptSha256 = boundedString(value.receiptSha256, 64).trim().toLowerCase();
  if (SHA256_PATTERN.test(receiptSha256)) event.receiptSha256 = receiptSha256;
  const responseSha256 = boundedString(value.responseSha256, 64).trim().toLowerCase();
  if (SHA256_PATTERN.test(responseSha256)) event.responseSha256 = responseSha256;
  return event;
}

function safeEvents(events) {
  if (!Array.isArray(events)) return [];
  return events.slice(-PROVIDER_OPERATION_EVENT_LIMIT).flatMap((event) => {
    const safe = safeEvent(event);
    return safe ? [safe] : [];
  });
}

function appendProviderOperationEvent(operation, type, fields = {}, at = new Date().toISOString()) {
  if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
    throw new Error('A provider operation is required.');
  }
  if (!EVENT_TYPES.has(type)) throw new Error(`Unsupported provider operation event: ${type}`);
  const events = safeEvents(operation.events);
  const event = safeEvent({
    sequence: (events.at(-1)?.sequence || 0) + 1,
    type,
    at,
    providerAttemptId: operation.providerAttemptId,
    ...fields
  });
  if (!event) throw new Error('Provider operation event is malformed.');
  return {
    ...operation,
    events: [...events, event].slice(-PROVIDER_OPERATION_EVENT_LIMIT)
  };
}

function transitionProviderOperation(operation, nextState) {
  const currentState = String(operation && operation.operationState || '');
  if (!OPERATION_STATES.has(currentState) || !OPERATION_STATES.has(nextState)) {
    throw new Error('Provider operation transition state is invalid.');
  }
  if (currentState === nextState && TERMINAL_OPERATION_STATES.has(currentState)) return operation;
  if (!OPERATION_TRANSITIONS.get(currentState)?.has(nextState)) {
    const error = new Error(`Invalid provider operation transition ${currentState} -> ${nextState}.`);
    error.code = 'PROVIDER_OPERATION_INVALID_TRANSITION';
    throw error;
  }
  return { ...operation, operationState: nextState };
}

function reconciliationLeaseAuthorizes(operation, input, nowMs = Date.now()) {
  const lease = operation && operation.reconciliationLease;
  return Boolean(
    lease
    && lease.ownerId === input.leaseOwnerId
    && Number(lease.fencingToken) === Number(input.fencingToken)
    && Date.parse(String(lease.expiresAt || '')) > nowMs
  );
}

function claimReconciliationLease(operation, input, nowMs = Date.now()) {
  if (TERMINAL_OPERATION_STATES.has(operation.operationState)) return { outcome: 'terminal_operation', operation };
  if (!operation.sessionLocatorEnvelope) return { outcome: 'session_missing', operation };
  const ownerId = String(input.ownerId || '').trim();
  if (!ownerId) return { outcome: 'owner_required', operation };
  const activeLease = operation.reconciliationLease;
  if (activeLease && Date.parse(String(activeLease.expiresAt || '')) > nowMs) {
    return { outcome: 'lease_active', operation };
  }
  const attemptCount = Number(operation.reconciliationAttemptCount || 0);
  const budget = Number(operation.reconciliationAttemptBudget || 0);
  if (!Number.isSafeInteger(budget) || budget < 1 || attemptCount >= budget) {
    return { outcome: 'budget_exhausted', operation };
  }
  const at = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + Math.max(1_000, Math.min(Number(input.leaseDurationMs) || 30_000, 120_000))).toISOString();
  const fencingToken = Number(operation.reconciliationFencingToken || 0) + 1;
  const lease = {
    ownerId,
    acquiredAt: at,
    expiresAt,
    attemptNumber: attemptCount + 1,
    operationId: operation.providerOperationId,
    fencingToken
  };
  const next = appendProviderOperationEvent({
    ...operation,
    reconciliationAttemptCount: attemptCount + 1,
    reconciliationLease: lease,
    reconciliationFencingToken: fencingToken,
    lastReconciledAt: at
  }, 'reconciliation_lease_acquired', {}, at);
  return { outcome: 'claimed', operation: next, lease };
}

function deriveMutationSummary(events) {
  const safe = safeEvents(events);
  const count = (type) => safe.filter((event) => event.type === type).length;
  const artifactIds = new Set(
    safe.filter((event) => event.type === 'artifact_confirmed')
      .map((event) => event.externalVideoId)
      .filter(Boolean)
  );
  return {
    // The provider creates the resumable session before returning its
    // locator. If encrypted persistence then fails, that is still one real
    // provider-side initiation even though no bytes were sent.
    providerSessionInitiationCount: safe.some((event) => (
      event.type === 'session_initiated' || event.type === 'session_persistence_failed'
    )) ? 1 : 0,
    mediaUploadAttemptCount: count('upload_put_attempted'),
    confirmedVideoArtifactCount: artifactIds.size,
    existingResourceUpdateCount: count('existing_resource_update'),
    deleteCount: count('provider_delete'),
    reconciliationStatusReadCount: count('session_status_read') + count('provider_status_read')
  };
}

function createInitialYouTubeProviderOperation({ queueId, post, attemptNumber, now = new Date().toISOString() }) {
  const approvedMedia = sanitizeApprovedMediaIdentity(post.approvedMedia, {
    maxByteSize: Number.MAX_SAFE_INTEGER
  });
  const identity = operationIdentityBinding({
    queueId,
    userId: post.userId,
    workspaceId: post.workspaceId,
    accountId: post.accountId,
    connectedAccountId: post.connectedAccountId || `youtube:${post.accountId || ''}`,
    approvalActorId: post.approvedBy,
    approvalTimestamp: post.approvedAt,
    approvedAttemptNumber: attemptNumber,
    runtimeMissionId: post.runtimeMissionId,
    graphId: post.runtimeGraphId,
    runtimeAction: post.runtimeAction,
    runtimePayloadHash: post.runtimePayloadHash,
    approvedMediaSha256: approvedMedia && approvedMedia.sha256,
    // Read from the durable approved queue record only. Approval locks the
    // provider metadata (an approved item cannot change destination), so this
    // is the visibility a human released, not one the worker chose.
    requestedVisibility: post.providerMetadata
      && post.providerMetadata.youtube
      && post.providerMetadata.youtube.privacyStatus
  });
  if (
    !identity.queueId
    || !identity.userId
    || !identity.accountId
    || identity.connectedAccountId !== `youtube:${identity.accountId}`
    || !identity.approvalActorId
    || !identity.approvalTimestamp
    || identity.approvedAttemptNumber < 1
    || (post.providerProofMode === true && !approvedMedia)
  ) {
    throw new Error('YouTube provider operation identity is incomplete.');
  }
  const providerOperationId = `ytop_${canonicalSha256({
    schemaVersion: PROVIDER_OPERATION_SCHEMA_VERSION,
    ...identity
  })}`;
  const providerAttemptId = `ytatt_${canonicalSha256({
    providerOperationId,
    attemptNumber: nonNegativeInteger(attemptNumber, 0, 1000)
  })}`;
  let operation = {
    schemaVersion: PROVIDER_OPERATION_SCHEMA_VERSION,
    providerOperationId,
    providerAttemptId,
    provider: 'youtube',
    operationState: 'operation_pending',
    ...identity,
    providerProofMode: post.providerProofMode === true,
    approvedMedia,
    bindingSha256: null,
    mediaSha256: null,
    mediaByteSize: null,
    mediaMimeType: null,
    mediaContainer: null,
    mediaFileName: null,
    mediaSourceId: null,
    sessionCreatedAt: null,
    uploadStartedAt: null,
    uploadCompletedAt: null,
    acceptedByteOffset: 0,
    externalVideoId: null,
    providerResponseSha256: null,
    providerStatusReceiptSha256: null,
    providerStatusReceipt: null,
    reconciliationAttemptCount: 0,
    reconciliationAttemptBudget: PROVIDER_RECONCILIATION_ATTEMPT_BUDGET,
    reconciliationLease: null,
    reconciliationFencingToken: 0,
    lastReconciledAt: null,
    lastOperationErrorCode: null,
    events: []
  };
  operation = appendProviderOperationEvent(operation, 'operation_created', {}, now);
  return operation;
}

function sanitizeProviderStatusReceipt(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const provider = boundedString(value.provider, 32).trim().toLowerCase();
  const queueId = boundedString(value.queueId, 256).trim();
  const providerOperationId = boundedString(value.providerOperationId, 96).trim();
  const providerAttemptId = boundedString(value.providerAttemptId, 96).trim();
  const configuredAccountId = boundedString(value.configuredAccountId, 256).trim();
  const connectedAccountId = boundedString(value.connectedAccountId, 512).trim();
  const verifiedChannelId = boundedString(value.verifiedChannelId, 256).trim();
  const externalVideoId = boundedString(value.externalVideoId, 128).trim();
  const mediaSha256 = boundedString(value.mediaSha256, 64).trim().toLowerCase();
  const expectedTitle = boundedString(value.expectedTitle, 100).trim();
  const verificationTimestamp = timestampOrNull(value.verificationTimestamp);
  const canonicalResponseSha256 = boundedString(value.canonicalResponseSha256, 64).trim().toLowerCase();
  const approvedMedia = sanitizeApprovedMediaIdentity(value.approvedMedia);
  const providerProofMode = value.providerProofMode === true;
  // A receipt must state which visibility it is evidence FOR. Sanitizing
  // rather than defaulting silently is not enough here: an absent value on a
  // public operation would read as a private receipt, so the recorder also
  // cross-checks this against the operation's own approved visibility.
  const requestedVisibility = sanitizeRequestedVisibility(value.requestedVisibility);
  if (
    provider !== 'youtube'
    || !queueId
    || !providerOperationId
    || !providerAttemptId
    || !boundedString(value.userId, 256).trim()
    || !boundedString(value.workspaceId, 160).trim()
    || !boundedString(value.runtimeMissionId, 256).trim()
    || !configuredAccountId
    || connectedAccountId !== `youtube:${configuredAccountId}`
    || !SHA256_PATTERN.test(mediaSha256)
    || (providerProofMode && !approvedMedia)
    || !expectedTitle
    || !verificationTimestamp
    || value.verificationMethod !== RECEIPT_METHOD
    || !SHA256_PATTERN.test(canonicalResponseSha256)
    || typeof value.artifactExists !== 'boolean'
    || typeof value.exactTitleMatch !== 'boolean'
  ) return null;
  if (value.artifactExists && (!externalVideoId || !verifiedChannelId)) return null;
  return {
    provider: 'youtube',
    queueId,
    providerOperationId,
    providerAttemptId,
    userId: boundedString(value.userId, 256).trim(),
    workspaceId: boundedString(value.workspaceId, 160).trim(),
    runtimeMissionId: boundedString(value.runtimeMissionId, 256).trim(),
    graphId: boundedString(value.graphId, 256).trim(),
    mediaSha256,
    approvedMedia,
    providerProofMode,
    configuredAccountId,
    connectedAccountId,
    verifiedChannelId,
    authenticatedChannelId: boundedString(value.authenticatedChannelId, 256).trim(),
    safeChannelTitle: boundedString(value.safeChannelTitle, 200).trim(),
    safeChannelHandle: boundedString(value.safeChannelHandle, 200).trim(),
    externalVideoId,
    expectedTitle,
    exactTitleMatch: value.exactTitleMatch,
    artifactExists: value.artifactExists,
    requestedVisibility,
    privacyStatus: boundedString(value.privacyStatus, 40).trim().toLowerCase(),
    uploadStatus: boundedString(value.uploadStatus, 120).trim(),
    processingStatus: boundedString(value.processingStatus, 120).trim(),
    verificationMethod: RECEIPT_METHOD,
    verificationTimestamp,
    canonicalResponseSha256
  };
}

function sanitizeProviderOperation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const providerOperationId = boundedString(value.providerOperationId, 96).trim();
  const providerAttemptId = boundedString(value.providerAttemptId, 96).trim();
  const queueId = boundedString(value.queueId, 256).trim();
  const accountId = boundedString(value.accountId, 256).trim();
  const userId = boundedString(value.userId, 256).trim();
  const connectedAccountId = boundedString(value.connectedAccountId, 512).trim();
  const operationState = boundedString(value.operationState, 64).trim();
  if (
    value.schemaVersion !== PROVIDER_OPERATION_SCHEMA_VERSION
    || value.provider !== 'youtube'
    || !providerOperationId
    || !providerAttemptId
    || !queueId
    || !userId
    || !accountId
    || connectedAccountId !== `youtube:${accountId}`
    || !OPERATION_STATES.has(operationState)
  ) return null;
  const events = safeEvents(value.events);
  const mediaSha256 = boundedString(value.mediaSha256, 64).trim().toLowerCase();
  const mediaByteSize = nonNegativeInteger(value.mediaByteSize, 0);
  const mediaMimeType = boundedString(value.mediaMimeType, 120).trim().toLowerCase();
  const mediaContainer = boundedString(value.mediaContainer, 24).trim().toLowerCase();
  const mediaFileName = boundedString(value.mediaFileName, 255).trim();
  const mediaSourceId = boundedString(value.mediaSourceId, 512).trim();
  const bindingSha256 = boundedString(value.bindingSha256, 64).trim().toLowerCase();
  const hasMedia = SHA256_PATTERN.test(mediaSha256)
    && mediaByteSize > 0
    && mediaMimeType.startsWith('video/')
    && mediaContainer === 'mp4'
    && Boolean(mediaFileName)
    && Boolean(mediaSourceId)
    && SHA256_PATTERN.test(bindingSha256);
  const receipt = sanitizeProviderStatusReceipt(value.providerStatusReceipt);
  const approvedMedia = sanitizeApprovedMediaIdentity(value.approvedMedia);
  const providerProofMode = value.providerProofMode === true;
  const mediaBoundWithinApprovedIdentity = !providerProofMode || Boolean(
    approvedMedia
    && hasMedia
    && approvedMedia.sha256 === mediaSha256
    && approvedMedia.byteSize === mediaByteSize
    && approvedMedia.mimeType === mediaMimeType
    && approvedMedia.container === mediaContainer
  );
  if (providerProofMode && !approvedMedia) return null;
  const rawLease = value.reconciliationLease;
  const reconciliationLease = rawLease && typeof rawLease === 'object' && !Array.isArray(rawLease)
    && boundedString(rawLease.ownerId, 256).trim()
    && timestampOrNull(rawLease.acquiredAt)
    && timestampOrNull(rawLease.expiresAt)
    && boundedString(rawLease.operationId, 96).trim() === providerOperationId
    && nonNegativeInteger(rawLease.attemptNumber, 0, PROVIDER_RECONCILIATION_ATTEMPT_BUDGET) >= 1
    && nonNegativeInteger(rawLease.fencingToken, 0) >= 1
    ? {
        ownerId: boundedString(rawLease.ownerId, 256).trim(),
        acquiredAt: timestampOrNull(rawLease.acquiredAt),
        expiresAt: timestampOrNull(rawLease.expiresAt),
        attemptNumber: nonNegativeInteger(rawLease.attemptNumber, 0, PROVIDER_RECONCILIATION_ATTEMPT_BUDGET),
        operationId: providerOperationId,
        fencingToken: nonNegativeInteger(rawLease.fencingToken, 0)
      }
    : null;
  return {
    schemaVersion: PROVIDER_OPERATION_SCHEMA_VERSION,
    providerOperationId,
    providerAttemptId,
    provider: 'youtube',
    operationState,
    queueId,
    userId,
    workspaceId: boundedString(value.workspaceId, 160).trim(),
    accountId,
    connectedAccountId,
    approvalActorId: boundedString(value.approvalActorId, 256).trim(),
    approvalTimestamp: timestampOrNull(value.approvalTimestamp),
    approvedAttemptNumber: nonNegativeInteger(value.approvedAttemptNumber, 0, 1000),
    runtimeMissionId: boundedString(value.runtimeMissionId, 256).trim(),
    graphId: boundedString(value.graphId, 256).trim(),
    runtimeAction: boundedString(value.runtimeAction, 128).trim(),
    runtimePayloadHash: boundedString(value.runtimePayloadHash, 64).trim().toLowerCase(),
    approvedMediaSha256: approvedMedia ? approvedMedia.sha256 : null,
    requestedVisibility: sanitizeRequestedVisibility(value.requestedVisibility),
    providerProofMode,
    approvedMedia,
    bindingSha256: hasMedia && mediaBoundWithinApprovedIdentity ? bindingSha256 : null,
    mediaSha256: hasMedia && mediaBoundWithinApprovedIdentity ? mediaSha256 : null,
    mediaByteSize: hasMedia && mediaBoundWithinApprovedIdentity ? mediaByteSize : null,
    mediaMimeType: hasMedia && mediaBoundWithinApprovedIdentity ? mediaMimeType : null,
    mediaContainer: hasMedia && mediaBoundWithinApprovedIdentity ? mediaContainer : null,
    mediaFileName: hasMedia ? mediaFileName : null,
    mediaSourceId: hasMedia ? mediaSourceId : null,
    sessionCreatedAt: timestampOrNull(value.sessionCreatedAt),
    uploadStartedAt: timestampOrNull(value.uploadStartedAt),
    uploadCompletedAt: timestampOrNull(value.uploadCompletedAt),
    acceptedByteOffset: nonNegativeInteger(value.acceptedByteOffset, 0, hasMedia ? mediaByteSize : Number.MAX_SAFE_INTEGER),
    externalVideoId: boundedString(value.externalVideoId, 128).trim() || null,
    providerResponseSha256: SHA256_PATTERN.test(String(value.providerResponseSha256 || '').toLowerCase())
      ? String(value.providerResponseSha256).toLowerCase()
      : null,
    providerStatusReceiptSha256: SHA256_PATTERN.test(String(value.providerStatusReceiptSha256 || '').toLowerCase())
      ? String(value.providerStatusReceiptSha256).toLowerCase()
      : null,
    providerStatusReceipt: receipt,
    mutationSummary: deriveMutationSummary(events),
    reconciliationAttemptCount: nonNegativeInteger(value.reconciliationAttemptCount, 0, 1000),
    reconciliationAttemptBudget: nonNegativeInteger(
      value.reconciliationAttemptBudget,
      PROVIDER_RECONCILIATION_ATTEMPT_BUDGET,
      1000
    ),
    reconciliationLease,
    reconciliationFencingToken: nonNegativeInteger(value.reconciliationFencingToken, 0),
    lastReconciledAt: timestampOrNull(value.lastReconciledAt),
    lastOperationErrorCode: boundedString(value.lastOperationErrorCode, 120).trim() || null,
    eventCount: events.length,
    eventDigestSha256: canonicalSha256(events)
  };
}

/**
 * Answers one question for the worker claim: may this queue job open a new
 * provider attempt, or does its persisted operation still own provider-side
 * state that must be reconciled instead?
 *
 * A fresh attempt is allowed only when the operation proves no video can
 * exist for it. Two durability barriers make that provable:
 *
 *   - a resumable session locator is persisted in the same transaction that
 *     records `session_initiated`, so any state past `media_preflighted`
 *     means a session may be reachable and must be reconciled, not replaced;
 *   - no byte is ever PUT before `upload_put_attempted` is durably recorded
 *     (putResumableBytes returns without sending when that write fails).
 *
 * So a pre-session operation can at worst have left an orphan zero-byte
 * resumable session at the provider. YouTube creates the video resource on
 * upload completion, not on session creation, so that orphan expires without
 * ever becoming a video and a new attempt cannot duplicate one.
 *
 * Anything unreadable, tampered with, or past those barriers fails closed.
 */
function providerOperationAllowsFreshAttempt(rawOperation) {
  if (!rawOperation) return true;
  const operation = sanitizeProviderOperation(rawOperation);
  if (!operation) return false;
  if (!PRE_SESSION_OPERATION_STATES.has(operation.operationState)) return false;
  if (rawOperation.sessionLocatorEnvelope) return false;
  if (operation.sessionCreatedAt || operation.uploadStartedAt || operation.uploadCompletedAt) return false;
  if (operation.externalVideoId
    || operation.providerResponseSha256
    || operation.providerStatusReceiptSha256
    || operation.providerStatusReceipt) return false;
  const summary = operation.mutationSummary;
  return summary.providerSessionInitiationCount === 0
    && summary.mediaUploadAttemptCount === 0
    && summary.confirmedVideoArtifactCount === 0
    && summary.existingResourceUpdateCount === 0
    && summary.deleteCount === 0;
}

module.exports = {
  EVENT_TYPES,
  OPERATION_STATES,
  OPERATION_TRANSITIONS,
  PRE_SESSION_OPERATION_STATES,
  PROVIDER_OPERATION_EVENT_LIMIT,
  PROVIDER_OPERATION_SCHEMA_VERSION,
  PROVIDER_RECONCILIATION_ATTEMPT_BUDGET,
  RECEIPT_METHOD,
  REQUESTED_VISIBILITIES,
  TERMINAL_OPERATION_STATES,
  appendProviderOperationEvent,
  canonicalSha256,
  claimReconciliationLease,
  completionStateForVisibility,
  createInitialYouTubeProviderOperation,
  deriveMutationSummary,
  operationMediaBinding,
  providerOperationAllowsFreshAttempt,
  providerUploadStatus,
  reconciliationLeaseAuthorizes,
  sanitizeProviderOperation,
  sanitizeProviderStatusReceipt,
  sanitizeRequestedVisibility,
  safeEvents,
  transitionProviderOperation,
  visibilityExceedsRequest
};
