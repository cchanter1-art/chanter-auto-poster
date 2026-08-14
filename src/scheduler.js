'use strict';

const { randomUUID } = require('crypto');
const config = require('./config');
const { postsCollection, getFirestore, Timestamp, FieldValue } = require('./firestore');
const {
  postFromDoc,
  toTimestampOrNull,
  appendHistoryEntry,
  sanitizePostResult,
  sanitizeProviderVerification,
  resolvePublishAttemptBudget
} = require('./postsMapper');
const { publishPhotoPost } = require('./tiktok');
const instagram = require('./instagram');
const youtube = require('./youtube');
const providers = require('./providers');
const { safeDiagnosticText } = require('./forbiddenMaterial');
const {
  createInitialYouTubeProviderOperation,
  providerOperationAllowsFreshAttempt,
  sanitizeProviderOperation
} = require('./youtubeProviderOperation');
const {
  USAGE_METRIC_SCHEDULED_POSTS,
  createUsageService
} = require('./usageService');

let defaultUsageService = null;
function getUsageService() {
  defaultUsageService ||= createUsageService({ db: getFirestore() });
  return defaultUsageService;
}

const STALE_LOCK_MS = Math.max(1, config.scheduler.staleLockMinutes) * 60 * 1000;
// Deterministic, bounded backoff schedule (minutes) for transient publish
// failures. Indexed by claim attempt number; the last entry caps the delay.
const RETRY_BACKOFF_MINUTES = [1, 5, 15, 60];

const NON_RETRYABLE_CODES = new Set([
  'INSTAGRAM_NOT_CONFIGURED',
  'INSTAGRAM_LIVE_DISABLED'
]);

const NON_RETRYABLE_REASON_PATTERNS = [
  /unassigned/i,
  /not configured/i,
  /disabled/i,
  /token/i,
  /authoriz/i,
  /authentication/i,
  /permission/i,
  /forbidden/i,
  /invalid/i,
  /missing/i,
  /must be/i,
  /bad request/i,
  /approval/i,
  /returned http 4(?!29)\d\d/i
];

const TRANSIENT_ERROR_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN',
  'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT',
  'ABORT_ERR', 'TIMEOUT_ERR'
]);

const TRANSIENT_REASON_PATTERNS = [
  /returned http 5\d\d/i,
  /returned http 429/i,
  /\btimed? ?out\b/i,
  /timeout/i,
  /aborted/i,
  /fetch failed/i,
  /socket hang ?up/i,
  /network/i,
  /rate limit/i,
  /temporarily unavailable/i,
  /service unavailable/i,
  /internal server error/i,
  /try again/i,
  /econn/i,
  /eai_again/i,
  /enotfound/i,
  /etimedout/i
];

/**
 * Classifies a failed publish result. Only clearly transient failures
 * (network errors, timeouts, 5xx/429-style API responses) are retryable;
 * validation, auth, configuration, and other 4xx-style failures — and
 * anything ambiguous — are terminal.
 */
function isTransientPublishFailure(result) {
  if (!result || result.ok) return false;

  const code = String(result.code || '').toUpperCase();
  if (NON_RETRYABLE_CODES.has(code)) return false;

  const reason = String(result.reason || '');
  if (NON_RETRYABLE_REASON_PATTERNS.some((pattern) => pattern.test(reason))) return false;

  if (TRANSIENT_ERROR_CODES.has(code)) return true;
  return TRANSIENT_REASON_PATTERNS.some((pattern) => pattern.test(reason));
}

function retryBackoffMs(attempts) {
  const index = Math.min(Math.max(attempts, 1), RETRY_BACKOFF_MINUTES.length) - 1;
  return RETRY_BACKOFF_MINUTES[index] * 60 * 1000;
}

// Human-approval gate. A job may only be claimed for publishing when
// approvedAt holds a real, finite Timestamp — set by an explicit human
// action (the admin Approve button, or a client scheduling their own
// single post). Missing, malformed, or corrupted approval state all fail
// closed: the job is never claimed and nothing is sent to TikTok.
const APPROVAL_REQUIRED = 'APPROVAL_REQUIRED';
const APPROVAL_BLOCKED_REASON =
  'This job has not been approved. Approve it in the Release Queue before it can publish.';

