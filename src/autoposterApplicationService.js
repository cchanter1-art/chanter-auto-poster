'use strict';

// AutoPoster's product-level application boundary. Browser, client-portal,
// and Agent Runtime controllers translate transport input into these
// operations; Firestore/media/provider details stay in their existing modules.

const { createHash } = require('crypto');
const config = require('./config');
const storage = require('./storage');
const mediaPolicy = require('./mediaPolicy');
const providers = require('./providers');
const connectedAccounts = require('./connectedAccounts');
const commercialService = require('./commercialService');
const { sanitizePostResult, sanitizeHistory } = require('./postsMapper');
const { parseDateTimeLocal } = require('./timeUtil');
const { computeMaxSchedulePlan, computeDailySchedulePlan, computeBatchStaggerPlan } = require('./maxScheduler');
const youtube = require('./youtube');
const { sanitizeApprovedMediaIdentity } = require('./approvedMediaIdentity');
const { normalizeSoundMode } = require('./tiktokSoundMode');
const { validateYouTubeMetadata } = youtube;

const PROVIDER_TIKTOK = providers.PROVIDER_TIKTOK;
const PROVIDER_YOUTUBE = providers.PROVIDER_YOUTUBE;
const ACCOUNT_VALIDATION_CODES = Object.freeze({
  UNKNOWN: 'unknown_account_id',
  CASE_MISMATCH: 'account_id_case_mismatch',
  NON_CANONICAL: 'account_id_non_canonical',
  WORKSPACE_MISMATCH: 'account_workspace_mismatch',
  PROVIDER_MISMATCH: 'provider_account_mismatch',
  DISCONNECTED: 'account_disconnected',
  NOT_PUBLISHING_READY: 'account_not_publishing_ready'
});
const REQUEST_SOURCES = new Set(['website', 'runtime', 'internal_worker']);
const DEFAULT_QUEUE_LIMIT = 100;
const MAX_QUEUE_LIMIT = 1000;
const INTERNAL_PLAN_DUE_GRACE_MS = 60_000;
const ISO_WITH_ZONE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
const EDIT_BLOCKED_QUEUE_STATUSES = new Set(['processing', 'posted', 'outcome_unknown']);
const RUNTIME_SCHEDULE_ACTION = 'autoposter.post.schedule';
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

