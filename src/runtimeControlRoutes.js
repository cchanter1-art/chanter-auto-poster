'use strict';

// Agent Runtime control surface (P1B). Authentication and safe JSON mapping
// stay here; every product operation goes through the same application
// service used by the website and client portal.

const express = require('express');
const { createHash, timingSafeEqual } = require('crypto');
const config = require('./config');
const applicationService = require('./autoposterApplicationService');
const {
  REFERENCE_PREFIX,
  StagedMediaError,
  createCanonicalStagedMedia
} = require('./canonicalStagedMedia');
// Evolution mission runtime.connected-health: injectable Firestore-mode reader
// (model-authored logic) + redaction boundary (existing runtime contract).
const { readConnectedHealth } = require('./runtimeConnectedHealth');
const { redactRuntimeValue } = require('./runtime/runtimeRedaction');
const { normalizeQueueStatus, sanitizeHistory, sanitizePostResult } = require('./postsMapper');
const { safeDiagnosticText, sanitizeProviderMaterial } = require('./forbiddenMaterial');

const router = express.Router();
const QUEUE_LIST_DEFAULT_LIMIT = 25;
const QUEUE_LIST_MAX_LIMIT = 100;
const CAPTION_SUMMARY_LIMIT = 140;
// Phase 2E-B: the status wire view carries at most this many of the newest
// canonical history entries so one response stays bounded no matter how long
// a job's evidence log grows (the document itself is already capped at 50).
const STATUS_HISTORY_LIMIT = 20;
const stagedMedia = createCanonicalStagedMedia({
  rootDir: config.canonicalExecution.stagedMediaDir,
  secret: config.canonicalExecution.mediaReferenceSecret
});

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function fail(res, status, code, reason, extra = {}) {
  res.status(status).json(sanitizeProviderMaterial({
    ok: false,
    code: String(code || 'failure').slice(0, 120),
    reason: safeDiagnosticText(reason, { protectedValues: [config.runtimeControl.token] }),
    ...extra
  }, { protectedValues: [config.runtimeControl.token] }));
}

function applicationRoute(handler) {
  return asyncRoute(async (req, res, next) => {
    try {
      return await handler(req, res, next);
    } catch (error) {
      if (error instanceof applicationService.AutoPosterApplicationError) {
        fail(res, error.status, error.code, error.message, error.details);
        return;
      }
      throw error;
    }
  });
}

// Constant-time comparison over fixed-length digests so token length is not
// observable either.
function tokensMatch(candidate, expected) {
  const candidateDigest = createHash('sha256').update(String(candidate || '')).digest();
  const expectedDigest = createHash('sha256').update(String(expected || '')).digest();
  return timingSafeEqual(candidateDigest, expectedDigest);
}

function requireRuntimeControlToken(req, res, next) {
  const expected = config.runtimeControl.token;
  if (!expected) {
    fail(res, 503, 'unavailable', 'Runtime control is disabled: RUNTIME_CONTROL_TOKEN is not configured.');
    return;
  }
  const candidate = req.get('x-chanter-runtime-token');
  if (!candidate || !tokensMatch(candidate, expected)) {
    fail(res, 401, 'unauthorized', 'A valid runtime control token is required.');
    return;
  }
  // Tenant identity comes from the service token, never from the body.
  req.runtimeUserId = config.defaultUserId;
  next();
}

router.use(requireRuntimeControlToken);
router.use(express.json({ limit: '64kb' }));

function runtimeContext(req, {
  accountId = '',
  actorId = 'agent-runtime',
  idempotencyKey = '',
  workspaceId = ''
} = {}) {
  return applicationService.createExecutionContext({
    userId: req.runtimeUserId,
    actorId,
    accountId,
    workspaceId: String(workspaceId || req.get('x-chanter-workspace-id') || ''),
    source: 'runtime',
    correlationId: req.get('x-request-id') || req.get('x-correlation-id') || '',
    idempotency: { key: idempotencyKey }
  });
}

function captionSummary(caption) {
  const text = String(caption || '');
  return text.length > CAPTION_SUMMARY_LIMIT ? `${text.slice(0, CAPTION_SUMMARY_LIMIT)}…` : text;
}