// Worker refusal code for jobs whose explicit provider has no publish
// handler here. The refusal is terminal (no retry) and never falls back to
// the TikTok publish path.
const PROVIDER_UNSUPPORTED = 'PROVIDER_UNSUPPORTED';
const PUBLISH_ATTEMPT_BUDGET_EXHAUSTED = 'PUBLISH_ATTEMPT_BUDGET_EXHAUSTED';
const PROVIDER_OPERATION_UNRESOLVED = 'PROVIDER_OPERATION_UNRESOLVED';
const ATTEMPT_BUDGET_BLOCKED_REASON =
  'The durable publish-attempt budget for this approval is exhausted; a new human approval is required.';

function isExplicitlyApproved(data) {
  const approvedAt = data && data.approvedAt;
  if (!approvedAt || typeof approvedAt.toMillis !== 'function') return false;
  let millis;
  try {
    millis = approvedAt.toMillis();
  } catch (error) {
    return false;
  }
  return Number.isFinite(millis) && millis > 0;
}

// Track the last successful tick time for health monitoring.
// This is in-memory only — it resets on restart, which is exactly what
// we want: if the process just booted, we don't know when the last tick
// was, and the health endpoint should reflect that uncertainty.
let lastTickAt = null;
let lastTickSummary = null;

function getSchedulerState() {
  return {
    mode: 'external_cron',
    persistent: true,
    inMemoryTimer: false,
    schedule: 'every minute',
    endpoint: '/api/cron/tick',
    lastTickAt: lastTickAt ? lastTickAt.toISOString() : null,
    lastTickOk: lastTickSummary ? lastTickSummary.ok : null
  };
}

/**
 * Returns safe health metadata for the /health endpoint.
 * No secrets, no tokens, no raw env values.
 */
async function getSchedulerHealth() {
  let staleProcessingCount = 0;
  let stuckPendingCount = 0;

  try {
    // Count jobs stuck in processing (potential crashed workers)
    const processingSnap = await postsCollection()
      .where('status', '==', 'processing')
      .get();
    staleProcessingCount = processingSnap.size;

    // Count jobs in 'pending' that have a scheduledAt in the past
    // (missed schedule — should have been picked up by a tick)
    const nowTs = Timestamp.now();
    const pendingSnap = await postsCollection()
      .where('status', '==', 'pending')
      .where('scheduledTimeUTC', '<=', nowTs)
      .get();
    stuckPendingCount = pendingSnap.size;
  } catch (error) {
    // Firestore might not be available during health check — don't crash
    console.warn('[scheduler] health check query failed:', safeDiagnosticText(error.message || String(error)));
  }

  return {
    lastTickAt: lastTickAt ? lastTickAt.toISOString() : null,
    lastTickOk: lastTickSummary ? lastTickSummary.ok : null,
    lastTickSummary: lastTickSummary ? {
      checked: lastTickSummary.checked,
      posted: lastTickSummary.posted,
      failed: lastTickSummary.failed
    } : null,
    staleProcessingCount,
    stuckPendingCount,
    staleLockMinutes: config.scheduler.staleLockMinutes,
    maxClaimAttempts: config.scheduler.maxClaimAttempts
  };
}