class AutoPosterApplicationError extends Error {
  constructor(message, { status = 400, code = 'validation_failed', details = {} } = {}) {
    super(message);
    this.name = 'AutoPosterApplicationError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// Provider-domain failures surface through the same application error type
// every controller already knows how to render.
function translateProviderError(error) {
  if (error instanceof providers.ProviderError) {
    return new AutoPosterApplicationError(error.message, {
      status: error.status,
      code: error.code,
      details: error.details
    });
  }
  return error;
}

function createExecutionContext(input = {}) {
  const userId = String(input.userId || '').trim();
  if (!userId) {
    throw new AutoPosterApplicationError('An authenticated AutoPoster owner is required.', {
      status: 401,
      code: 'unauthorized'
    });
  }

  const source = String(input.source || '').trim();
  if (!REQUEST_SOURCES.has(source)) {
    throw new AutoPosterApplicationError('request source must be website, runtime, or internal_worker.');
  }

  const approvedBy = String((input.approval && input.approval.approvedBy) || '').trim();
  const idempotencyKey = String(
    (input.idempotency && input.idempotency.key) || input.idempotencyKey || ''
  );
  return Object.freeze({
    userId,
    actorId: String(input.actorId || userId).trim() || userId,
    // Provider account identifiers are opaque and case-sensitive. Preserve
    // the caller's exact bytes so validation can reject, rather than repair,
    // a non-canonical reference.
    accountId: String(input.accountId || ''),
    // Requested workspace identity is never authoritative by itself. Every
    // operation resolves and verifies membership server-side before storage.
    workspaceId: String(input.workspaceId || '').trim() || null,
    rawWorkspaceId: String(input.rawWorkspaceId === undefined
      ? (input.workspaceId || '')
      : input.rawWorkspaceId),
    commercialContext: input.commercialContext || null,
    source,
    correlationId: String(input.correlationId || '').trim(),
    approval: approvedBy ? Object.freeze({ approvedBy }) : null,
    idempotency: Object.freeze({ key: idempotencyKey })
  });
}

function countQueueItems(posts) {
  return (Array.isArray(posts) ? posts : []).reduce((counts, post) => {
    counts.total += 1;
    const status = String((post && post.status) || 'pending').toLowerCase();
    counts[status] = (counts[status] || 0) + 1;
    return counts;
  }, { total: 0, pending: 0, scheduled: 0, processing: 0, ready: 0, posted: 0, failed: 0 });
}

function coreResultView(result) {
  if (!result || typeof result !== 'object') return result;
  const { response, ...core } = result;
  return core;
}

function sanitizePostView(post, { advancedEvidence = true } = {}) {
  if (!post || typeof post !== 'object' || Array.isArray(post)) return post;
  const safeLastResult = sanitizePostResult(post.lastResult);
  const safeLastInstagramResult = sanitizePostResult(post.lastInstagramResult);
  const lastResult = advancedEvidence ? safeLastResult : coreResultView(safeLastResult);
  const lastInstagramResult = advancedEvidence
    ? safeLastInstagramResult
    : coreResultView(safeLastInstagramResult);
  const historySource = Array.isArray(post.history) && post.history.length > 0
    ? post.history
    : post.logs;
  const history = advancedEvidence ? sanitizeHistory(historySource) : [];
  const fallbackError = sanitizePostResult({ reason: post.lastError });
  return {
    ...post,
    lastResult,
    lastInstagramResult,
    lastError: (lastResult && lastResult.reason) || (fallbackError && fallbackError.reason) || '',
    history,
    logs: history
  };
}

function isHttpsUrl(value) {
  try {
    return new URL(String(value || '')).protocol === 'https:';
  } catch (error) {
    return false;
  }
}

function uploadRejectionCode(fileName, mimeType) {
  const mime = String(mimeType || '').toLowerCase();
  const lowerName = String(fileName || '').toLowerCase();
  if (mime.startsWith('image/')) return 'image_mime';
  if (mime.startsWith('video/')) return 'mime_extension_mismatch';
  if (/\.(png|jpe?g|gif|webp|bmp|heic|heif)$/.test(lowerName)) return 'image_extension';
  return 'unsupported_media';
}

function normalizeAccountIds(context, input = {}) {
  const raw = Array.isArray(input.accountIds)
    ? input.accountIds
    : [input.accountId || context.accountId];
  return [...new Set(raw.map((value) => String(value || '')).filter((value) => value.length > 0))];
}

function normalizeExplicitSchedule(value, { requireExplicitTimezone = false, requireFuture = false, nowMs = Date.now() } = {}) {
  const raw = String(value || '').trim();
  if (requireExplicitTimezone && !ISO_WITH_ZONE_PATTERN.test(raw)) {
    throw new AutoPosterApplicationError(
      'scheduledAt must be ISO-8601 with an explicit timezone, e.g. 2026-07-11T09:00:00Z.'
    );
  }
  const scheduledMs = Date.parse(raw);
  if (!raw || Number.isNaN(scheduledMs)) {
    throw new AutoPosterApplicationError('scheduledAt is not a parseable timestamp.');
  }
  if (requireFuture && scheduledMs <= nowMs) {
    throw new AutoPosterApplicationError('scheduledAt must be in the future.');
  }
  return new Date(scheduledMs).toISOString();
}

function targetScopedIdempotencyKey(provider, accountId, idempotencyKey) {
  const digest = createHash('sha256')
    .update(JSON.stringify([provider, accountId, idempotencyKey]))
    .digest('hex');
  return `runtime-target-${digest}`;
}

function legacyDeterministicPostId(userId, accountId, idempotencyKey, workspaceId = '') {
  const digest = createHash('sha256')
    .update(`${workspaceId}\n${userId}\n${accountId}\n${idempotencyKey}`)
    .digest('hex')
    .slice(0, 40);
  return `runtime-${digest}`;
}

function deterministicPostId(
  userId,
  accountId,
  idempotencyKey,
  workspaceId = '',
  provider = PROVIDER_TIKTOK
) {
  const digest = createHash('sha256')
    .update(JSON.stringify([workspaceId, userId, provider, accountId, idempotencyKey]))
    .digest('hex')
    .slice(0, 40);
  return `runtime-${digest}`;
}

function isAlreadyExistsError(error) {
  const code = error && error.code;
  return code === 6 || code === '6' || code === 'already-exists' || code === 'ALREADY_EXISTS';
}

function runtimeScheduleMetadata(input = {}, { required = false, allowBindingMismatch = false } = {}) {
  const missionId = String(input.runtimeMissionId || input.missionId || '');
  const action = String(input.runtimeAction || input.action || '');
  const missionPayloadHash = String(input.runtimePayloadHash || input.missionPayloadHash || '');
  const anyPresent = Boolean(missionId || action || missionPayloadHash);
  if (!required && !anyPresent) {
    return { missionId: '', action: '', missionPayloadHash: '' };
  }
  if (
    !missionId
    || missionId !== missionId.trim()
    || (!allowBindingMismatch && action !== RUNTIME_SCHEDULE_ACTION)
    || (allowBindingMismatch && (!action || action !== action.trim()))
    || !SHA256_HEX_PATTERN.test(missionPayloadHash)
  ) {
    throw new AutoPosterApplicationError('Runtime mission recovery metadata is invalid.', {
      status: 409,
      code: 'recovery_scope_mismatch'
    });
  }
  return { missionId, action, missionPayloadHash };
}

function runtimePostMatchesScope(post, {
  workspaceId,
  accountId,
  provider,
  idempotencyKey,
  metadata
}) {
  const storedWorkspaceId = String(post.workspaceId || '');
  const storedKey = String(post.runtimeIdempotencyKey || post.idempotencyKey || '');
  const hasStoredMetadata = Boolean(
    post.runtimeMissionId || post.runtimeAction || post.runtimePayloadHash
  );
  const hasRequestedMetadata = Boolean(
    metadata.missionId || metadata.action || metadata.missionPayloadHash
  );
  const storedProvider = hasStoredMetadata || hasRequestedMetadata
    ? String(post.provider || '')
    : providers.normalizeStoredProviderId(post.provider || post.platform).providerId;
  const metadataMatches = !hasStoredMetadata && !hasRequestedMetadata
    ? true
    : post.runtimeMissionId === metadata.missionId
      && post.runtimeAction === metadata.action
      && post.runtimePayloadHash === metadata.missionPayloadHash;
  const workspaceMatches = storedWorkspaceId === workspaceId
    || (!hasRequestedMetadata && !storedWorkspaceId);
  return workspaceMatches
    && post.accountId === accountId
    && storedProvider === provider
    && storedKey === idempotencyKey
    && metadataMatches;
}

function createAutoPosterApplicationService(dependencies = {}) {
  const storageAdapter = dependencies.storage || storage;
  const policy = dependencies.mediaPolicy || mediaPolicy;
  const now = dependencies.now || (() => Date.now());
  const maxSchedulePlanner = dependencies.computeMaxSchedulePlan || computeMaxSchedulePlan;
  const dailySchedulePlanner = dependencies.computeDailySchedulePlan || computeDailySchedulePlan;
  const batchStaggerPlanner = dependencies.computeBatchStaggerPlan || computeBatchStaggerPlan;
  const commercialAdapter = dependencies.commercialService || commercialService;
  const youtubeAdapter = dependencies.youtube || youtube;
  const injectFailure = typeof dependencies.failureInjector === 'function'
    ? dependencies.failureInjector
    : () => {};
  const inFlightRuntimeCreates = new Map();

  async function resolveCommercialContext(context) {
    if (
      context.commercialContext
      && context.commercialContext.workspace
      && context.commercialContext.userId === context.userId
      && (!context.workspaceId || context.commercialContext.workspace.workspaceId === context.workspaceId)
    ) {
      return context.commercialContext;
    }
    try {
      return await commercialAdapter.resolveContext({
        userId: context.userId,
        workspaceId: context.workspaceId
      });
    } catch (error) {
      throw new AutoPosterApplicationError(
        error && error.status === 404
          ? 'Workspace not found for this authenticated owner.'
          : 'Workspace, subscription, or usage truth could not be verified.',
        {
          status: Number(error && error.status) || 503,
          code: String((error && error.code) || 'commercial_truth_unverified'),
          details: {}
        }
      );
    }
  }

  function denialError(decision) {
    const hasValues = Number.isFinite(decision.current) && Number.isFinite(decision.limit);
    const current = hasValues ? Math.round(decision.current * 100) / 100 : null;
    const message = hasValues
      ? `${decision.reason} Current: ${current}. Limit: ${decision.limit}.`
      : decision.reason;
    return new AutoPosterApplicationError(message, {
      status: decision.reasonCode === 'runtime_scheduling_not_allowed' ? 403 : 409,
      code: decision.reasonCode,
      details: {
        allowed: false,
        reasonCode: decision.reasonCode,
        limit: decision.limit,
        current: decision.current,
        remaining: decision.remaining,
        planId: decision.planId,
        workspaceId: decision.workspaceId,
        evaluationTimestamp: decision.evaluationTimestamp
      }
    });
  }

  function toConnectedAccountView(account) {
    try {
      return connectedAccounts.toConnectedAccount(account, { now: now() });
    } catch (error) {
      throw translateProviderError(error);
    }
  }

  // One account lookup per provider — the sole account-resolution dispatch
  // point in the service. Unknown providers fail closed.
  async function getProviderAccount(
    context,
    providerId,
    accountId,
    commercialContext,
    { canonicalOnly = false } = {}
  ) {
    const workspaceScope = commercialContext && commercialContext.workspaceScope;
    if (providerId === PROVIDER_YOUTUBE) {
      return storageAdapter.getYouTubeAccount(context.userId, accountId, workspaceScope);
    }
    if (providerId === PROVIDER_TIKTOK) {
      if (canonicalOnly) {
        if (typeof storageAdapter.getCanonicalTikTokAccount !== 'function') {
          throw new AutoPosterApplicationError('Canonical connected-account storage is unavailable.', {
            status: 503,
            code: 'canonical_account_registry_unavailable'
          });
        }
        return storageAdapter.getCanonicalTikTokAccount(context.userId, accountId, workspaceScope);
      }
      return storageAdapter.getTikTokAccount(context.userId, accountId, workspaceScope);
    }
    throw new AutoPosterApplicationError(`Unsupported publishing provider: ${providerId || '(empty)'}.`, {
      status: 400,
      code: 'unknown_provider'
    });
  }

  function referenceMatchesWorkspace(reference, commercialContext) {
    const workspaceId = String(
      commercialContext && commercialContext.workspace && commercialContext.workspace.workspaceId || ''
    ).trim();
    const storedWorkspaceId = String((reference && reference.workspaceId) || '').trim();
    if (storedWorkspaceId) return storedWorkspaceId === workspaceId;
    return Boolean(
      commercialContext
      && commercialContext.workspaceScope
      && commercialContext.workspaceScope.allowLegacyOwnerRecords
    );
  }

  function accountValidationError(code, message, { status = 409, details = {} } = {}) {
    return new AutoPosterApplicationError(message, { status, code, details });
  }

  async function ownerAccountReferences(context) {
    if (typeof storageAdapter.listConnectedAccountReferencesForOwner !== 'function') return [];
    const references = await storageAdapter.listConnectedAccountReferencesForOwner(context.userId);
    return Array.isArray(references) ? references : [];
  }

  async function validateConnectedAccountForContext(
    context,
    input,
    { requireConnected = true, commercialContext, canonicalOnly = false } = {}
  ) {
    const accountId = String((input && input.accountId) || context.accountId || '');
    if (!accountId) {
      throw accountValidationError(
        ACCOUNT_VALIDATION_CODES.UNKNOWN,
        'Publishing account ID was not found for this workspace.',
        { status: 404 }
      );
    }
    if (accountId !== accountId.trim()) {
      throw accountValidationError(
        ACCOUNT_VALIDATION_CODES.NON_CANONICAL,
        'Publishing account IDs are exact; surrounding whitespace is not allowed.',
        { status: 400 }
      );
    }

    const providerResolution = providers.normalizeStoredProviderId(input && input.provider);
    const provider = providerResolution.providerId;
    if (!providerResolution.known || ![PROVIDER_TIKTOK, PROVIDER_YOUTUBE].includes(provider)) {
      throw new AutoPosterApplicationError(`Unsupported publishing provider: ${provider || '(empty)'}.`, {
        status: 400,
        code: 'unknown_provider'
      });
    }

    const account = await getProviderAccount(
      context,
      provider,
      accountId,
      commercialContext,
      { canonicalOnly }
    );
    if (!account) {
      const references = await ownerAccountReferences(context);
      const inWorkspace = references.filter((reference) =>
        referenceMatchesWorkspace(reference, commercialContext)
      );
      const otherWorkspace = references.find((reference) =>
        reference.provider === provider
        && reference.accountId === accountId
        && !referenceMatchesWorkspace(reference, commercialContext)
      );
      if (otherWorkspace) {
        throw accountValidationError(
          ACCOUNT_VALIDATION_CODES.WORKSPACE_MISMATCH,
          'Publishing account is not owned by the requested workspace.',
          { status: 403 }
        );
      }

      const exactOtherProvider = inWorkspace.find((reference) =>
        reference.accountId === accountId && reference.provider !== provider
      );
      if (exactOtherProvider) {
        throw accountValidationError(
          ACCOUNT_VALIDATION_CODES.PROVIDER_MISMATCH,
          'Selected publishing account does not match the requested provider.',
          {
            details: {
              accountId,
              requestedProvider: provider,
              accountProvider: exactOtherProvider.provider
            }
          }
        );
      }

      const caseMismatch = inWorkspace.find((reference) =>
        reference.provider === provider
        && reference.accountId !== accountId
        && reference.accountId.toLowerCase() === accountId.toLowerCase()
      );
      if (caseMismatch) {
        throw accountValidationError(
          ACCOUNT_VALIDATION_CODES.CASE_MISMATCH,
          'Publishing account ID character case does not match the canonical connected account.',
          { details: { canonicalAccountId: caseMismatch.accountId } }
        );
      }

      throw accountValidationError(
        ACCOUNT_VALIDATION_CODES.UNKNOWN,
        'Publishing account ID was not found for this workspace.',
        { status: 404, details: { provider } }
      );
    }

    const view = toConnectedAccountView(account);
    if (view.ownerUserId !== context.userId) {
      throw accountValidationError(
        ACCOUNT_VALIDATION_CODES.UNKNOWN,
        'Publishing account ID was not found for this workspace.',
        { status: 404, details: { provider } }
      );
    }
    if (!referenceMatchesWorkspace(account, commercialContext)) {
      throw accountValidationError(
        ACCOUNT_VALIDATION_CODES.WORKSPACE_MISMATCH,
        'Publishing account is not owned by the requested workspace.',
        { status: 403 }
      );
    }
    if (view.accountId !== accountId) {
      const isCaseMismatch = view.accountId.toLowerCase() === accountId.toLowerCase();
      throw accountValidationError(
        isCaseMismatch ? ACCOUNT_VALIDATION_CODES.CASE_MISMATCH : ACCOUNT_VALIDATION_CODES.UNKNOWN,
        isCaseMismatch
          ? 'Publishing account ID character case does not match the canonical connected account.'
          : 'Publishing account ID was not found for this workspace.',
        {
          status: isCaseMismatch ? 409 : 404,
          details: isCaseMismatch
            ? { canonicalAccountId: view.accountId }
            : { provider }
        }
      );
    }
    if (
      view.provider !== provider
      || view.connectionId !== connectedAccounts.connectionId(provider, accountId)
    ) {
      throw accountValidationError(
        ACCOUNT_VALIDATION_CODES.PROVIDER_MISMATCH,
        'Selected publishing account does not match the requested provider.',
        {
          details: { accountId, requestedProvider: provider, accountProvider: view.provider }
        }
      );
    }
    if (requireConnected && view.connectionStatus === connectedAccounts.CONNECTION_STATUS.DISCONNECTED) {
      throw accountValidationError(
        ACCOUNT_VALIDATION_CODES.DISCONNECTED,
        'Publishing account is disconnected and must be reconnected before scheduling.',
        {
          details: { accountId, provider, blockers: view.readinessBlockers }
        }
      );
    }
    if (requireConnected && !view.publishingReady) {
      const blocker = view.readinessBlockers[0];
      throw accountValidationError(
        ACCOUNT_VALIDATION_CODES.NOT_PUBLISHING_READY,
        `Publishing account is connected but not publishing-ready: ${connectedAccounts.describeReadinessBlocker(blocker)}.`,
        {
          details: { accountId, provider, blockers: view.readinessBlockers }
        }
      );
    }

    return { record: account, view, provider };
  }

  async function resolveOwnedAccounts(
    context,
    accountIds,
    { requireConnected = true, provider = PROVIDER_TIKTOK, commercialContext } = {}
  ) {
    if (accountIds.length === 0) {
      throw new AutoPosterApplicationError('Select a connected publishing channel before creating scheduled posts.');
    }

    const accounts = [];
    for (const accountId of accountIds) {
      const validated = await validateConnectedAccountForContext(
        context,
        { provider, accountId },
        {
          requireConnected,
          commercialContext,
          canonicalOnly: context.source === 'runtime'
        }
      );
      accounts.push(validated.record);
    }
    return accounts;
  }

  // Ownership check for scope filters (queue listing, status lookup): the
  // accountId may belong to either provider; the caller only needs proof
  // the channel exists and is owned by this tenant.
  async function findOwnedAccountAnyProvider(context, accountId, commercialContext) {
    const workspaceScope = commercialContext && commercialContext.workspaceScope;
    const tiktok = await storageAdapter.getTikTokAccount(context.userId, accountId, workspaceScope);
    if (tiktok) return tiktok;
    const youtube = typeof storageAdapter.getYouTubeAccount === 'function'
      ? await storageAdapter.getYouTubeAccount(context.userId, accountId, workspaceScope)
      : null;
    if (youtube) return youtube;
    throw new AutoPosterApplicationError('Publishing channel not found for this tenant.', {
      status: 404,
      code: 'not_found'
    });
  }

  function validateMedia(contextInput, input = {}) {
    createExecutionContext(contextInput);
    // Opt-in image acceptance for the Platform BATCH fan-out only. Every other
    // caller (classic/single intake, client portal, runtime control) omits this
    // flag and therefore stays strictly video-only. Public-URL intake remains
    // video-only regardless: the batch path uploads files, never URLs.
    const allowImageMedia = input.allowImageMedia === true;
    const isFileAccepted = allowImageMedia ? policy.isSupportedBatchUploadFile : policy.isVideoUploadFile;
    const uploadRejectMessage = allowImageMedia ? policy.BATCH_MEDIA_UPLOAD_MESSAGE : policy.VIDEO_ONLY_UPLOAD_MESSAGE;
    const mediaUrl = String(input.mediaUrl || input.publicMediaUrl || '').trim();
    const providedFiles = Array.isArray(input.files) ? input.files.filter(Boolean) : [];
    const standaloneFile = input.fileName || input.mimeType
      ? { originalname: String(input.fileName || ''), mimetype: String(input.mimeType || '') }
      : null;
    const files = providedFiles.length > 0 ? providedFiles : (standaloneFile ? [standaloneFile] : []);

    if (!mediaUrl && files.length === 0) {
      throw new AutoPosterApplicationError('Provide mediaUrl, or fileName/mimeType, to validate media.');
    }

    const contract = {
      videoOnly: !allowImageMedia,
      allowedExtensions: allowImageMedia
        ? [...policy.VIDEO_EXTENSIONS, ...policy.IMAGE_EXTENSIONS]
        : policy.VIDEO_EXTENSIONS,
      validator: 'mediaPolicy.js'
    };
    const rejected = (rejectionCode, reason) => ({
      valid: false,
      classification: 'rejected',
      rejectionCode,
      reason,
      policy: contract
    });

    if (mediaUrl) {
      if (!isHttpsUrl(mediaUrl)) {
        return rejected('not_https_url', 'Public Media URL must be a valid HTTPS URL.');
      }
      if (!policy.isVideoMediaUrl(mediaUrl)) {
        return rejected('unsupported_url', policy.VIDEO_ONLY_URL_MESSAGE);
      }
    }

    for (const file of files) {
      if (!isFileAccepted(file)) {
        return rejected(
          uploadRejectionCode(file.originalname, file.mimetype),
          uploadRejectMessage
        );
      }
    }

    return { valid: true, classification: allowImageMedia ? 'media' : 'video', policy: contract };
  }

  async function listQueue(contextInput, input = {}) {
    const context = createExecutionContext(contextInput);
    const commercialContext = await resolveCommercialContext(context);
    const accountId = String(input.accountId || context.accountId || '').trim();
    const rawLimit = input.limit === undefined ? DEFAULT_QUEUE_LIMIT : Number(input.limit);
    if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > MAX_QUEUE_LIMIT) {
      throw new AutoPosterApplicationError(`limit must be an integer between 1 and ${MAX_QUEUE_LIMIT}.`);
    }
    if (accountId) await findOwnedAccountAnyProvider(context, accountId, commercialContext);

    const posts = await storageAdapter.getPosts(
      context.userId,
      accountId || undefined,
      commercialContext.workspaceScope
    );
    const items = posts.slice(0, rawLimit).map((post) => sanitizePostView(post, {
      advancedEvidence: commercialContext.entitlements.advancedEvidence === true
    }));
    return {
      items,
      count: items.length,
      totalInScope: posts.length,
      counts: countQueueItems(posts),
      scope: {
        workspaceId: commercialContext.workspace.workspaceId,
        accountId: accountId || 'all'
      }
    };
  }

  async function getPostStatus(contextInput, input = {}) {
    const context = createExecutionContext(contextInput);
    const commercialContext = await resolveCommercialContext(context);
    const postId = String(input.postId || input.id || '').trim();
    const accountId = String(input.accountId || context.accountId || '').trim() || undefined;
    if (!postId) throw new AutoPosterApplicationError('postId is required.');
    const post = await storageAdapter.getPost(
      context.userId,
      postId,
      accountId,
      commercialContext.workspaceScope
    );
    if (!post) {
      throw new AutoPosterApplicationError('Post not found for this tenant/account scope.', {
        status: 404,
        code: 'not_found'
      });
    }
    return {
      post: sanitizePostView(post, {
        advancedEvidence: commercialContext.entitlements.advancedEvidence === true
      })
    };
  }

  function resolveSchedule(context, input, accounts, sourceCount) {
    const schedule = input.schedule || {};
    const mode = String(schedule.mode || 'automatic').trim();
    if (mode === 'automatic') return { mode };

    if (mode === 'explicit') {
      return {
        mode,
        scheduledAt: normalizeExplicitSchedule(schedule.scheduledAt, {
          requireExplicitTimezone: Boolean(schedule.requireExplicitTimezone),
          // Future enforcement happens only after idempotency replay lookup so
          // a delayed retry can still return the item created by the original.
          requireFuture: false,
          nowMs: now()
        }),
        requireFuture: Boolean(schedule.requireFuture)
      };
    }

    if (mode === 'browser_local') {
      const raw = String(schedule.value || '').trim();
      if (!raw) return { mode: 'automatic' };
      const scheduledAt = parseDateTimeLocal(raw, schedule.timezoneOffsetMinutes);
      if (!scheduledAt) {
        throw new AutoPosterApplicationError('The posting date/time could not be parsed.');
      }
      return { mode: 'explicit', scheduledAt };
    }

    if (mode === 'max') {
      const plan = maxSchedulePlanner({
        startDate: schedule.startDate,
        startTime: schedule.startTime,
        timezoneName: schedule.timezoneName,
        timezoneOffsetMinutes: schedule.timezoneOffsetMinutes,
        offsetMinutes: schedule.offsetMinutes,
        sourceCount,
        channels: accounts.map((account) => ({
          accountId: account.accountId,
          tiktokOpenId: account.open_id,
          username: account.username,
          connected: account.connected
        }))
      });
      if (!plan.ok) throw new AutoPosterApplicationError(plan.reason);
      return { mode, plan };
    }

    if (mode === 'staggered') {
      // Platform batch intake: item i releases at base + i * stagger on ONE
      // channel. The planner enforces the single-channel constraint.
      const plan = batchStaggerPlanner({
        startDate: schedule.startDate,
        startTime: schedule.startTime,
        timezoneName: schedule.timezoneName,
        timezoneOffsetMinutes: schedule.timezoneOffsetMinutes,
        staggerMinutes: schedule.staggerMinutes,
        sourceCount,
        channels: accounts.map((account) => ({
          accountId: account.accountId,
          tiktokOpenId: account.open_id,
          username: account.username,
          connected: account.connected
        }))
      });
      if (!plan.ok) throw new AutoPosterApplicationError(plan.reason);
      const firstSlot = plan.slots[0];
      if (!firstSlot || Date.parse(firstSlot.scheduledAt) <= now()) {
        throw new AutoPosterApplicationError('The first batch release must be scheduled in the future.');
      }
      return { mode, plan };
    }

    if (mode === 'batch_sync') {
      // Multi-account batch fan-out (V1.2): batchService computes ONE
      // channel-agnostic plan (maxScheduler.computeBatchSchedulePlan) and
      // reuses it across one schedulePost call per selected provider, so
      // every destination copy of the same source video is stamped with the
      // identical slot. This mode only validates the already-built plan; it
      // never builds one from raw date/time inputs (that stays batchService's
      // job, once, before any provider-specific account resolution happens).
      const plan = schedule.plan;
      const slots = plan && Array.isArray(plan.slots) ? plan.slots : [];
      if (slots.length === 0) {
        throw new AutoPosterApplicationError('The batch schedule plan has no release slots.');
      }
      const earliestMs = slots.reduce(
        (min, slot) => Math.min(min, Date.parse(slot.scheduledAt)),
        Number.POSITIVE_INFINITY
      );
      if (!Number.isFinite(earliestMs) || earliestMs <= now()) {
        throw new AutoPosterApplicationError('The first batch release must be scheduled in the future.');
      }
      return { mode, plan };
    }

    if (mode === 'recurring_daily') {
      const plan = dailySchedulePlanner({
        startDate: schedule.startDate,
        endDate: schedule.endDate,
        startTime: schedule.startTime,
        timezoneName: schedule.timezoneName,
        timezoneOffsetMinutes: schedule.timezoneOffsetMinutes,
        offsetMinutes: schedule.offsetMinutes,
        sourceCount,
        channels: accounts.map((account) => ({
          accountId: account.accountId,
          tiktokOpenId: account.open_id,
          username: account.username,
          connected: account.connected
        }))
      });
      if (!plan.ok) throw new AutoPosterApplicationError(plan.reason);
      const firstScheduledAt = plan.jobs && plan.jobs[0] && plan.jobs[0].scheduledAt;
      if (!firstScheduledAt || Date.parse(firstScheduledAt) <= now()) {
        throw new AutoPosterApplicationError('The first daily release must be scheduled in the future.');
      }
      return { mode, plan };
    }

    if (mode === 'explicit_plan') {
      if (context.source !== 'internal_worker') {
        throw new AutoPosterApplicationError('Explicit schedule plans are restricted to the controlled internal workflow.', {
          status: 403,
          code: 'forbidden'
        });
      }
      const rawPlan = schedule.plan || {};
      const rawChannels = Array.isArray(rawPlan.channels) ? rawPlan.channels : [];
      const expectedIds = accounts.map((account) => account.accountId);
      const planIds = rawChannels.map((channel) => String((channel && channel.accountId) || '').trim());
      if (
        rawChannels.length !== accounts.length
        || new Set(planIds).size !== accounts.length
        || expectedIds.some((accountId) => !planIds.includes(accountId))
      ) {
        throw new AutoPosterApplicationError('The explicit schedule plan must contain each selected channel exactly once.');
      }
      const validationNowMs = now();
      const normalizePlanTimestamp = (value) => {
        const normalized = normalizeExplicitSchedule(value);
        // The existing controlled CLI accepts --buffer-minutes 0. Preserve
        // that due-now behavior without accepting an arbitrarily stale plan
        // after the human confirmation and service hand-off.
        if (Date.parse(normalized) < validationNowMs - INTERNAL_PLAN_DUE_GRACE_MS) {
          throw new AutoPosterApplicationError('The controlled schedule plan is stale; rebuild it before creating queue items.');
        }
        return normalized;
      };
      const channels = rawChannels.map((channel, index) => ({
        accountId: String(channel.accountId),
        scheduledAt: normalizePlanTimestamp(channel.scheduledAt),
        offsetMinutes: Number(channel.offsetMinutes || 0),
        order: Number.isInteger(Number(channel.order)) ? Number(channel.order) : index
      }));
      return {
        mode: 'max',
        plan: {
          baseAt: normalizePlanTimestamp(rawPlan.baseAt || channels[0].scheduledAt),
          offsetMinutes: Number(rawPlan.offsetMinutes || 0),
          channels
        }
      };
    }

    throw new AutoPosterApplicationError(`Unsupported scheduling mode: ${mode}.`);
  }

  function partialScheduleError(created, reason) {
    const ids = created.map((post) => post.id);
    return new AutoPosterApplicationError(reason, {
      status: 500,
      code: 'internal',
      details: {
        createdPostId: ids.length === 1 ? ids[0] : undefined,
        createdPostIds: ids
      }
    });
  }

  function entitlementScheduleTimestamp(schedule, commercialContext, accounts, sourceCount) {
    if (schedule.mode === 'explicit') return schedule.scheduledAt;
    if (schedule.mode === 'staggered' || schedule.mode === 'batch_sync') {
      const values = (schedule.plan && Array.isArray(schedule.plan.slots))
        ? schedule.plan.slots.map((slot) => slot.scheduledAt).filter(Boolean)
        : [];
      return values.sort().at(-1) || null;
    }
    if (schedule.mode === 'max' || schedule.mode === 'recurring_daily') {
      const values = (schedule.plan && Array.isArray(schedule.plan.jobs))
        ? schedule.plan.jobs.map((job) => job.scheduledAt).filter(Boolean)
        : ((schedule.plan && Array.isArray(schedule.plan.channels))
            ? schedule.plan.channels.map((channel) => channel.scheduledAt).filter(Boolean)
            : []);
      return values.sort().at(-1) || null;
    }

    // Automatic scheduling is one item per account/day. Use the latest
    // already-scheduled item in each selected account plus the number of new
    // sources as the conservative horizon checkpoint; storage remains the
    // exact timezone-aware schedule writer.
    const currentMs = now();
    const dayMs = 24 * 60 * 60 * 1000;
    const firstAvailableCheckpoint = currentMs + dayMs;
    // Each account owns an independent daily schedule. The horizon is the
    // farthest account-local queue, not the sum of every account's queue.
    let farthest = firstAvailableCheckpoint + Math.max(1, sourceCount) * dayMs;
    for (const account of accounts) {
      const latest = (commercialContext.posts || [])
        .filter((post) => post.accountId === account.accountId && post.scheduledAt)
        .map((post) => Date.parse(post.scheduledAt))
        .filter((value) => Number.isFinite(value) && value > currentMs)
        .reduce((max, value) => Math.max(max, value), firstAvailableCheckpoint);
      farthest = Math.max(farthest, latest + Math.max(1, sourceCount) * dayMs);
    }
    return new Date(farthest).toISOString();
  }

  async function schedulePost(contextInput, input = {}) {
    const context = createExecutionContext(contextInput);
    const runtimeMetadata = context.source === 'runtime'
      ? runtimeScheduleMetadata(input)
      : { missionId: '', action: '', missionPayloadHash: '' };
    // Provider gate: a request without a provider targets TikTok (the only
    // active provider); an explicit provider must resolve through the
    // registry and be schedulable. Unknown and non-active providers fail
    // closed here, before any account, media, or queue work happens.
    const requestedProvider = providers.normalizeStoredProviderId(input.provider);
    let providerDefinition;
    try {
      providerDefinition = providers.assertSchedulableProvider(requestedProvider.providerId);
      providers.assertProviderCapability(providerDefinition.id, 'schedulable');
    } catch (error) {
      throw translateProviderError(error);
    }
    const provider = providerDefinition.id;

    // Provider-specific metadata contract. YouTube requires an explicit,
    // valid title (no silent caption-to-title mapping); TikTok requests
    // must not be burdened with YouTube fields.
    let youtubeMetadata = null;
    if (provider === PROVIDER_YOUTUBE) {
      const rawYouTube = input.youtube && typeof input.youtube === 'object' ? input.youtube : {};
      const checked = validateYouTubeMetadata({
        title: rawYouTube.title,
        description: rawYouTube.description
      });
      if (!checked.ok) {
        throw new AutoPosterApplicationError(checked.reason, { code: 'invalid_provider_metadata' });
      }
      youtubeMetadata = { title: checked.title, description: checked.description };
    }

    const commercialContext = await resolveCommercialContext(context);
    const accountIds = normalizeAccountIds(context, input);
    const accounts = await resolveOwnedAccounts(context, accountIds, { provider, commercialContext });
    // Per-destination sound mode: a map of accountId -> requested mode. Each
    // resolved account keeps its OWN mode (defaulting safely) so the fan-out
    // stamps independent sound modes on sibling copies of one canonical asset.
    const requestedSoundModes = input.soundModes && typeof input.soundModes === 'object'
      ? input.soundModes
      : {};
    const soundModeFor = (accountId) => normalizeSoundMode(
      Object.prototype.hasOwnProperty.call(requestedSoundModes, accountId)
        ? requestedSoundModes[accountId]
        : input.soundMode
    );
    const sourceCount = Array.isArray(input.files) && input.files.filter(Boolean).length > 0
      ? input.files.filter(Boolean).length
      : 1;
    const schedule = resolveSchedule(context, input, accounts, sourceCount);
    const idempotencyKey = context.idempotency.key;
    const occurrenceCount = schedule.mode === 'recurring_daily'
      ? Number((schedule.plan && schedule.plan.occurrenceCount) || 0)
      : 1;
    const quantity = accounts.length * sourceCount * Math.max(1, occurrenceCount);

    if (context.source === 'runtime' && !idempotencyKey) {
      throw new AutoPosterApplicationError('idempotencyKey is required.');
    }
    if (context.source === 'runtime' && idempotencyKey !== idempotencyKey.trim()) {
      throw new AutoPosterApplicationError(
        'idempotencyKey must be canonical and contain no surrounding whitespace.',
        { status: 409, code: 'recovery_scope_mismatch' }
      );
    }
    if (idempotencyKey && accounts.length !== 1) {
      throw new AutoPosterApplicationError('An idempotent schedule request must target exactly one publishing channel.');
    }

    const duplicateResult = (existing) => {
      const scheduleWasApplied = Boolean(existing.scheduledAt)
        && ['scheduled', 'processing', 'ready', 'posted', 'failed'].includes(existing.status);
      if (schedule.mode === 'explicit' && !scheduleWasApplied) {
        throw new AutoPosterApplicationError(
          'This idempotency key belongs to an existing incomplete draft. Review that queue item before retrying.',
          {
            status: 409,
            details: { createdPostId: existing.id }
          }
        );
      }
      return { duplicate: true, posts: [existing], post: existing, scheduledCount: 1, schedule, accounts };
    };

    let deterministicId = '';
    if (idempotencyKey) {
      const existingPosts = await storageAdapter.getPosts(
        context.userId,
        undefined,
        commercialContext.workspaceScope
      );
      const keyMatches = existingPosts.filter((post) =>
        post.idempotencyKey === idempotencyKey || post.runtimeIdempotencyKey === idempotencyKey
      );
      const exactMatches = keyMatches.filter((post) => runtimePostMatchesScope(post, {
        workspaceId: commercialContext.workspace.workspaceId,
        accountId: accounts[0].accountId,
        provider,
        idempotencyKey,
        metadata: runtimeMetadata
      }));
      const exactRecoveryMetadata = Boolean(
        runtimeMetadata.missionId
        || runtimeMetadata.action
        || runtimeMetadata.missionPayloadHash
      );
      if (exactRecoveryMetadata && keyMatches.length !== exactMatches.length) {
        throw new AutoPosterApplicationError(
          'This idempotency key is already bound to a different exact execution scope.',
          { status: 409, code: 'recovery_scope_mismatch' }
        );
      }
      if (exactMatches.length > 1) {
        throw new AutoPosterApplicationError(
          'Multiple queue records claim the same exact runtime execution scope.',
          {
            status: 409,
            code: 'reconciliation_required',
            details: { conflictingPostIds: exactMatches.map((post) => post.id) }
          }
        );
      }
      if (exactMatches.length === 1) return duplicateResult(exactMatches[0]);
      // Preserve replay for pre-provider-scope deterministic documents without
      // allowing a same-raw-id post from another provider to satisfy it.
      const legacyId = legacyDeterministicPostId(
        context.userId,
        accounts[0].accountId,
        idempotencyKey,
        commercialContext.workspace.workspaceId
      );
      const legacyExisting = await storageAdapter.getPost(
        context.userId,
        legacyId,
        accounts[0].accountId,
        commercialContext.workspaceScope
      );
      if (
        legacyExisting
        && providers.normalizeStoredProviderId(
          legacyExisting.provider || legacyExisting.platform
        ).providerId === provider
      ) {
        return duplicateResult(legacyExisting);
      }
      deterministicId = deterministicPostId(
        context.userId,
        accounts[0].accountId,
        idempotencyKey,
        commercialContext.workspace.workspaceId,
        provider
      );
      const deterministicExisting = await storageAdapter.getPost(
        context.userId,
        deterministicId,
        accounts[0].accountId,
        commercialContext.workspaceScope
      );
      if (deterministicExisting) {
        if (!runtimePostMatchesScope(deterministicExisting, {
          workspaceId: commercialContext.workspace.workspaceId,
          accountId: accounts[0].accountId,
          provider,
          idempotencyKey,
          metadata: runtimeMetadata
        })) {
          throw new AutoPosterApplicationError(
            'The deterministic queue record does not match this exact execution scope.',
            { status: 409, code: 'recovery_scope_mismatch' }
          );
        }
        return duplicateResult(deterministicExisting);
      }
    }

    if (
      schedule.mode === 'explicit'
      && schedule.requireFuture
      && Date.parse(schedule.scheduledAt) <= now()
    ) {
      throw new AutoPosterApplicationError('scheduledAt must be in the future.');
    }

    const authorization = await commercialAdapter.authorizeSchedule({
      resolvedContext: commercialContext,
      providerId: provider,
      source: context.source,
      quantity,
      scheduledAt: entitlementScheduleTimestamp(schedule, commercialContext, accounts, sourceCount)
    });
    if (!authorization.decision.allowed) throw denialError(authorization.decision);

    // Image media is admitted only on the explicit batch fan-out path; the
    // flag flows into media validation and the storage chokepoint together so
    // the two can never drift apart.
    const allowImageMedia = input.allowImageMedia === true;
    const media = validateMedia(context, {
      files: input.files,
      mediaUrl: input.mediaUrl || input.publicMediaUrl,
      allowImageMedia
    });
    if (!media.valid) throw new AutoPosterApplicationError(media.reason);
    const providerProofMode = provider === PROVIDER_YOUTUBE && input.providerProofMode === true;
    const approvedMedia = sanitizeApprovedMediaIdentity(input.approvedMedia, {
      maxByteSize: config.youtube.maxVideoBytes
    });
    if (providerProofMode && !approvedMedia) {
      throw new AutoPosterApplicationError('Provider-proof scheduling requires one complete approved-media identity.', {
        status: 400,
        code: 'approved_media_invalid'
      });
    }

    const firstAccount = accounts[0];
    const selfApprove = context.source === 'website' && context.approval
      ? { approvedBy: context.approval.approvedBy }
      : null;
    const requestedBy = String(input.requestedBy || context.actorId || '').trim();
    const creationDefaults = {
      caption: String(input.caption || '').trim(),
      hashtags: String(input.hashtags || '').trim(),
      publicMediaUrl: String(input.mediaUrl || input.publicMediaUrl || '').trim(),
      accounts: accounts.map((account) => ({
        accountId: account.accountId,
        tiktokOpenId: provider === PROVIDER_TIKTOK ? account.open_id : '',
        username: account.username,
        soundMode: soundModeFor(account.accountId)
      })),
      // Preserve the legacy single-account constructor contract.
      accountId: firstAccount.accountId,
      tiktokOpenId: provider === PROVIDER_TIKTOK ? firstAccount.open_id : '',
      username: firstAccount.username,
      soundMode: soundModeFor(firstAccount.accountId),
      preparedMedia: input.preparedMedia,
      selfApprove,
      provider,
      // Bounded provider metadata; storage locks privacyStatus to 'private'
      // and notifySubscribers to false at write time.
      providerMetadata: youtubeMetadata ? { youtube: youtubeMetadata } : undefined,
      creationSource: context.source,
      createdBy: context.actorId,
      correlationId: context.correlationId,
      idempotencyKey,
      runtimeIdempotencyKey: context.source === 'runtime' ? idempotencyKey : '',
      runtimeScheduledBy: context.source === 'runtime' ? requestedBy : '',
      runtimeMissionId: context.source === 'runtime' ? runtimeMetadata.missionId : '',
      runtimeGraphId: context.source === 'runtime' ? String(input.runtimeGraphId || '') : '',
      runtimeAction: context.source === 'runtime' ? runtimeMetadata.action : '',
      runtimePayloadHash: context.source === 'runtime' ? runtimeMetadata.missionPayloadHash : '',
      providerProofMode,
      approvedMedia: providerProofMode ? approvedMedia : null,
      scheduledAt: schedule.mode === 'explicit' ? schedule.scheduledAt : '',
      scheduleEntries: schedule.mode === 'recurring_daily' ? schedule.plan.jobs : undefined,
      scheduleSeries: schedule.mode === 'recurring_daily' ? schedule.plan.series : undefined,
      campaignStartAt: schedule.mode === 'recurring_daily' ? schedule.plan.baseAt : undefined,
      scheduleHistory: schedule.mode === 'explicit'
        ? (context.source === 'runtime'
            ? {
                event: 'runtime_scheduled',
                detail: `Scheduled via Agent Runtime by ${requestedBy || 'agent-runtime'} for ${schedule.scheduledAt}. Draft awaits human approval before publishing.`
              }
            : { event: 'scheduled', detail: `Posting time set during website intake for ${schedule.scheduledAt}.` })
        : (schedule.mode === 'recurring_daily'
            ? {
                event: 'series_scheduled',
                detail: `Daily series scheduled from ${schedule.plan.series.startDate} through ${schedule.plan.series.endDate}.`
              }
            : null),
      // Platform batch link: stamps batchId/batchOrder/preparation on every
      // created item so the batch runner can claim preparation work.
      batchId: String(input.batchId || '').trim(),
      // Carries the batch path's image opt-in through to the storage write
      // chokepoint (defense in depth: storage re-validates every source file).
      allowImageMedia,
      documentId: deterministicId,
      createOnly: Boolean(deterministicId),
      workspaceId: commercialContext.workspace.workspaceId,
      workspaceScope: commercialContext.workspaceScope,
      commercialEnforcement: true,
      usageReservation: {
        idempotencyKey: idempotencyKey
          ? targetScopedIdempotencyKey(provider, firstAccount.accountId, idempotencyKey)
          : '',
        usageCycle: {
          usageCycleId: commercialContext.cycle.usageCycleId,
          startAt: commercialContext.cycle.start,
          endAt: commercialContext.cycle.end
        },
        scheduledPostsPerCycle: commercialContext.entitlements.scheduledPostsPerCycle,
        activeQueueLimit: commercialContext.entitlements.activeQueueLimit,
        // The cycle counter is authoritative for current-cycle metered jobs;
        // this verified baseline covers legacy and prior-cycle active jobs so
        // the final transaction enforces the workspace-wide queue limit.
        activeQueueBaseline: Math.max(
          0,
          Number(commercialContext.activeQueueCount || 0)
            - Number((commercialContext.usage && commercialContext.usage.activeQueue) || 0)
        )
      }
    };

    let created;
    try {
      const existingCreate = deterministicId
        ? inFlightRuntimeCreates.get(deterministicId)
        : null;
      if (existingCreate) {
        const [concurrentPost] = await existingCreate;
        if (!concurrentPost || !runtimePostMatchesScope(concurrentPost, {
          workspaceId: commercialContext.workspace.workspaceId,
          accountId: firstAccount.accountId,
          provider,
          idempotencyKey,
          metadata: runtimeMetadata
        })) {
          throw new AutoPosterApplicationError(
            'The concurrent queue result does not match this exact execution scope.',
            { status: 409, code: 'recovery_scope_mismatch' }
          );
        }
        return duplicateResult(concurrentPost);
      }
      const createPosts = async () => {
        injectFailure('before_autoposter_durable_create', {
          missionId: runtimeMetadata.missionId,
          idempotencyKey,
          documentId: deterministicId
        });
        const result = await storageAdapter.addUploadedPosts(
          context.userId,
          Array.isArray(input.files) ? input.files : [],
          creationDefaults
        );
        injectFailure('after_autoposter_durable_create_before_response', {
          missionId: runtimeMetadata.missionId,
          idempotencyKey,
          documentId: deterministicId,
          createdPostIds: Array.isArray(result)
            ? result.map((post) => post && post.id).filter(Boolean)
            : []
        });
        return result;
      };
      const creation = createPosts();
      if (deterministicId) inFlightRuntimeCreates.set(deterministicId, creation);
      try {
        created = await creation;
      } finally {
        if (deterministicId && inFlightRuntimeCreates.get(deterministicId) === creation) {
          inFlightRuntimeCreates.delete(deterministicId);
        }
      }
    } catch (error) {
      if (deterministicId && isAlreadyExistsError(error)) {
        const existing = await storageAdapter.getPost(
          context.userId,
          deterministicId,
          firstAccount.accountId,
          commercialContext.workspaceScope
        );
        if (existing) {
          if (!runtimePostMatchesScope(existing, {
            workspaceId: commercialContext.workspace.workspaceId,
            accountId: firstAccount.accountId,
            provider,
            idempotencyKey,
            metadata: runtimeMetadata
          })) {
            throw new AutoPosterApplicationError(
              'The concurrently created queue record does not match this exact execution scope.',
              { status: 409, code: 'recovery_scope_mismatch' }
            );
          }
          return duplicateResult(existing);
        }
      }
      if (error && error.code && String(error.code).includes('limit')) {
        throw new AutoPosterApplicationError(error.message, {
          status: Number(error.status) || 409,
          code: error.code,
          details: error.details || {}
        });
      }
      throw error;
    }

    if (!Array.isArray(created) || created.length === 0) {
      throw new AutoPosterApplicationError('AutoPoster did not create a queue item.', {
        status: 500,
        code: 'internal'
      });
    }
    if (input.requireSingle && created.length !== 1) {
      throw partialScheduleError(
        created,
        `Expected exactly one queue item, got ${created.length}. The created items remain unscheduled drafts.`
      );
    }

    try {
      if (schedule.mode === 'explicit' || schedule.mode === 'recurring_daily') {
        if (created.some((post) => !post.scheduledAt || post.status !== 'scheduled')) {
          throw partialScheduleError(
            created,
            'Queue item creation returned without its requested schedule. Review the visible draft before retrying.'
          );
        }
        if (schedule.mode === 'recurring_daily' && created.length !== quantity) {
          throw partialScheduleError(
            created,
            `Expected ${quantity} recurring queue items, got ${created.length}. Review the visible drafts before retrying.`
          );
        }
        return {
          duplicate: false,
          posts: created,
          post: created.length === 1 ? created[0] : undefined,
          scheduledCount: created.length,
          schedule,
          accounts
        };
      }

      let scheduledCount = 0;
      if (schedule.mode === 'max') {
        scheduledCount = await storageAdapter.applyExplicitSchedule(
          context.userId,
          created,
          schedule.plan,
          commercialContext.workspaceScope
        );
      } else if (schedule.mode === 'staggered') {
        scheduledCount = await storageAdapter.applyStaggeredSchedule(
          context.userId,
          created,
          schedule.plan,
          commercialContext.workspaceScope
        );
      } else if (schedule.mode === 'batch_sync') {
        scheduledCount = await storageAdapter.applyBatchSourceSchedule(
          context.userId,
          created,
          schedule.plan,
          commercialContext.workspaceScope
        );
      } else {
        for (const account of accounts) {
          const ids = created.filter((post) => post.accountId === account.accountId).map((post) => post.id);
          scheduledCount += await storageAdapter.autoSchedulePosts(
            context.userId,
            ids,
            account.accountId,
            commercialContext.workspaceScope
          );
        }
      }
      if (scheduledCount !== created.length) {
        throw partialScheduleError(
          created,
          `Created ${created.length} queue item(s), but only ${scheduledCount} were scheduled. Review the queue before retrying.`
        );
      }
      const persisted = await Promise.all(created.map((post) =>
        storageAdapter.getPost(
          context.userId,
          post.id,
          post.accountId,
          commercialContext.workspaceScope
        )
      ));
      if (persisted.some((post) => !post || post.status !== 'scheduled' || !post.scheduledAt)) {
        throw partialScheduleError(
          created,
          'Scheduling reported success, but the persisted queue state could not be confirmed. Review the queue before retrying.'
        );
      }
      return {
        duplicate: false,
        posts: persisted,
        post: persisted.length === 1 ? persisted[0] : undefined,
        scheduledCount,
        schedule,
        accounts
      };
    } catch (error) {
      if (error instanceof AutoPosterApplicationError) throw error;
      throw partialScheduleError(
        created,
        'Queue item creation succeeded, but scheduling could not be fully confirmed. Review these items in the queue before retrying.'
      );
    }
  }

  async function approvePost(contextInput, input = {}) {
    const context = createExecutionContext(contextInput);
    const commercialContext = await resolveCommercialContext(context);
    if (context.source !== 'website' || !context.approval) {
      throw new AutoPosterApplicationError('Human website approval is required for this operation.', {
        status: 403,
        code: 'forbidden'
      });
    }
    const approvedBy = String(input.approvedBy || context.approval.approvedBy).trim();
    const post = await storageAdapter.approvePost(
      context.userId,
      String(input.postId || ''),
      { approvedBy },
      input.accountId || context.accountId || undefined,
      commercialContext.workspaceScope
    );
    return { ok: Boolean(post), post };
  }

  async function revokeApproval(contextInput, input = {}) {
    const context = createExecutionContext(contextInput);
    const commercialContext = await resolveCommercialContext(context);
    if (context.source !== 'website') {
      throw new AutoPosterApplicationError('Only the human website workflow can revoke approval.', {
        status: 403,
        code: 'forbidden'
      });
    }
    const post = await storageAdapter.revokePostApproval(
      context.userId,
      String(input.postId || ''),
      input.accountId || context.accountId || undefined,
      commercialContext.workspaceScope
    );
    return { ok: Boolean(post), post };
  }

  async function deletePost(contextInput, input = {}) {
    const context = createExecutionContext(contextInput);
    const commercialContext = await resolveCommercialContext(context);
    const postId = String(input.postId || '').trim();
    if (!postId) throw new AutoPosterApplicationError('postId is required.');
    let deleted;
    try {
      deleted = await storageAdapter.deletePost(
        context.userId,
        postId,
        input.accountId || context.accountId || undefined,
        commercialContext.workspaceScope
      );
    } catch (error) {
      if (error && error.code === 'queue_transition_blocked') {
        throw new AutoPosterApplicationError(error.message, {
          status: Number(error.status) || 409,
          code: error.code,
          details: {}
        });
      }
      throw error;
    }
    return { ok: Boolean(deleted), deleted: Boolean(deleted), postId };
  }

  async function deleteMarkedPosts(contextInput, input = {}) {
    const context = createExecutionContext(contextInput);
    const ids = [...new Set((Array.isArray(input.postIds) ? input.postIds : [])
      .map((id) => String(id || '').trim()).filter(Boolean))];
    if (ids.length === 0) throw new AutoPosterApplicationError('Select at least one post to delete.');
    if (ids.length > 200) throw new AutoPosterApplicationError('Too many posts selected — delete at most 200 at a time.');

    const deleted = [];
    const failed = [];
    for (const postId of ids) {
      try {
        const result = await deletePost(context, { postId, accountId: input.accountId });
        if (result.deleted) deleted.push(postId);
        else failed.push({ id: postId, reason: 'Post not found in your account.' });
      } catch (error) {
        failed.push({ id: postId, reason: error.message || 'Delete failed.' });
      }
    }
    return { ok: failed.length === 0, deleted, failed };
  }

  async function retryPost(contextInput, input = {}) {
    const context = createExecutionContext(contextInput);
    const commercialContext = await resolveCommercialContext(context);
    if (context.source !== 'website') {
      throw new AutoPosterApplicationError('Only the website workflow can retry a failed post.', {
        status: 403,
        code: 'forbidden'
      });
    }
    const postId = String(input.postId || '').trim();
    if (!postId) throw new AutoPosterApplicationError('postId is required.');

    const transition = await storageAdapter.retryFailedPost(
      context.userId,
      postId,
      input.accountId || context.accountId || undefined,
      commercialContext.workspaceScope
    );
    if (!transition || transition.outcome === 'not_found') {
      throw new AutoPosterApplicationError('Post not found for this tenant/account scope.', {
        status: 404,
        code: 'not_found'
      });
    }
    if (transition.outcome === 'attempt_budget_exhausted') {
      throw new AutoPosterApplicationError(
        'The durable publish-attempt budget is exhausted; this item cannot be retried under its current authorization.',
        {
          status: 409,
          code: 'attempt_budget_exhausted',
          details: {
            claimAttempts: transition.claimAttempts,
            effectiveAttemptBudget: transition.effectiveAttemptBudget
          }
        }
      );
    }
    if (transition.outcome === 'queue_transition_blocked') {
      const post = transition.post || {};
      throw new AutoPosterApplicationError(
        post.status === 'outcome_unknown'
          ? 'This provider outcome is unknown. Reconcile it before any retry.'
          : 'Only a definitively failed queue item can be retried.',
        { status: 409, code: 'queue_transition_blocked', details: {} }
      );
    }
    if (transition.outcome !== 'retried' || !transition.post) {
      throw new AutoPosterApplicationError('Retry transition could not be verified.', {
        status: 503,
        code: 'retry_truth_unverified'
      });
    }
    return { ok: true, post: transition.post };
  }

  async function reconcileProviderOperation(contextInput, input = {}) {
    const context = createExecutionContext(contextInput);
    if (context.source !== 'runtime') {
      throw new AutoPosterApplicationError('Provider reconciliation is restricted to the authenticated Runtime control surface.', {
        status: 403,
        code: 'forbidden'
      });
    }
    const commercialContext = await resolveCommercialContext(context);
    const postId = String(input.postId || input.id || '').trim();
    const accountId = String(input.accountId || context.accountId || '').trim();
    if (!postId || !accountId) throw new AutoPosterApplicationError('postId and accountId are required.');
    const current = await storageAdapter.getPost(
      context.userId,
      postId,
      accountId,
      commercialContext.workspaceScope
    );
    if (!current) {
      throw new AutoPosterApplicationError('Post not found for this tenant/account scope.', { status: 404, code: 'not_found' });
    }
    if (current.provider !== PROVIDER_YOUTUBE || !current.providerOperation) {
      throw new AutoPosterApplicationError('This queue job has no YouTube provider operation to reconcile.', {
        status: 409,
        code: 'provider_operation_not_available'
      });
    }
    const result = await youtubeAdapter.reconcileYouTubeProviderOperation({
      userId: context.userId,
      postId,
      accountId,
      workspaceScope: commercialContext.workspaceScope
    });
    const refreshed = await storageAdapter.getPost(
      context.userId,
      postId,
      accountId,
      commercialContext.workspaceScope
    );
    if (!refreshed) {
      throw new AutoPosterApplicationError('Post disappeared during provider reconciliation.', { status: 409, code: 'provider_operation_conflict' });
    }
    return {
      classification: String(result.classification || 'outcome_unknown'),
      post: sanitizePostView(refreshed, {
        advancedEvidence: commercialContext.entitlements.advancedEvidence === true
      })
    };
  }

  async function updatePost(contextInput, input = {}) {
    const context = createExecutionContext(contextInput);
    const commercialContext = await resolveCommercialContext(context);
    if (context.source !== 'website') {
      throw new AutoPosterApplicationError('Only the website workflow can edit a queue item.', {
        status: 403,
        code: 'forbidden'
      });
    }
    const postId = String(input.postId || '').trim();
    if (!postId) throw new AutoPosterApplicationError('postId is required.');
    const patch = { ...(input.patch || {}) };
    if (input.scheduleInput) {
      const raw = String(input.scheduleInput.value || '').trim();
      const scheduledAt = raw
        ? parseDateTimeLocal(raw, input.scheduleInput.timezoneOffsetMinutes)
        : null;
      if (raw && !scheduledAt) {
        throw new AutoPosterApplicationError('The posting date/time could not be parsed.');
      }
      patch.scheduledAt = scheduledAt;
    }
    const { post: current } = await getPostStatus(
      { ...context, commercialContext },
      { postId, accountId: input.accountId }
    );
    if (EDIT_BLOCKED_QUEUE_STATUSES.has(String(current.status || '').toLowerCase())) {
      throw new AutoPosterApplicationError(
        current.status === 'outcome_unknown'
          ? 'This provider outcome is unknown. Reconcile it before editing the queue item.'
          : 'A processing or completed queue item cannot be edited.',
        { status: 409, code: 'queue_transition_blocked', details: {} }
      );
    }
    const post = await storageAdapter.updatePost(
      context.userId,
      postId,
      patch,
      input.accountId || context.accountId || undefined,
      input.historyEvent,
      commercialContext.workspaceScope
    );
    if (!post) {
      throw new AutoPosterApplicationError('Post not found for this tenant/account scope.', {
        status: 404,
        code: 'not_found'
      });
    }
    return { ok: true, post };
  }

  // Per-item destination override for the Platform batch review flow. The
  // ONLY route by which an existing draft may move to another provider or
  // connected account (generic patches strip destination identity). Reuses
  // the exact validation the intake path uses: provider registry gate,
  // canonical connected-account resolution, workspace scoping, and the
  // provider-specific metadata contract. Approved jobs are locked.
  async function changePostDestination(contextInput, input = {}) {
    const context = createExecutionContext(contextInput);
    const commercialContext = await resolveCommercialContext(context);
    if (context.source !== 'website') {
      throw new AutoPosterApplicationError('Only the website workflow can change a queue item destination.', {
        status: 403,
        code: 'forbidden'
      });
    }
    const postId = String(input.postId || '').trim();
    if (!postId) throw new AutoPosterApplicationError('postId is required.');

    const requestedProvider = providers.normalizeStoredProviderId(input.provider);
    let providerDefinition;
    try {
      providerDefinition = providers.assertSchedulableProvider(requestedProvider.providerId);
      providers.assertProviderCapability(providerDefinition.id, 'schedulable');
    } catch (error) {
      throw translateProviderError(error);
    }
    const provider = providerDefinition.id;

    const validated = await validateConnectedAccountForContext(
      context,
      { provider, accountId: String(input.accountId || '').trim() },
      { requireConnected: true, commercialContext }
    );

    const { post: current } = await getPostStatus({ ...context, commercialContext }, { postId });
    if (EDIT_BLOCKED_QUEUE_STATUSES.has(String(current.status || '').toLowerCase())) {
      throw new AutoPosterApplicationError('A processing or completed queue item cannot change destination.', {
        status: 409,
        code: 'queue_transition_blocked'
      });
    }
    if (current.approved) {
      throw new AutoPosterApplicationError('Revoke approval before changing an approved item’s destination.', {
        status: 409,
        code: 'approval_locked'
      });
    }

    // Provider metadata contract: YouTube requires a valid title. A caller
    // may supply a new title/description; otherwise any previously stored
    // human-entered values are re-validated and carried forward.
    let youtubeMetadata = null;
    if (provider === PROVIDER_YOUTUBE) {
      const raw = input.youtube && typeof input.youtube === 'object' ? input.youtube : {};
      const existing = current.providerMetadata && current.providerMetadata.youtube
        ? current.providerMetadata.youtube
        : {};
      const checked = validateYouTubeMetadata({
        title: raw.title !== undefined ? raw.title : existing.title,
        description: raw.description !== undefined ? raw.description : existing.description
      });
      if (!checked.ok) {
        throw new AutoPosterApplicationError(checked.reason, { code: 'invalid_provider_metadata' });
      }
      youtubeMetadata = { title: checked.title, description: checked.description };
    }

    const view = validated.view;
    const result = await storageAdapter.changePostDestination(
      context.userId,
      postId,
      {
        provider,
        accountId: view.accountId,
        tiktokOpenId: provider === PROVIDER_TIKTOK ? view.providerAccountId : '',
        username: view.username || view.displayName || '',
        youtube: youtubeMetadata
      },
      commercialContext.workspaceScope
    );
    if (!result || result.outcome === 'not_found') {
      throw new AutoPosterApplicationError('Post not found for this tenant/account scope.', {
        status: 404,
        code: 'not_found'
      });
    }
    if (result.outcome === 'queue_transition_blocked') {
      throw new AutoPosterApplicationError('A processing or completed queue item cannot change destination.', {
        status: 409,
        code: 'queue_transition_blocked'
      });
    }
    if (result.outcome === 'approval_locked') {
      throw new AutoPosterApplicationError('Revoke approval before changing an approved item’s destination.', {
        status: 409,
        code: 'approval_locked'
      });
    }
    if (result.outcome !== 'changed') {
      throw new AutoPosterApplicationError('The destination change was refused.', {
        status: 400,
        code: String(result.outcome || 'invalid_destination')
      });
    }
    return {
      ok: true,
      identityChanged: Boolean(result.identityChanged),
      post: sanitizePostView(result.post, {
        advancedEvidence: commercialContext.entitlements.advancedEvidence === true
      })
    };
  }

  async function markPostManually(contextInput, input = {}) {
    const context = createExecutionContext(contextInput);
    if (context.source !== 'website') {
      throw new AutoPosterApplicationError('Only the human website workflow can mark a post manually.', {
        status: 403,
        code: 'forbidden'
      });
    }
    const nowIso = new Date(now()).toISOString();
    if (typeof storageAdapter.markPostManuallyWithUsage === 'function') {
      const commercialContext = await resolveCommercialContext(context);
      const post = await storageAdapter.markPostManuallyWithUsage(
        context.userId,
        input.postId,
        input.accountId || context.accountId || undefined,
        commercialContext.workspaceScope,
        nowIso
      );
      if (!post) {
        throw new AutoPosterApplicationError('Post not found for this tenant/account scope.', {
          status: 404,
          code: 'not_found'
        });
      }
      return { ok: true, post };
    }
    return updatePost(context, {
      postId: input.postId,
      accountId: input.accountId,
      patch: {
        status: 'posted',
        postedAt: nowIso,
        readyAt: null,
        lastResult: { ok: true, mode: 'manual', reason: 'Marked posted manually', completedAt: nowIso }
      },
      historyEvent: {
        event: 'marked_posted',
        detail: 'Marked posted manually by the operator; no API publish occurred.'
      }
    });
  }

  async function rescheduleQueue(contextInput, input = {}) {
    const context = createExecutionContext(contextInput);
    const commercialContext = await resolveCommercialContext(context);
    const accountId = String(input.accountId || context.accountId || '').trim();
    await resolveOwnedAccounts(context, [accountId], { commercialContext });
    const count = await storageAdapter.reschedulePendingQueue(
      context.userId,
      accountId,
      commercialContext.workspaceScope
    );
    return { ok: true, count, accountId };
  }

  // Shared connected-account resolution: the website and Agent Runtime both
  // read channel identity/readiness through these operations, so neither
  // surface can drift into its own account model. Responses are the safe
  // connected-account view only — never raw account records with tokens.
  async function getConnectedAccount(contextInput, input = {}) {
    const context = createExecutionContext(contextInput);
    const commercialContext = await resolveCommercialContext(context);
    const accountId = String(input.accountId || context.accountId || '').trim();
    if (!accountId) throw new AutoPosterApplicationError('accountId is required.');
    const requestedProvider = String(input.provider || '').trim().toLowerCase();
    const account = requestedProvider
      ? await getProviderAccount(context, requestedProvider, accountId, commercialContext)
      : await findOwnedAccountAnyProvider(context, accountId, commercialContext);
    if (!account) {
      throw new AutoPosterApplicationError('Publishing channel not found for this tenant.', {
        status: 404,
        code: 'not_found'
      });
    }
    const view = toConnectedAccountView(account);
    return { account: view, provider: providers.getProviderSummary(view.provider) };
  }

  async function validateConnectedAccount(contextInput, input = {}) {
    const context = createExecutionContext(contextInput);
    const commercialContext = await resolveCommercialContext(context);
    const provider = String(input.provider || '').trim().toLowerCase();
    if (!provider) {
      throw new AutoPosterApplicationError('provider is required.');
    }
    const validated = await validateConnectedAccountForContext(
      context,
      { provider, accountId: input.accountId },
      { requireConnected: true, commercialContext, canonicalOnly: true }
    );
    return {
      workspaceId: commercialContext.workspace.workspaceId,
      account: validated.view,
      provider: providers.getProviderSummary(validated.provider)
    };
  }

  async function reconcileRuntimeSchedule(contextInput, input = {}) {
    const context = createExecutionContext(contextInput);
    if (context.source !== 'runtime') {
      throw new AutoPosterApplicationError('Runtime reconciliation is restricted to the runtime control surface.', {
        status: 403,
        code: 'forbidden'
      });
    }
    const idempotencyKey = context.idempotency.key;
    if (!idempotencyKey) {
      throw new AutoPosterApplicationError('idempotencyKey is required for reconciliation.');
    }
    const metadata = runtimeScheduleMetadata(input, { required: true, allowBindingMismatch: true });
    const provider = String(input.provider || '');
    const accountId = String(input.accountId || '');
    const scheduledAt = String(input.scheduledAt || '');
    if (!ISO_WITH_ZONE_PATTERN.test(scheduledAt) || !Number.isFinite(Date.parse(scheduledAt))) {
      throw new AutoPosterApplicationError('Recovery schedule evidence is invalid.', {
        status: 409,
        code: 'recovery_evidence_invalid'
      });
    }

    const commercialContext = await resolveCommercialContext(context);
    const posts = await storageAdapter.getPosts(context.userId, undefined, undefined);
    const missionMatches = posts.filter((post) =>
      String(post.runtimeMissionId || '') === metadata.missionId
    );
    if (missionMatches.length === 0) {
      return {
        outcome: 'not_found',
        count: 0,
        unique: true,
        safeToReuse: false,
        approvalState: 'not_started',
        publishingState: 'not_started',
        evidenceStatus: 'not_found'
      };
    }

    const mismatchResult = (outcome) => ({
      outcome,
      count: missionMatches.length,
      unique: missionMatches.length === 1,
      safeToReuse: false,
      approvalState: 'unknown',
      publishingState: 'not_started',
      evidenceStatus: outcome
    });
    if (missionMatches.some((post) =>
      String(post.runtimeIdempotencyKey || '') !== idempotencyKey
    )) {
      return mismatchResult('idempotency_mismatch');
    }
    if (missionMatches.some((post) =>
      String(post.runtimePayloadHash || '') !== metadata.missionPayloadHash
    )) {
      return mismatchResult('payload_mismatch');
    }
    const exactWorkspaceId = context.rawWorkspaceId || '';
    if (missionMatches.some((post) =>
      String(post.runtimeAction || '') !== metadata.action
      || String(post.workspaceId || '') !== exactWorkspaceId
      || String(post.provider || '') !== provider
      || String(post.accountId || '') !== accountId
      || String(post.scheduledAt || '') !== scheduledAt
    )) {
      return mismatchResult('scope_mismatch');
    }
    const exactMatches = missionMatches;
    if (exactMatches.length > 1) {
      return {
        outcome: 'conflict',
        count: exactMatches.length,
        unique: false,
        safeToReuse: false,
        approvalState: 'unknown',
        publishingState: 'unknown',
        evidenceStatus: 'conflict',
        conflictingPostIds: exactMatches.map((post) => post.id).sort()
      };
    }

    const post = exactMatches[0];
    const safePostId = typeof post.id === 'string' && post.id && post.id === post.id.trim();
    const safeSchedule = typeof post.scheduledAt === 'string'
      && post.scheduledAt === scheduledAt;
    const safeToReuse = Boolean(
      safePostId
      && safeSchedule
      && post.status === 'scheduled'
      && post.approved === false
    );
    if (!safeToReuse) {
      return {
        outcome: 'unique',
        count: 1,
        unique: true,
        safeToReuse: false,
        approvalState: post.approved ? 'approved' : 'unknown',
        publishingState: ['processing', 'posted', 'failed'].includes(post.status)
          ? post.status
          : 'unknown',
        evidenceStatus: 'invalid'
      };
    }
    return {
      outcome: 'unique',
      count: 1,
      unique: true,
      safeToReuse: true,
      approvalState: 'required',
      publishingState: 'blocked_until_human_approval',
      evidenceStatus: 'authoritative',
      post
    };
  }

  async function listConnectedAccounts(contextInput, input = {}) {
    const context = createExecutionContext(contextInput);
    const commercialContext = await resolveCommercialContext(context);
    const requestedProvider = String((input && input.provider) || '').trim().toLowerCase();
    if (requestedProvider && !providers.isKnownProvider(requestedProvider)) {
      throw new AutoPosterApplicationError(`Unsupported publishing provider: ${requestedProvider}.`, {
        status: 400,
        code: 'unknown_provider'
      });
    }
    const includeTikTok = !requestedProvider || requestedProvider === PROVIDER_TIKTOK;
    const includeYouTube = (!requestedProvider || requestedProvider === PROVIDER_YOUTUBE)
      && typeof storageAdapter.getYouTubeAccounts === 'function';
    if (includeTikTok && typeof storageAdapter.getCanonicalTikTokAccounts !== 'function') {
      throw new AutoPosterApplicationError('Canonical connected-account storage is unavailable.', {
        status: 503,
        code: 'canonical_account_registry_unavailable'
      });
    }
    const tiktokAccounts = includeTikTok
      ? await storageAdapter.getCanonicalTikTokAccounts(
          context.userId,
          commercialContext.workspaceScope
        )
      : [];
    const youtubeAccounts = includeYouTube
      ? await storageAdapter.getYouTubeAccounts(context.userId, commercialContext.workspaceScope)
      : [];
    const views = [...(Array.isArray(tiktokAccounts) ? tiktokAccounts : []), ...(Array.isArray(youtubeAccounts) ? youtubeAccounts : [])]
      .map((account) => toConnectedAccountView(account))
      .filter(Boolean);
    return {
      accounts: views,
      count: views.length,
      workspaceId: commercialContext.workspace.workspaceId,
      // Backward-compatible single summary plus the per-provider list.
      provider: providers.getProviderSummary(requestedProvider || PROVIDER_TIKTOK),
      providers: [PROVIDER_TIKTOK, PROVIDER_YOUTUBE].map((id) => providers.getProviderSummary(id))
    };
  }

  async function getPlanUsage(contextInput) {
    const context = createExecutionContext(contextInput);
    const commercialContext = await resolveCommercialContext(context);
    const result = await commercialAdapter.getPlanUsage({ resolvedContext: commercialContext });
    return { commercialContext, view: result.view };
  }

  async function authorizeAccountConnection(contextInput, input = {}) {
    const context = createExecutionContext(contextInput);
    const commercialContext = await resolveCommercialContext(context);
    const provider = String(input.provider || '').trim().toLowerCase();
    const result = await commercialAdapter.authorizeAccountConnection({
      resolvedContext: commercialContext,
      providerId: provider,
      accountId: input.accountId
    });
    if (!result.decision.allowed) throw denialError(result.decision);
    // Internal-only transaction input. Limits and workspace identity come
    // exclusively from the server-resolved commercial context; controllers
    // never copy these values from request query/body fields.
    const activationContext = Object.freeze({
      ownerUserId: context.userId,
      workspaceId: commercialContext.workspace.workspaceId,
      provider,
      connectedAccountLimit: commercialContext.entitlements.connectedAccountLimit,
      providerLimit: commercialContext.entitlements.providerLimit
    });
    return {
      allowed: true,
      existing: result.existing,
      decision: result.decision,
      commercialContext,
      workspaceScope: commercialContext.workspaceScope,
      activationContext
    };
  }

  return {
    approvePost,
    changePostDestination,
    deleteMarkedPosts,
    deletePost,
    authorizeAccountConnection,
    getConnectedAccount,
    validateConnectedAccount,
    getPlanUsage,
    getPostStatus,
    listConnectedAccounts,
    listQueue,
    markPostManually,
    reconcileProviderOperation,
    reconcileRuntimeSchedule,
    rescheduleQueue,
    retryPost,
    revokeApproval,
    schedulePost,
    updatePost,
    validateMedia
  };
}

const defaultService = createAutoPosterApplicationService();

module.exports = {
  AutoPosterApplicationError,
  ACCOUNT_VALIDATION_CODES,
  DEFAULT_QUEUE_LIMIT,
  MAX_QUEUE_LIMIT,
  PROVIDER_TIKTOK,
  PROVIDER_YOUTUBE,
  REQUEST_SOURCES,
  countQueueItems,
  createAutoPosterApplicationService,
  createExecutionContext,
  deterministicPostId,
  targetScopedIdempotencyKey,
  isHttpsUrl,
  normalizeExplicitSchedule,
  ...defaultService
};