function queueItemView(post) {
  return {
    id: post.id,
    // Canonical provider/connected-account identity (additive, safe
    // metadata only — never tokens or credentials).
    provider: post.provider || 'tiktok',
    connectedAccountId: post.connectedAccountId || '',
    accountId: post.accountId,
    username: post.username,
    status: post.status,
    scheduledAt: post.scheduledAt || null,
    approved: Boolean(post.approved),
    mediaType: post.mediaType,
    captionSummary: captionSummary(post.caption),
    createdAt: post.createdAt || null,
    updatedAt: post.updatedAt || null
  };
}

function lastErrorMessage(post) {
  const lastResult = post.lastResult || null;
  const reason = lastResult && (lastResult.reason || lastResult.error || lastResult.message);
  return safeDiagnosticText(reason, { maxLength: 300, protectedValues: [config.runtimeControl.token] });
}

// Phase 2E-B bounded lastResult wire subset. Re-sanitizes through the
// canonical postsMapper allowlist (defense in depth), then projects only the
// exact facts the Operator result projection needs to classify a lifecycle
// state truthfully: never the provider response object, never attempts of
// arbitrary shape, never raw payloads.
function statusLastResultView(post) {
  const safe = sanitizePostResult(post.lastResult);
  if (!safe) return null;
  const view = {};
  if (typeof safe.mode === 'string') view.mode = safe.mode;
  if (typeof safe.code === 'string') view.code = safe.code;
  if (typeof safe.reason === 'string') view.message = safe.reason.slice(0, 300);
  if (typeof safe.completedAt === 'string') view.completedAt = safe.completedAt;
  if (typeof safe.willRetry === 'boolean') view.willRetry = safe.willRetry;
  if (typeof safe.outcomeUnknown === 'boolean') view.outcomeUnknown = safe.outcomeUnknown;
  if (typeof safe.providerMutationStarted === 'boolean') {
    view.providerMutationStarted = safe.providerMutationStarted;
  }
  if (typeof safe.failureBoundary === 'string') view.failureBoundary = safe.failureBoundary;
  return Object.keys(view).length > 0 ? view : null;
}

// Phase 2E-B capped history wire view: the newest STATUS_HISTORY_LIMIT
// canonical evidence entries, re-scrubbed, with only { at, event, detail }.
function statusHistoryView(post) {
  return sanitizeHistory(post.history)
    .slice(-STATUS_HISTORY_LIMIT)
    .map((entry) => ({
      at: typeof entry.at === 'string' ? entry.at : null,
      event: entry.event,
      detail: typeof entry.detail === 'string' ? entry.detail : ''
    }));
}

function postStatusView(post) {
  const claimAttempts = Number(post.claimAttempts || 0);
  const publishAttemptBudget = Number(post.publishAttemptBudget || 0);
  return {
    ...queueItemView(post),
    // Canonical queue lifecycle status. postFromDoc already normalizes the
    // legacy 'publishing' alias; re-normalizing here keeps the wire contract
    // closed even for callers that bypass the mapper.
    status: normalizeQueueStatus(post.status),
    // Verified workspace ownership scope ('' for legacy records). This is an
    // opaque identifier, never billing/subscription data.
    workspaceId: String(post.workspaceId || ''),
    approvedAt: post.approvedAt || null,
    approvedBy: post.approvedBy || '',
    approvalState: post.approvalState === 'approved' ? 'approved' : 'unapproved',
    postedAt: post.postedAt || null,
    publishId: post.publishId || '',
    // Provider-reported state and bounded provider metadata (postsMapper
    // allowlist — titles/privacy flags only, never credentials).
    providerStatus: post.providerStatus || '',
    // Provider read-back proof is a strict allowlisted mapper projection:
    // external artifact identity, channel/title, private status, processing
    // state, and verification time only. No provider response or credential
    // material crosses the Runtime boundary.
    providerVerification: post.providerVerification || null,
    // Durable provider operation is already a closed safe projection from
    // postsMapper. The encrypted resumable-session locator is never present.
    providerOperation: post.providerOperation || null,
    // Scheduler lifecycle evidence. lockedAt is safe timing evidence;
    // lockedBy (worker identity) is deliberately never exposed.
    lockedAt: post.lockedAt || null,
    claimAttempts,
    publishAttemptBudget,
    attemptBudgetExhausted: claimAttempts >= publishAttemptBudget,
    // Agent Runtime correlation metadata persisted at schedule time. These
    // are opaque mission identifiers/hashes, never tokens or payloads.
    runtimeMissionId: String(post.runtimeMissionId || ''),
    runtimeIdempotencyKey: String(post.runtimeIdempotencyKey || ''),
    runtimeAction: String(post.runtimeAction || ''),
    runtimePayloadHash: String(post.runtimePayloadHash || ''),
    lastResult: statusLastResultView(post),
    history: statusHistoryView(post),
    lastErrorMessage: lastErrorMessage(post)
  };
}