async function runSchedulerTick({ now = new Date() } = {}) {
  const nowDate = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(nowDate.getTime())) throw new Error('Scheduler tick received an invalid time');

  const nowTimestamp = Timestamp.fromDate(nowDate);
  const workerId = `${process.env.RENDER_INSTANCE_ID || 'local'}-${randomUUID()}`;
  const summary = {
    ok: true,
    now: nowDate.toISOString(),
    checked: 0,
    due: 0,
    posted: 0,
    failed: 0,
    // Due jobs that a human has not approved yet. Not failures — the gate
    // is working as designed — but counted separately so a stuck queue is
    // visible in /health and the cron response instead of silent.
    blockedUnapproved: 0,
    errors: []
  };

  console.log(`[CRON_TICK] now=${summary.now}`);
  console.log('[CRON_QUERY] checking scheduled jobs');

  try {
    await reclaimStaleLocks(nowDate);
  } catch (error) {
    const message = safeDiagnosticText(error.message || String(error));
    summary.errors.push({ error: `Stale lock recovery failed: ${message}` });
    console.error(`[LOCK_RECOVERY_FAILED] error=${message}`);
  }

  let dueJobs;
  try {
    dueJobs = await findDueJobs(nowTimestamp);
    summary.checked = dueJobs.length;
    summary.due = dueJobs.length;
  } catch (error) {
    const detail = describeQueryError(error);
    summary.ok = false;
    summary.errors.push({ error: detail.message, indexUrl: detail.indexUrl || undefined });
    console.error(`[CRON_QUERY_FAILED] error=${detail.message}`);
    if (detail.indexUrl) console.error(`[CRON_INDEX_REQUIRED] url=${detail.indexUrl}`);
    lastTickAt = new Date();
    lastTickSummary = { ...summary };
    return summary;
  }

  for (const job of dueJobs) {
    console.log(`[JOB_FOUND] id=${job.id} scheduledAt=${job.scheduledAt}`);
    console.log(`[JOB_DUE] id=${job.id}`);

    try {
      const result = await processPost(job.id, { force: false, workerId, now: nowDate });
      if (result.ok) {
        summary.posted += 1;
      } else if (result.code === APPROVAL_REQUIRED) {
        summary.blockedUnapproved += 1;
      } else if (result.mode !== 'skipped') {
        summary.failed += 1;
        summary.errors.push({ id: job.id, error: safeDiagnosticText(result.reason || 'Unknown publish error') });
      }
    } catch (error) {
      const message = safeDiagnosticText(error.message || String(error));
      summary.failed += 1;
      summary.errors.push({ id: job.id, error: message });
      console.error(`[POST_FAILED] id=${job.id} error=${message}`);
    }
  }

  // Record tick metadata for health monitoring
  lastTickAt = new Date();
  lastTickSummary = { ...summary };

  return summary;
}

// Kept for the old /run-scheduler route while deployments move to /api/cron/tick.
async function publishNextPost() {
  return runSchedulerTick();
}

async function findDueJobs(nowTimestamp) {
  const jobs = new Map();

  const canonical = await postsCollection()
    .where('status', '==', 'scheduled')
    .where('scheduledAt', '<=', nowTimestamp)
    .orderBy('scheduledAt', 'asc')
    .get();

  for (const doc of canonical.docs) {
    jobs.set(doc.id, {
      id: doc.id,
      scheduledAt: timestampToIso(doc.data().scheduledAt)
    });
  }

  // Recover jobs created by versions deployed before scheduledAt became the
  // canonical field. Remove this query after those documents are migrated.
  const legacy = await postsCollection()
    .where('status', '==', 'pending')
    .where('scheduledTimeUTC', '<=', nowTimestamp)
    .orderBy('scheduledTimeUTC', 'asc')
    .get();

  for (const doc of legacy.docs) {
    jobs.set(doc.id, {
      id: doc.id,
      scheduledAt: timestampToIso(doc.data().scheduledTimeUTC)
    });
  }

  return [...jobs.values()].sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
}

async function reclaimStaleLocks(nowDate) {
  const threshold = Timestamp.fromMillis(nowDate.getTime() - STALE_LOCK_MS);
  const snapshot = await postsCollection()
    .where('status', '==', 'processing')
    .where('lockedAt', '<=', threshold)
    .get();

  await Promise.all(snapshot.docs.map((doc) => reclaimOne(doc.ref)));
}