// Schedule/recovery responses carry the cross-repository identity linkage the
// Runtime result contract requires. General status remains intentionally
// unchanged because its strict evidence parser does not own these fields.
function exactRuntimeResultId(value, label) {
  const exact = String(value || '');
  if (
    !exact
    || exact !== exact.trim()
    || exact.length > 256
    || /[\x00-\x1f\x7f]/.test(exact)
  ) {
    throw new applicationService.AutoPosterApplicationError(
      `AutoPoster schedule result retained an invalid ${label}.`,
      { status: 500, code: 'runtime_linkage_invalid' }
    );
  }
  return exact;
}

function scheduleResultPostView(post) {
  const campaignId = exactRuntimeResultId(post && post.campaignId, 'campaignId');
  const linkage = applicationService.runtimeLinkageIds({
    missionId: post.runtimeMissionId,
    graphId: post.runtimeGraphId,
    documentId: post.id,
    idempotencyKey: post.runtimeIdempotencyKey || post.idempotencyKey
  });
  return {
    ...postStatusView(post),
    campaignId,
    approvalId: exactRuntimeResultId(post.approvalId || linkage.approvalId, 'approvalId'),
    evidenceBundleId: exactRuntimeResultId(
      post.evidenceBundleId || linkage.evidenceBundleId,
      'evidenceBundleId'
    )
  };
}

function connectedAccountView(account) {
  return {
    provider: String(account.provider || ''),
    providerDisplayName: String(account.providerDisplayName || ''),
    accountId: String(account.accountId || ''),
    connectedAccountId: String(account.connectionId || ''),
    username: String(account.username || ''),
    displayName: String(account.displayName || ''),
    connectionStatus: String(account.connectionStatus || ''),
    publishingReady: Boolean(account.publishingReady),
    readinessBlockers: Array.isArray(account.readinessBlockers)
      ? account.readinessBlockers.map((value) => String(value))
      : [],
    lastVerifiedAt: account.lastVerifiedAt || null
  };
}

// Canonical connected-account discovery for Operator/Runtime selectors. The
// application service resolves the authenticated workspace and returns its
// allowlisted domain views; this transport applies an even narrower wire
// allowlist so token metadata and provider/account payloads cannot escape.
router.get('/connected-accounts', applicationRoute(async (req, res) => {
  const workspaceId = String(req.query.workspaceId || req.get('x-chanter-workspace-id') || '').trim();
  const provider = String(req.query.provider || '').trim().toLowerCase();
  const result = await applicationService.listConnectedAccounts(
    runtimeContext(req, { workspaceId }),
    { provider: provider || undefined }
  );
  const accounts = result.accounts.map(connectedAccountView);
  res.json({
    ok: true,
    workspaceId: result.workspaceId,
    count: accounts.length,
    accounts
  });
}));

// Revalidates the exact selected opaque ID immediately before Operator
// persistence. accountId is deliberately not trimmed or case-normalized.
router.post('/connected-accounts/validate', applicationRoute(async (req, res) => {
  const body = req.body || {};
  const accountId = String(body.accountId || '');
  const provider = String(body.provider || '').trim().toLowerCase();
  const workspaceId = String(body.workspaceId || req.get('x-chanter-workspace-id') || '').trim();
  if (!provider) { fail(res, 400, 'validation_failed', 'provider is required.'); return; }

  const result = await applicationService.validateConnectedAccount(
    runtimeContext(req, { accountId, workspaceId }),
    { provider, accountId }
  );
  res.json({
    ok: true,
    workspaceId: result.workspaceId,
    account: connectedAccountView(result.account)
  });
}));

// Queue listing. The route limit is intentionally narrower than the internal
// service maximum because this is a remote evidence surface.
router.get('/queue', applicationRoute(async (req, res) => {
  const accountId = String(req.query.accountId || '').trim();
  const workspaceId = String(req.query.workspaceId || req.get('x-chanter-workspace-id') || '').trim();
  const rawLimit = req.query.limit === undefined ? QUEUE_LIST_DEFAULT_LIMIT : Number(req.query.limit);
  if (!Number.isInteger(rawLimit) || rawLimit < 1) {
    fail(res, 400, 'validation_failed', `limit must be an integer between 1 and ${QUEUE_LIST_MAX_LIMIT}.`);
    return;
  }
  const limit = Math.min(rawLimit, QUEUE_LIST_MAX_LIMIT);
  const result = await applicationService.listQueue(
    runtimeContext(req, { accountId, workspaceId }),
    { accountId, limit }
  );
  const items = result.items.map(queueItemView);
  res.json({
    ok: true,
    items,
    count: items.length,
    totalInScope: result.totalInScope,
    scope: result.scope
  });
}));

router.get('/posts/:id/status', applicationRoute(async (req, res) => {
  const accountId = String(req.query.accountId || '').trim() || undefined;
  const workspaceId = String(req.query.workspaceId || req.get('x-chanter-workspace-id') || '').trim();
  const { post } = await applicationService.getPostStatus(
    runtimeContext(req, { accountId, workspaceId }),
    { postId: req.params.id, accountId }
  );
  res.json({ ok: true, post: postStatusView(post) });
}));

router.post('/posts/:id/provider/reconcile', applicationRoute(async (req, res) => {
  const body = req.body || {};
  const accountId = String(body.accountId || req.query.accountId || '').trim();
  const workspaceId = String(
    body.workspaceId || req.query.workspaceId || req.get('x-chanter-workspace-id') || ''
  ).trim();
  if (!accountId) { fail(res, 400, 'validation_failed', 'accountId is required.'); return; }
  const result = await applicationService.reconcileProviderOperation(
    runtimeContext(req, { accountId, workspaceId }),
    { postId: req.params.id, accountId }
  );
  res.json({
    ok: true,
    classification: result.classification,
    post: postStatusView(result.post)
  });
}));

router.post('/media/validate', applicationRoute(async (req, res) => {
  const validation = applicationService.validateMedia(runtimeContext(req), req.body || {});
  res.json({ ok: true, ...validation });
}));

// Read-only recovery contract. It returns zero/one/conflicting exact durable
// queue records and never creates, approves, publishes, or repairs anything.
router.post('/schedule/reconcile', applicationRoute(async (req, res) => {
  const body = req.body || {};
  const workspaceId = String(body.workspaceId || req.get('x-chanter-workspace-id') || '');
  const accountId = String(body.accountId || '');
  const idempotencyKey = String(body.idempotencyKey || '');
  const result = await applicationService.reconcileRuntimeSchedule(
    runtimeContext(req, { accountId, idempotencyKey, workspaceId }),
    {
      provider: String(body.provider || ''),
      accountId,
      scheduledAt: String(body.scheduledAt || ''),
      missionId: String(body.missionId || ''),
      action: String(body.action || ''),
      missionPayloadHash: String(body.missionPayloadHash || '')
    }
  );
  res.json({
    ok: true,
    ...result,
    ...(result.post ? { post: scheduleResultPostView(result.post) } : {})
  });
}));