async function reclaimOne(ref) {
  try {
    await getFirestore().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;

      const data = snap.data();
      if (data.status !== 'processing') return;

      const attempts = Number(data.claimAttempts || 0);
      const attemptBudget = resolvePublishAttemptBudget(data);
      if (attempts >= attemptBudget) {
        const reason = `Publish worker stopped during ${attempts} attempts`;
        tx.update(ref, {
          status: 'failed',
          lockedAt: null,
          lockedBy: null,
          failedAt: FieldValue.serverTimestamp(),
          errorMessage: reason,
          providerStatus: 'attempt_budget_exhausted',
          updatedAt: FieldValue.serverTimestamp(),
          lastResult: sanitizePostResult({
            ok: false,
            mode: 'api',
            code: PUBLISH_ATTEMPT_BUDGET_EXHAUSTED,
            reason,
            attempts,
            completedAt: new Date().toISOString()
          }),
          history: appendHistoryEntry(data.history, 'attempt_budget_exhausted', reason)
        });
        return;
      }

      const scheduledAt = data.scheduledAt || data.scheduledTimeUTC || Timestamp.now();
      tx.update(ref, {
        status: 'scheduled',
        scheduledAt,
        lockedAt: null,
        lockedBy: null,
        history: appendHistoryEntry(data.history, 'lock_reclaimed', 'Worker lock expired; job returned to the schedule for retry.'),
        updatedAt: FieldValue.serverTimestamp()
      });
    });
  } catch (error) {
    console.error(`[LOCK_RECOVERY_FAILED] id=${ref.id} error=${safeDiagnosticText(error.message || String(error))}`);
  }
}

async function claimPost(id, { force, workerId, now = new Date() }) {
  const ref = postsCollection().doc(id);

  return getFirestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;

    const data = snap.data();
    if (data.status === 'processing') return null;

    // Duplicate-post guard: if this job already has a durable publish
    // identifier and a terminal success status, never publish again.
    // This prevents duplicates when reclaimStaleLocks retries a post
    // that TikTok actually accepted before the crash.
    if (data.status === 'posted' && data.publishId) {
      return null;
    }

    if (!force) {
      const isCanonical = data.status === 'scheduled';
      const isLegacy = data.status === 'pending' && data.scheduledTimeUTC;
      if (!isCanonical && !isLegacy) return null;

      const scheduledAt = data.scheduledAt || data.scheduledTimeUTC;
      const scheduledTimestamp = normalizeTimestamp(scheduledAt);
      if (!scheduledTimestamp || scheduledTimestamp.toMillis() > now.getTime()) return null;
    } else if (!['pending', 'scheduled', 'failed', 'ready'].includes(data.status)) {
      return null;
    }

    // Even in force mode, refuse to re-publish a job that already has
    // a durable publish identifier — the content is already on TikTok.
    if (data.publishId) {
      return null;
    }

    // Approval gate — applies to every publish path, including force mode
    // (manual "Publish Now"). Fails closed on any missing/invalid state.
    if (!isExplicitlyApproved(data)) {
      return { blocked: APPROVAL_REQUIRED };
    }

    const attempts = Number(data.claimAttempts || 0);
    const attemptBudget = resolvePublishAttemptBudget(data);
    if (attempts >= attemptBudget) {
      // A duplicate delivery or manual force replay must not reopen the
      // exhausted approval. A scheduled legacy record is closed through the
      // canonical queue transition; an already-terminal record is untouched.
      if (data.status !== 'failed') {
        tx.update(ref, {
          status: 'failed',
          failedAt: FieldValue.serverTimestamp(),
          errorMessage: data.errorMessage || ATTEMPT_BUDGET_BLOCKED_REASON,
          lockedAt: null,
          lockedBy: null,
          providerStatus: 'attempt_budget_exhausted',
          lastResult: sanitizePostResult({
            ...(data.lastResult || {}),
            ok: false,
            mode: (data.lastResult && data.lastResult.mode) || 'blocked',
            code: PUBLISH_ATTEMPT_BUDGET_EXHAUSTED,
            reason: data.errorMessage || ATTEMPT_BUDGET_BLOCKED_REASON,
            willRetry: false,
            attempts,
            completedAt: new Date().toISOString()
          }),
          history: appendHistoryEntry(
            data.history,
            'attempt_budget_exhausted',
            `Publishing remained blocked at ${attempts} of ${attemptBudget} authorized claims.`
          ),
          updatedAt: FieldValue.serverTimestamp()
        });
      }
      return {
        blocked: PUBLISH_ATTEMPT_BUDGET_EXHAUSTED,
        reason: ATTEMPT_BUDGET_BLOCKED_REASON
      };
    }

    const providerId = String(data.provider || data.platform || providers.PROVIDER_TIKTOK)
      .trim()
      .toLowerCase();
    if (
      providerId === providers.PROVIDER_YOUTUBE
      && data.providerOperation
      && !providerOperationAllowsFreshAttempt(data.providerOperation)
    ) {
      // The exact provider operation survives every queue-state transition.
      // Once it has reached the provider, no later claim may open another
      // resumable session on this row; reconciliation must use the
      // already-persisted operation instead. An operation that never got
      // that far (a gate failed before the session POST) holds nothing to
      // reconcile, so a re-approved attempt replaces it rather than being
      // blocked forever.
      return {
        blocked: PROVIDER_OPERATION_UNRESOLVED,
        reason: 'This YouTube queue job already owns a provider operation that reached the provider. Reconcile that exact operation instead of creating another session.'
      };
    }

    const providerOperation = providerId === providers.PROVIDER_YOUTUBE
      ? createInitialYouTubeProviderOperation({
          queueId: id,
          post: postFromDoc(snap),
          attemptNumber: attempts + 1
        })
      : null;

    tx.update(ref, {
      status: 'processing',
      lockedAt: FieldValue.serverTimestamp(),
      lockedBy: workerId,
      claimAttempts: FieldValue.increment(1),
      ...(providerOperation ? { providerOperation } : {}),
      history: appendHistoryEntry(data.history, 'publish_attempt', `Claimed by worker for publishing (attempt ${attempts + 1} of ${attemptBudget} authorized claims).`),
      updatedAt: FieldValue.serverTimestamp()
    });

    const claimed = postFromDoc(snap);
    claimed.status = 'processing';
    claimed.claimAttempts = attempts + 1;
    if (providerOperation) claimed.providerOperation = sanitizeProviderOperation(providerOperation);
    return claimed;
  });
}