// Controlled scheduling creates one unapproved draft. Runtime approval is
// permission to invoke this operation, never AutoPoster's human publish gate.
router.post('/schedule', applicationRoute(async (req, res) => {
  const body = req.body || {};
  // Preserve the exact opaque ID; the shared account validator rejects case
  // and whitespace mismatches before queue creation.
  const accountId = String(body.accountId || '');
  const mediaInput = String(body.mediaUrl || '');
  const mediaUrl = mediaInput.trim();
  const idempotencyKey = String(body.idempotencyKey || '');
  const requestedBy = String(body.requestedBy || '').trim() || 'agent-runtime';
  const workspaceId = String(body.workspaceId || req.get('x-chanter-workspace-id') || '').trim();
  // Optional provider selection (defaults to TikTok for full backward
  // compatibility). The application service owns provider validation,
  // account resolution, and the YouTube title requirement.
  const provider = String(body.provider || '').trim().toLowerCase();

  if (!accountId) { fail(res, 400, 'validation_failed', 'accountId is required.'); return; }
  if (!mediaUrl) { fail(res, 400, 'validation_failed', 'mediaUrl is required.'); return; }

  let materialized = null;
  try {
    if (mediaUrl.startsWith(REFERENCE_PREFIX)) {
      if (mediaInput !== mediaUrl) {
        fail(res, 400, 'staged_media_invalid', 'Staged media references are exact and cannot contain surrounding whitespace.');
        return;
      }
      // Exact durable replay must not depend on staging still being present.
      // This is the same read-only recovery authority exposed by
      // /schedule/reconcile, evaluated before any file resolution.
      if (body.missionId && body.action && body.missionPayloadHash) {
        const recovery = await applicationService.reconcileRuntimeSchedule(
          runtimeContext(req, { accountId, idempotencyKey, workspaceId }),
          {
            provider: String(body.provider || ''),
            accountId,
            scheduledAt: String(body.scheduledAt || ''),
            missionId: String(body.missionId || ''),
            action: String(body.action || ''),
            missionPayloadHash: String(body.missionPayloadHash || '')
          }
        );
        if (recovery.outcome === 'unique' && recovery.safeToReuse && recovery.post) {
          const post = scheduleResultPostView(recovery.post);
          await stagedMedia.release(mediaUrl).catch(() => {});
          res.status(200).json({ ok: true, duplicate: true, post });
          return;
        }
        if (recovery.outcome !== 'not_found') {
          fail(
            res,
            409,
            'reconciliation_required',
            'A durable runtime result exists but is not safe for automatic replay.',
            { recoveryOutcome: recovery.outcome, retryable: false }
          );
          return;
        }
      }
      try {
        materialized = await stagedMedia.materialize(mediaUrl);
      } catch (error) {
        if (error instanceof StagedMediaError) {
          fail(res, error.status, error.code, error.message, { retryable: error.retryable });
          return;
        }
        throw error;
      }
    }

    const result = await applicationService.schedulePost(
      runtimeContext(req, { accountId, actorId: requestedBy, idempotencyKey, workspaceId }),
      {
        provider: provider || undefined,
        accountId,
        ...(materialized ? { files: [materialized.file] } : { mediaUrl }),
        caption: body.caption,
        hashtags: body.hashtags,
        soundMode: body.soundMode,
        youtube: provider === 'youtube'
          ? {
              title: body.title,
              description: body.description,
              // Explicit requested visibility. Omitted means private; the
              // application service validates the exact allowed values and
              // the worker enforces the deployment ceiling before uploading.
              privacyStatus: body.visibility
            }
          : undefined,
        requestedBy,
        runtimeMissionId: body.missionId,
        runtimeGraphId: body.graphId,
        runtimeAction: body.action,
        runtimePayloadHash: body.missionPayloadHash,
        providerProofMode: body.providerProofMode === true,
        approvedMedia: body.approvedMedia,
        requireSingle: true,
        schedule: {
          mode: 'explicit',
          scheduledAt: body.scheduledAt,
          requireExplicitTimezone: true,
          requireFuture: true
        }
      }
    );

    const post = scheduleResultPostView(result.post);
    if (materialized) await stagedMedia.release(mediaUrl).catch(() => {});
    res.status(result.duplicate ? 200 : 201).json({
      ok: true,
      duplicate: result.duplicate,
      post
    });
  } finally {
    if (materialized) await materialized.cleanup().catch(() => {});
  }
}));

// Cheap, bounded, read-only connected-health truth signal (evolution mission
// runtime.connected-health). Token-gated like every route on this router; the
// entire payload passes through runtime redaction so no secret can escape.
router.get('/connected-health', asyncRoute(async (req, res) => {
  const firestoreModule = require('./firestore');
  let configured = false;
  try { firestoreModule.validateFirebaseConfig(); configured = true; } catch { configured = false; }
  const health = await readConnectedHealth({
    getFirestore: firestoreModule.getFirestore,
    configured,
    emulatorHost: process.env.FIRESTORE_EMULATOR_HOST || '',
    timeoutMs: 2500
  });
  const payload = redactRuntimeValue({
    ok: Boolean(health && health.ok),
    runtime: { configured: Boolean(config.runtimeControl.token), reachable: true },
    storage: (health && health.storage) || { provider: 'firestore', mode: 'unknown', reachable: null },
    publishing: { enabled: false },
    scheduler: { mode: 'external_cron', lastTickAt: null, healthy: null },
    observedAt: (health && health.observedAt) || new Date().toISOString()
  });
  res.json(payload);
}));

module.exports = router;