async function processPost(id, {
  force = false,
  workerId = `manual-${randomUUID()}`,
  now = new Date()
} = {}) {
  const claimed = await claimPost(id, { force, workerId, now });
  if (claimed && claimed.blocked === APPROVAL_REQUIRED) {
    console.warn(`[JOB_BLOCKED_UNAPPROVED] id=${id}`);
    return {
      ok: false,
      mode: 'blocked',
      code: APPROVAL_REQUIRED,
      postId: id,
      reason: APPROVAL_BLOCKED_REASON
    };
  }
  if (claimed && claimed.blocked === PUBLISH_ATTEMPT_BUDGET_EXHAUSTED) {
    console.warn(`[JOB_BLOCKED_ATTEMPT_BUDGET] id=${id}`);
    return {
      ok: false,
      mode: 'blocked',
      code: PUBLISH_ATTEMPT_BUDGET_EXHAUSTED,
      postId: id,
      reason: claimed.reason || ATTEMPT_BUDGET_BLOCKED_REASON
    };
  }
  if (claimed && claimed.blocked === PROVIDER_OPERATION_UNRESOLVED) {
    console.warn(`[JOB_BLOCKED_PROVIDER_OPERATION] id=${id}`);
    return {
      ok: false,
      mode: 'blocked',
      code: PROVIDER_OPERATION_UNRESOLVED,
      postId: id,
      reason: claimed.reason
    };
  }
  if (!claimed) {
    return {
      ok: false,
      mode: 'skipped',
      postId: id,
      reason: 'Job was already claimed, already handled, or is not due.'
    };
  }

  console.log(`[POST_START] id=${id}`);
  // Provider dispatch. postsMapper already normalizes a MISSING legacy
  // provider to TikTok; an EXPLICIT provider value is honored as stored.
  // Only providers with a real publish handler below may execute — an
  // unknown or unimplemented explicit provider fails closed instead of
  // falling through to the TikTok publish path.
  const providerId = String(claimed.provider || claimed.platform || providers.PROVIDER_TIKTOK)
    .trim()
    .toLowerCase();
  let result;
  try {
    if (providerId === providers.PROVIDER_INSTAGRAM) {
      result = await publishScheduledInstagramPost(claimed);
    } else if (providerId === providers.PROVIDER_YOUTUBE) {
      // The YouTube adapter owns every provider-specific gate (config,
      // account, reauthorization, scope, title, media trust) and fails
      // closed before any external call.
      result = await youtube.publishScheduledYouTubePost(claimed);
    } else if (providerId !== providers.PROVIDER_TIKTOK) {
      const definition = providers.getProviderDefinition(providerId);
      const label = definition
        ? `${definition.displayName} (${definition.implementationStatus})`
        : `"${providerId}" (unknown)`;
      console.warn(`[JOB_BLOCKED_PROVIDER] id=${id} provider=${providerId}`);
      result = {
        ok: false,
        mode: 'blocked',
        code: PROVIDER_UNSUPPORTED,
        reason: `Publishing provider ${label} is not supported by this worker; publishing was blocked.`
      };
    } else if (!claimed.accountId || claimed.accountId === 'legacy' || claimed.accountAssignment === 'legacy') {
      result = {
        ok: false,
        mode: 'api',
        reason: 'TikTok account is unassigned for this job; publishing was blocked.'
      };
    } else {
      result = await publishPhotoPost(claimed);
    }
  } catch (error) {
    result = {
      ok: false,
      mode: 'api',
      reason: error.message || 'Unexpected TikTok publish error',
      response: error.response || null
    };
  }

  const finalized = await finalize(id, workerId, result);
  if (finalized.ok) {
    console.log(`[POST_SUCCESS] id=${id} providerResponse=${JSON.stringify(safeTikTokSummary(result))}`);
  } else {
    console.error(`[POST_FAILED] id=${id} error=${safeDiagnosticText(finalized.reason || 'Unknown publish error')}`);
  }
  return finalized;
}

async function publishScheduledInstagramPost(post) {
  const health = await instagram.getInstagramHealth();
  if (!health.configured) {
    return {
      ok: false,
      mode: 'api',
      code: 'INSTAGRAM_NOT_CONFIGURED',
      reason: 'Instagram publishing is not configured.'
    };
  }
  if (!health.canPublish) {
    return {
      ok: false,
      mode: 'api',
      code: 'INSTAGRAM_LIVE_DISABLED',
      reason: 'Instagram live publishing is disabled.'
    };
  }

  return instagram.publishInstagramMedia({
    post,
    userId: post.userId,
    dryRun: false
  });
}

async function finalize(id, workerId, result) {
  const ref = postsCollection().doc(id);
  const completedAt = new Date().toISOString();
  let publishId = extractPublishId(result && result.response);
  let providerVerification = sanitizeProviderVerification(result && result.providerVerification);
  if (
    result.ok
    && ['uploaded_private', 'uploaded_public'].includes(result.providerStatus)
    && (!publishId || !providerVerification)
  ) {
    result = {
      ...result,
      ok: false,
      outcomeUnknown: true,
      code: 'PROVIDER_VERIFICATION_FAILED',
      providerStatus: 'provider_verification_required',
      reason: 'YouTube returned upload success without complete read-back verification; reconciliation is required.'
    };
    publishId = extractPublishId(result.response);
    providerVerification = sanitizeProviderVerification(result.providerVerification);
  }
  const reason = safeDiagnosticText(result.reason || 'Publishing failed', { maxLength: 500 });
  let applied = false;
  let retryScheduled = false;
  let usageReconciliationRequired = false;

  // Extract a durable publish identifier even when provider read-back fails
  // after upload. Once a real external ID is known, no retry path may create
  // another video merely because verification or persistence was delayed.

  await getFirestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const data = snap.data();
    if (data.status !== 'processing' || data.lockedBy !== workerId) return;
    const providerId = String(data.provider || data.platform || providers.PROVIDER_TIKTOK)
      .trim()
      .toLowerCase();

    let usageTransition = null;
    if (data.usageLedgerId && data.workspaceId && data.usageCycleId) {
      const locator = {
        workspaceId: data.workspaceId,
        usageCycleId: data.usageCycleId,
        metric: data.usageMetric || USAGE_METRIC_SCHEDULED_POSTS,
        ledgerId: data.usageLedgerId,
        relatedResourceId: id
      };
      try {
        if (result.ok) {
          usageTransition = await getUsageService().transaction.consumeReservation(tx, locator);
        } else if (result.outcomeUnknown) {
          usageTransition = await getUsageService().transaction.markOutcomeUnknown(tx, {
            ...locator,
            reason: result.code || 'provider_reconciliation_required'
          });
        }
      } catch (usageError) {
        // Provider truth has priority after an external attempt. Preserve the
        // reservation (fail-closed for quota), record reconciliation on the
        // queue item, and never hide a real provider result.
        usageReconciliationRequired = true;
        console.error(`[USAGE_RECONCILIATION_REQUIRED] id=${id} code=${usageError.code || 'usage_transition_failed'}`);
      }
    }

    if (result.ok) {
      const successDetail = providerId === providers.PROVIDER_YOUTUBE
        ? (publishId
            ? `YouTube stored the video as ${(providerVerification && providerVerification.privacyStatus) || 'private'} with subscriber notifications disabled (video ${publishId}).`
            : 'YouTube accepted the upload.')
        : (publishId ? `TikTok accepted the publish (id ${publishId}).` : 'TikTok accepted the publish.');
      const update = {
        status: 'posted',
        postedAt: Timestamp.now(),
        readyAt: null,
        failedAt: null,
        errorMessage: null,
        lockedAt: null,
        lockedBy: null,
        lastResult: sanitizePostResult({ ...result, completedAt }),
        usageState: usageTransition ? usageTransition.state : (data.usageState || ''),
        usageReconciliationRequired,
        history: appendHistoryEntry(data.history, 'posted', successDetail),
        updatedAt: FieldValue.serverTimestamp()
      };
      if (publishId) {
        update.publishId = publishId;
      }
      if (result.providerStatus) {
        update.providerStatus = String(result.providerStatus);
      }
      if (providerVerification) {
        update.providerVerification = providerVerification;
      }
      tx.update(ref, update);
    } else if (result.outcomeUnknown) {
      // Ambiguous external outcome (bytes may have reached the provider,
      // no definitive answer): never blind-retry, never report success,
      // never report clean failure. The job leaves the claimable state
      // machine until a human (or a future reconciliation flow) resolves
      // what the provider actually did.
      const update = {
        status: 'outcome_unknown',
        failedAt: null,
        errorMessage: reason,
        lockedAt: null,
        lockedBy: null,
        providerStatus: 'provider_reconciliation_required',
        lastResult: sanitizePostResult({
          ok: false,
          mode: result.mode || 'api',
          code: result.code || 'PROVIDER_RECONCILIATION_REQUIRED',
          outcomeUnknown: true,
          ...(typeof result.providerMutationStarted === 'boolean'
            ? { providerMutationStarted: result.providerMutationStarted }
            : {}),
          ...(result.failureBoundary ? { failureBoundary: result.failureBoundary } : {}),
          reason,
          completedAt
        }),
        usageState: usageTransition ? usageTransition.state : (data.usageState || 'reserved'),
        usageReconciliationRequired,
        history: appendHistoryEntry(data.history, 'outcome_unknown', reason),
        updatedAt: FieldValue.serverTimestamp()
      };
      if (publishId) update.publishId = publishId;
      if (result.providerStatus) update.providerStatus = String(result.providerStatus);
      if (providerVerification) update.providerVerification = providerVerification;
      tx.update(ref, update);
    } else {
      // Store redacted error metadata — no raw tokens or full payloads.
      const safeResult = {
        ok: false,
        mode: result.mode || 'api',
        reason,
        completedAt
      };
      if (result.code) safeResult.code = result.code;
      if (typeof result.providerMutationStarted === 'boolean') {
        safeResult.providerMutationStarted = result.providerMutationStarted;
      }
      if (result.failureBoundary) safeResult.failureBoundary = result.failureBoundary;

      const attempts = Number(data.claimAttempts || 0);
      const attemptBudget = resolvePublishAttemptBudget(data);
      const attemptBudgetExhausted = attempts >= attemptBudget;
      const shouldRetry = isTransientPublishFailure(result) && !attemptBudgetExhausted;

      if (shouldRetry) {
        const nextAttemptAt = Timestamp.fromMillis(Date.now() + retryBackoffMs(attempts));
        retryScheduled = true;
        tx.update(ref, {
          status: 'scheduled',
          scheduledAt: nextAttemptAt,
          failedAt: null,
          errorMessage: reason,
          lockedAt: null,
          lockedBy: null,
          lastResult: sanitizePostResult({ ...safeResult, willRetry: true, attempts }),
          history: appendHistoryEntry(data.history, 'retry_scheduled', reason),
          updatedAt: FieldValue.serverTimestamp()
        });
      } else {
        const terminalResult = attemptBudgetExhausted
          ? {
              ...safeResult,
              code: PUBLISH_ATTEMPT_BUDGET_EXHAUSTED,
              willRetry: false,
              attempts
            }
          : safeResult;
        tx.update(ref, {
          status: 'failed',
          failedAt: Timestamp.now(),
          errorMessage: reason,
          lockedAt: null,
          lockedBy: null,
          ...(attemptBudgetExhausted ? { providerStatus: 'attempt_budget_exhausted' } : {}),
          lastResult: sanitizePostResult(terminalResult),
          history: appendHistoryEntry(
            data.history,
            attemptBudgetExhausted ? 'attempt_budget_exhausted' : 'failed',
            attemptBudgetExhausted
              ? `${reason} No automatic retry was scheduled because all ${attemptBudget} authorized claims were consumed.`
              : reason
          ),
          updatedAt: FieldValue.serverTimestamp()
        });
      }
    }
    applied = true;
  });

  if (!applied) {
    return { ok: false, mode: 'skipped', postId: id, reason: 'Job lock changed before completion.' };
  }
  if (result.ok) {
    return { ok: true, mode: result.mode || 'api', postId: id, usageReconciliationRequired };
  }
  if (retryScheduled) {
    console.warn(`[POST_RETRY_SCHEDULED] id=${id} reason=${safeDiagnosticText(reason)}`);
    return { ok: false, mode: result.mode || 'api', postId: id, reason, retryScheduled: true };
  }
  if (result.outcomeUnknown) {
    console.warn(`[POST_OUTCOME_UNKNOWN] id=${id} reason=${safeDiagnosticText(reason)}`);
    return {
      ok: false,
      mode: result.mode || 'api',
      postId: id,
      reason,
      outcomeUnknown: true,
      usageReconciliationRequired
    };
  }
  return { ok: false, mode: result.mode || 'api', postId: id, reason };
}

function normalizeTimestamp(value) {
  if (value && typeof value.toMillis === 'function') return value;
  return toTimestampOrNull(value);
}

function timestampToIso(value) {
  if (value && typeof value.toDate === 'function') return value.toDate().toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function safeTikTokSummary(result) {
  const response = result && result.response;
  const publishId = findSafeValue(response, new Set(['publish_id', 'publishid']));
  const status = findSafeValue(response, new Set(['status', 'publish_status']));
  return {
    mode: result && result.mode ? result.mode : 'api',
    publishId: publishId || null,
    status: status || 'accepted'
  };
}

/**
 * Extracts a durable publish identifier from a TikTok API response.
 * Returns the first matching value found, or null if none exists.
 */
function extractPublishId(response) {
  if (!response || typeof response !== 'object') return null;
  const keys = new Set([
    'publish_id', 'publishid', 'post_id', 'postid',
    'share_url', 'shareurl', 'item_id', 'itemid',
    'video_id', 'videoid'
  ]);
  return findSafeValue(response, keys);
}

function findSafeValue(value, keys) {
  if (!value || typeof value !== 'object') return null;
  for (const [key, child] of Object.entries(value)) {
    if (keys.has(key.toLowerCase()) && ['string', 'number', 'boolean'].includes(typeof child)) {
      return child;
    }
    const nested = findSafeValue(child, keys);
    if (nested !== null) return nested;
  }
  return null;
}

function describeQueryError(error) {
  const rawMessage = error && error.message ? error.message : String(error);
  const match = rawMessage.match(/https:\/\/console\.firebase\.google\.com\/[^\s)]+/);
  return { message: safeDiagnosticText(rawMessage), indexUrl: match ? match[0] : null };
}

module.exports = {
  getSchedulerState,
  getSchedulerHealth,
  publishNextPost,
  runSchedulerTick,
  processPost,
  APPROVAL_REQUIRED,
  PROVIDER_UNSUPPORTED,
  PUBLISH_ATTEMPT_BUDGET_EXHAUSTED,
  _private: {
    claimPost,
    findDueJobs,
    isExplicitlyApproved,
    isTransientPublishFailure,
    retryBackoffMs,
    describeQueryError,
    safeTikTokSummary,
    extractPublishId,
    finalize
  }
};
