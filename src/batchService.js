'use strict';

// Platform batch intake: massive upload -> persisted batch + item records ->
// bounded-parallel AI preparation -> human review -> staggered acceptance.
//
// Boundaries, stated once:
// - Batch ITEMS are ordinary queue posts (drafts). Every existing safety
//   gate — the approvedAt human gate, claimPost's transactional refusal of
//   unapproved work, attempt budgets, history evidence — applies unchanged.
// - This module never publishes. Acceptance approves a draft and guarantees
//   its release slot is safely in the future; the scheduler remains the only
//   publisher.
// - Preparation is resumable: per-item transactional lease claims in
//   storage.js make interrupted work reclaimable without double-preparing.

const fsPromises = require('fs/promises');
const os = require('os');
const path = require('path');
const { createHash, randomUUID } = require('crypto');
const defaultConfig = require('./config');
const defaultStorage = require('./storage');
const defaultAutoCaption = require('./autoCaption');
const defaultApplicationService = require('./autoposterApplicationService');
const { computeBatchSchedulePlan } = require('./maxScheduler');
const providers = require('./providers');
const { normalizeSoundMode } = require('./tiktokSoundMode');
const { isTikTokPrivacyLevel, normalizeTikTokPrivacyLevel } = require('./tiktokPrivacy');

// Fan-out destination count bound. Source-video count is already bounded by
// config.batchIntake.maxItems; this guards against an unbounded N x M
// explosion independent of that.
const MAX_DESTINATIONS = 10;

class BatchServiceError extends Error {
  constructor(message, { status = 400, code = 'validation_failed', details = {} } = {}) {
    super(message);
    this.name = 'BatchServiceError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function deriveBatchId(userId, workspaceId, intakeKey) {
  const digest = createHash('sha256')
    .update(`${workspaceId}\n${userId}\n${intakeKey}`)
    .digest('hex')
    .slice(0, 40);
  return `batch-${digest}`;
}

// Multi-account fan-out (V1.2): dedupe and shape the requested destination
// list. Anything malformed is silently dropped here — createBatch rejects an
// empty or unavailable result explicitly, so nothing invalid can proceed.
function normalizeDestinations(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const seen = new Set();
  const result = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const provider = String(entry.provider || '').trim().toLowerCase();
    const accountId = String(entry.accountId || '').trim();
    if (!provider || !accountId) continue;
    const key = `${provider}|${accountId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // Per-destination sound mode travels with the destination and is validated
    // to the safe default here so nothing malformed reaches the fan-out.
    result.push({ provider, accountId, soundMode: normalizeSoundMode(entry.soundMode) });
  }
  return result;
}

// Streamed HTTPS download with a hard byte cap and timeout. Used to bring a
// durable Cloudinary asset back to local disk for FFmpeg analysis, so
// preparation survives restarts even though intake staging files are gone.
async function defaultDownloadMedia(mediaUrl, { timeoutMs, maxBytes, targetPath }) {
  const url = new URL(String(mediaUrl || ''));
  if (url.protocol !== 'https:') {
    throw new BatchServiceError('Preparation media must be an HTTPS URL.', { code: 'media_unreachable' });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!response.ok || !response.body) {
      throw new BatchServiceError(`Media download failed with HTTP ${response.status}.`, { code: 'media_unreachable' });
    }
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > maxBytes) {
      throw new BatchServiceError('The media file is larger than the preparation limit.', { code: 'media_too_large' });
    }
    let received = 0;
    const handle = await fsPromises.open(targetPath, 'w');
    try {
      for await (const chunk of response.body) {
        received += chunk.length;
        if (received > maxBytes) {
          throw new BatchServiceError('The media file is larger than the preparation limit.', { code: 'media_too_large' });
        }
        await handle.write(chunk);
      }
    } finally {
      await handle.close();
    }
    return { bytes: received };
  } finally {
    clearTimeout(timer);
  }
}

function createBatchService(dependencies = {}) {
  const config = dependencies.config || defaultConfig;
  const storage = dependencies.storage || defaultStorage;
  const autoCaption = dependencies.autoCaption || defaultAutoCaption;
  const applicationService = dependencies.applicationService || defaultApplicationService;
  const downloadMedia = dependencies.downloadMedia || defaultDownloadMedia;
  const now = dependencies.now || (() => Date.now());
  const log = dependencies.logger || console;
  const settings = config.batchIntake;

  // One in-process preparation runner per batch. Cross-process safety comes
  // from the transactional per-item lease claims, not from this map.
  const activeRunners = new Map();

  async function resolveScope(context) {
    if (context.commercialContext && context.commercialContext.workspaceScope) {
      return context.commercialContext;
    }
    const resolved = await applicationService.getPlanUsage(context);
    return resolved.commercialContext;
  }

  function normalizeStagger(value) {
    if (value === undefined || value === null || value === '') return settings.staggerDefaultMinutes;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return null;
    if (parsed < settings.staggerMinMinutes || parsed > settings.staggerMaxMinutes) return null;
    return Math.round(parsed);
  }

  // ── Item view: derived validation, never duplicated canonical state ──────

  function itemValidation(post) {
    const problems = [];
    if (!String(post.mediaUrl || '').trim()) problems.push('missing_media');
    if (!String(post.caption || '').trim()) problems.push('missing_caption');
    // Provider-specific requirements follow the item's OWN destination: a
    // YouTube item cannot be accepted without the title its provider
    // contract requires (never silently derived from the caption).
    if (String(post.provider || '') === 'youtube') {
      const title = post.providerMetadata && post.providerMetadata.youtube
        ? String(post.providerMetadata.youtube.title || '').trim()
        : '';
      if (!title) problems.push('missing_youtube_title');
    }
    const preparation = post.preparation || null;
    if (preparation && (preparation.status === 'pending' || preparation.status === 'running')) {
      problems.push('preparation_in_progress');
    }
    const scheduledMs = post.scheduledAt ? Date.parse(post.scheduledAt) : NaN;
    if (!Number.isFinite(scheduledMs)) problems.push('missing_schedule');
    else if (scheduledMs < now() + settings.safetyBufferMinutes * 60_000 && !post.approved) {
      problems.push('schedule_in_past');
    }
    return problems;
  }

  function itemView(post) {
    const problems = itemValidation(post);
    const preparation = post.preparation || null;
    const prepStatus = preparation ? preparation.status : 'pending';
    let itemState;
    if (post.approved) itemState = 'accepted';
    else if (prepStatus === 'pending' || prepStatus === 'running') itemState = 'preparing';
    else if (prepStatus === 'failed' && problems.includes('missing_caption')) itemState = 'needs_attention';
    else if (problems.filter((problem) => !['schedule_in_past'].includes(problem)).length > 0) itemState = 'needs_attention';
    else itemState = 'ready';
    return {
      ...post,
      itemState,
      validationProblems: problems,
      // schedule_in_past never blocks acceptance: acceptance re-staggers to a
      // safe future slot, so it is a notice, not a defect.
      readyToAccept: !post.approved
        && ['pending', 'scheduled'].includes(post.status)
        && problems.filter((problem) => problem !== 'schedule_in_past').length === 0
    };
  }

  function deriveBatchStatus(items) {
    const total = items.length;
    const counts = {
      total,
      preparing: items.filter((item) => item.itemState === 'preparing').length,
      needsAttention: items.filter((item) => item.itemState === 'needs_attention').length,
      ready: items.filter((item) => item.itemState === 'ready').length,
      accepted: items.filter((item) => item.itemState === 'accepted').length,
      preparedOk: items.filter((item) => item.preparation && item.preparation.status === 'succeeded').length,
      prepareFailed: items.filter((item) => item.preparation && item.preparation.status === 'failed').length
    };
    let status;
    if (total === 0) status = 'empty';
    else if (counts.preparing > 0) status = 'preparing';
    else if (counts.accepted === total) status = 'completed';
    else if (counts.needsAttention > 0) status = 'attention_required';
    else status = 'ready';
    return { status, counts };
  }

  // ── Intake ───────────────────────────────────────────────────────────────

  async function createBatch(context, input = {}) {
    const files = Array.isArray(input.files) ? input.files.filter(Boolean) : [];
    if (files.length === 0) {
      throw new BatchServiceError('Upload at least one video or image to create a batch.');
    }
    if (files.length > settings.maxItems) {
      throw new BatchServiceError(`A batch can contain at most ${settings.maxItems} items.`, {
        code: 'batch_too_large'
      });
    }

    const destinations = normalizeDestinations(input.destinations);
    if (destinations.length === 0) {
      throw new BatchServiceError('Select at least one connected publishing account for this batch.');
    }
    if (destinations.length > MAX_DESTINATIONS) {
      throw new BatchServiceError(`A batch can target at most ${MAX_DESTINATIONS} destination accounts.`, {
        code: 'too_many_destinations'
      });
    }
    // Stated boundary, unchanged from V1: YouTube requires a human-entered
    // per-video title (never AI-generated), which cannot exist yet at bulk
    // intake time. YouTube stays reachable per item during review, through
    // the existing changeItemDestination override. Fan-out at intake is
    // scoped to providers that need no upfront per-item metadata.
    const unbatchable = destinations.filter((dest) => dest.provider === providers.PROVIDER_YOUTUBE);
    if (unbatchable.length > 0) {
      throw new BatchServiceError(
        'YouTube requires a human-entered title per video and cannot be selected at batch intake. Add it as a destination for individual items during review.',
        { status: 409, code: 'provider_not_batchable' }
      );
    }

    // Fail closed before any upload/creation work: every requested
    // destination must already be a connected, schedulable, publishing-ready
    // account. Nothing is invented for a disconnected or unknown provider.
    const known = await listDestinations(context);
    const knownKeys = new Set(known.destinations.map((dest) => `${dest.provider}|${dest.accountId}`));
    const unavailable = destinations.filter((dest) => !knownKeys.has(`${dest.provider}|${dest.accountId}`));
    if (unavailable.length > 0) {
      throw new BatchServiceError(
        `${unavailable.length === 1 ? 'This destination is' : 'These destinations are'} not connected and publishing-ready: `
          + unavailable.map((dest) => `${dest.provider}:${dest.accountId}`).join(', '),
        { status: 409, code: 'destination_unavailable' }
      );
    }

    const scheduleMode = String(input.scheduleMode || 'interval').trim();
    const staggerMinutes = scheduleMode === 'interval' ? normalizeStagger(input.staggerMinutes) : null;
    if (scheduleMode === 'interval' && staggerMinutes === null) {
      throw new BatchServiceError(
        `The stagger interval must be between ${settings.staggerMinMinutes} and ${settings.staggerMaxMinutes} minutes.`
      );
    }
    const plan = computeBatchSchedulePlan({
      mode: scheduleMode,
      sourceCount: files.length,
      timezoneName: input.timezoneName,
      timezoneOffsetMinutes: input.timezoneOffsetMinutes,
      startDate: input.startDate,
      startTime: input.startTime,
      staggerMinutes,
      firstDay: input.firstDay,
      lastDay: input.lastDay,
      postsPerDay: input.postsPerDay,
      dailyStartTime: input.dailyStartTime,
      dailyEndTime: input.dailyEndTime,
      intraDayIntervalMinutes: input.intraDayIntervalMinutes,
      dailySlots: input.dailySlots
    });
    if (!plan.ok) {
      throw new BatchServiceError(plan.reason, {
        code: 'schedule_invalid',
        details: { requiredSlots: plan.requiredSlots, availableSlots: plan.availableSlots }
      });
    }
    const earliestMs = plan.slots.reduce((min, slot) => Math.min(min, Date.parse(slot.scheduledAt)), Number.POSITIVE_INFINITY);
    if (!Number.isFinite(earliestMs) || earliestMs <= now()) {
      throw new BatchServiceError('The first batch release must be scheduled in the future.');
    }

    const intakeKey = String(input.intakeKey || '').trim() || randomUUID();
    const commercialContext = await resolveScope(context);
    const workspaceId = commercialContext.workspace.workspaceId;
    const batchId = deriveBatchId(context.userId, workspaceId, intakeKey);

    const existing = await storage.getBatchRecord(context.userId, batchId, commercialContext.workspaceScope);
    if (existing) {
      // Exact intake replay: return the durable truth; the route discards the
      // re-uploaded staging files. No second batch, no second usage charge.
      return { replayed: true, ...(await getBatchView(context, batchId)) };
    }

    const byProvider = new Map();
    for (const dest of destinations) {
      if (!byProvider.has(dest.provider)) byProvider.set(dest.provider, []);
      byProvider.get(dest.provider).push(dest);
    }
    const singleDestination = destinations.length === 1 ? destinations[0] : null;

    // Reserve the batch record BEFORE any post is created (create(), not
    // set() — a concurrent duplicate intake fails loudly). If the
    // multi-provider creation loop below fails partway, the catch block
    // removes both this record and any posts already created, so a retry
    // with the same intakeKey starts clean instead of duplicating copies.
    const record = await storage.createBatchRecord({
      batchId,
      userId: context.userId,
      workspaceId,
      provider: singleDestination ? singleDestination.provider : 'mixed',
      accountId: singleDestination ? singleDestination.accountId : '',
      accountLabel: singleDestination ? singleDestination.accountId : `${destinations.length} destination accounts`,
      status: 'preparing',
      itemCount: 0,
      videoCount: files.length,
      destinationCount: destinations.length,
      scheduleMode,
      staggerMinutes: staggerMinutes || 0,
      baseAt: plan.baseAt || plan.slots[0].scheduledAt,
      timezoneName: plan.timezone,
      intakeKey
    });

    let createdPosts = [];
    try {
      for (const [provider, providerDestinations] of byProvider) {
        const result = await applicationService.schedulePost(context, {
          provider,
          accountIds: providerDestinations.map((dest) => dest.accountId),
          // Independent sound mode per destination account, preserved through
          // fan-out so every sibling copy keeps its own choice.
          soundModes: Object.fromEntries(
            providerDestinations.map((dest) => [dest.accountId, dest.soundMode])
          ),
          // Batch intake is the one path that admits images alongside video;
          // the flag threads through media validation and the storage write.
          allowImageMedia: true,
          files,
          caption: String(input.caption || ''),
          hashtags: String(input.hashtags || ''),
          batchId,
          schedule: { mode: 'batch_sync', plan }
        });
        createdPosts = createdPosts.concat(result.posts);
      }
    } catch (error) {
      // Compensating cleanup: a retry with the same intakeKey must not see a
      // half-created batch and must not multiply destination copies.
      await Promise.allSettled(
        createdPosts.map((post) =>
          applicationService.deletePost(context, { postId: post.id, accountId: post.accountId }).catch(() => {})
        )
      );
      await storage.deleteBatchRecord(context.userId, batchId, commercialContext.workspaceScope).catch(() => {});
      throw error;
    }

    await storage.updateBatchRecord(context.userId, batchId, { itemCount: createdPosts.length }, commercialContext.workspaceScope);

    startPreparation(context, batchId).catch((error) => {
      log.warn('[batch] preparation kickoff failed', { batchId, message: error.message });
    });

    return {
      replayed: false,
      batch: { ...record, itemCount: createdPosts.length },
      items: createdPosts.map(itemView)
    };
  }

  // ── Views ────────────────────────────────────────────────────────────────

  async function getBatchView(context, batchId, options = {}) {
    const commercialContext = await resolveScope(context);
    const record = await storage.getBatchRecord(context.userId, batchId, commercialContext.workspaceScope);
    if (!record) {
      throw new BatchServiceError('Batch not found for this workspace.', { status: 404, code: 'not_found' });
    }
    const posts = await storage.getBatchPosts(context.userId, batchId, commercialContext.workspaceScope);
    const items = posts.map(itemView);
    const derived = deriveBatchStatus(items);

    // Resume-on-view: if durable item state says work is still owed and no
    // runner is active in this process, restart it. Idempotent via leases.
    if (options.autoResume !== false && derived.status === 'preparing' && !activeRunners.has(runnerKey(context.userId, batchId))) {
      startPreparation(context, batchId).catch((error) => {
        log.warn('[batch] preparation auto-resume failed', { batchId, message: error.message });
      });
    }

    return {
      batch: { ...record, status: derived.status, counts: derived.counts },
      items
    };
  }

  async function listBatches(context, limit = 20) {
    const commercialContext = await resolveScope(context);
    const records = await storage.listBatchRecords(context.userId, commercialContext.workspaceScope, limit);
    return { batches: records };
  }

  // ── Preparation engine ───────────────────────────────────────────────────

  function runnerKey(userId, batchId) {
    return `${userId}:${batchId}`;
  }

  async function startPreparation(context, batchId) {
    const key = runnerKey(context.userId, batchId);
    const existing = activeRunners.get(key);
    if (existing) return existing;

    const run = (async () => {
      try {
        await runPreparation(context, batchId);
      } finally {
        activeRunners.delete(key);
      }
    })();
    activeRunners.set(key, run);
    return run;
  }

  async function runPreparation(context, batchId) {
    const commercialContext = await resolveScope(context);
    const scope = commercialContext.workspaceScope;
    const posts = await storage.getBatchPosts(context.userId, batchId, scope);
    const queue = posts
      .filter((post) => {
        const preparation = post.preparation;
        if (!preparation) return false;
        return preparation.status !== 'succeeded';
      })
      .sort((a, b) => (a.batchOrder ?? 0) - (b.batchOrder ?? 0));

    const concurrency = Math.max(1, settings.prepareConcurrency);
    let cursor = 0;
    const workers = [];
    for (let slot = 0; slot < Math.min(concurrency, queue.length); slot += 1) {
      workers.push((async () => {
        while (cursor < queue.length) {
          const post = queue[cursor];
          cursor += 1;
          await prepareOneItem(context.userId, post.id);
        }
      })());
    }
    await Promise.all(workers);
    await refreshBatchRecord(context, batchId, scope);
  }

  async function prepareOneItem(userId, postId) {
    const claim = await storage.claimBatchItemPreparation(userId, postId, {
      leaseMs: settings.prepareLeaseMinutes * 60_000,
      maxAttempts: settings.prepareMaxAttempts
    });
    if (claim.outcome !== 'claimed') return claim;

    const post = claim.post;
    let result;
    try {
      result = await generateItemCopy(post);
    } catch (error) {
      result = { ok: false, error: error.message || 'Preparation failed.' };
    }
    await storage.recordBatchItemPreparationResult(userId, postId, result);
    return { outcome: 'processed', ok: result.ok };
  }

  // Classify a batch item without trusting a filename over the canonical field.
  // mediaType is authoritative (storage stamps 'photo'/'video' from the upload
  // MIME); a video is only ever diverted to the image path if its OWN mediaType
  // says photo, so legacy video preparation is bit-for-bit unchanged.
  function isPhotoItem(post) {
    const mediaType = String(post.mediaType || '').toLowerCase();
    if (mediaType === 'photo') return true;
    if (mediaType === 'video') return false;
    const name = String(post.fileName || post.originalName || '').toLowerCase();
    const looksVideo = ['.mp4', '.mov', '.webm'].some((ext) => name.endsWith(ext));
    return !looksVideo && ['.jpg', '.jpeg', '.png', '.webp'].some((ext) => name.endsWith(ext));
  }

  async function generateItemCopy(post) {
    const mediaUrl = String(post.mediaUrl || '').trim();
    if (!mediaUrl) {
      return { ok: false, error: 'The item has no durable media URL to analyze.' };
    }
    // Image-safe preparation: this task adds no image caption model, so a photo
    // item is NOT downloaded and NEVER routed through video-only ffprobe /
    // frame / audio analysis. Preparation succeeds truthfully with no generated
    // copy — the operator's manual caption/hashtags are preserved untouched
    // (a captionless item then simply shows as needs_attention in review). The
    // batch always progresses even when no automatic image caption exists.
    if (isPhotoItem(post)) {
      return { ok: true, caption: '', hashtags: '', provider: '', fallbackUsed: false, mediaKind: 'photo' };
    }
    const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'chanter-batch-'));
    const extension = path.extname(String(post.fileName || '')).toLowerCase() || '.mp4';
    const tempPath = path.join(tempDir, `prepare${extension}`);
    try {
      await downloadMedia(mediaUrl, {
        timeoutMs: settings.downloadTimeoutMs,
        maxBytes: settings.maxDownloadBytes,
        targetPath: tempPath
      });
      const analysis = await autoCaption.analyzeVideoForCaption(
        tempPath,
        { caption: String(post.caption || ''), hashtags: String(post.hashtags || '') },
        { filename: String(post.originalName || post.fileName || '') }
      );
      return {
        ok: true,
        caption: analysis.caption,
        hashtags: analysis.hashtags,
        provider: analysis.provider || '',
        fallbackUsed: Boolean(analysis.fallbackUsed)
      };
    } finally {
      await fsPromises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function refreshBatchRecord(context, batchId, scope) {
    const posts = await storage.getBatchPosts(context.userId, batchId, scope);
    const items = posts.map(itemView);
    const derived = deriveBatchStatus(items);
    await storage.updateBatchRecord(context.userId, batchId, {
      status: derived.status,
      itemCount: derived.counts.total,
      preparedCount: derived.counts.preparedOk,
      failedCount: derived.counts.prepareFailed,
      acceptedCount: derived.counts.accepted
    }, scope);
    return derived;
  }

  async function resumePreparation(context, batchId) {
    const view = await getBatchView(context, batchId, { autoResume: false });
    await startPreparation(context, batchId);
    return view;
  }

  // ── Review: edit + destination + accept ──────────────────────────────────

  async function findBatchItem(context, batchId, postId, workspaceScope) {
    const posts = await storage.getBatchPosts(context.userId, batchId, workspaceScope);
    const post = posts.find((candidate) => candidate.id === String(postId || '').trim());
    if (!post) {
      throw new BatchServiceError('This item does not belong to the batch.', { status: 404, code: 'not_found' });
    }
    return post;
  }

  async function updateItem(context, batchId, postId, input = {}) {
    const commercialContext = await resolveScope(context);
    let post = await findBatchItem(context, batchId, postId, commercialContext.workspaceScope);

    const patch = {};
    if (typeof input.caption === 'string') patch.caption = input.caption.trim().slice(0, 2200);
    if (typeof input.hashtags === 'string') patch.hashtags = input.hashtags.trim().slice(0, 500);
    // Per-destination TikTok privacy. Reuses the canonical `privacyLevel` field
    // and validates against the one privacy vocabulary; an unknown value is
    // rejected here with an operator-visible, typed error (never silently
    // normalized) so a proof item can be set to SELF_ONLY with certainty. The
    // control is TikTok-only — non-TikTok destinations carry no such field.
    if (typeof input.privacyLevel === 'string' && input.privacyLevel.trim()) {
      if (String(post.provider || '') !== 'tiktok') {
        throw new BatchServiceError('A TikTok privacy level applies only to items whose destination is TikTok.', {
          status: 409,
          code: 'provider_mismatch'
        });
      }
      if (!isTikTokPrivacyLevel(input.privacyLevel)) {
        throw new BatchServiceError('Choose a valid TikTok privacy level.', { code: 'invalid_privacy_level' });
      }
      patch.privacyLevel = normalizeTikTokPrivacyLevel(input.privacyLevel);
    }
    const scheduleInput = input.scheduleInput && typeof input.scheduleInput === 'object'
      ? { value: String(input.scheduleInput.value || ''), timezoneOffsetMinutes: input.scheduleInput.timezoneOffsetMinutes }
      : undefined;
    const titleEdit = typeof input.youtubeTitle === 'string' || typeof input.youtubeDescription === 'string';
    if (Object.keys(patch).length === 0 && !scheduleInput && !titleEdit) {
      throw new BatchServiceError('Provide a caption, hashtags, a release time, a privacy level, or a YouTube title to update.');
    }

    // Provider-specific text lives behind the dedicated destination
    // operation (generic patches strip providerMetadata). Same destination,
    // new metadata — validated against the provider contract.
    if (titleEdit) {
      if (String(post.provider || '') !== 'youtube') {
        throw new BatchServiceError('A YouTube title applies only to items whose destination is YouTube.', {
          status: 409,
          code: 'provider_mismatch'
        });
      }
      const result = await applicationService.changePostDestination(context, {
        postId: post.id,
        provider: 'youtube',
        accountId: post.accountId,
        youtube: {
          ...(typeof input.youtubeTitle === 'string' ? { title: input.youtubeTitle } : {}),
          ...(typeof input.youtubeDescription === 'string' ? { description: input.youtubeDescription } : {})
        }
      });
      post = result.post;
    }

    if (Object.keys(patch).length > 0 || scheduleInput) {
      const updated = await applicationService.updatePost(context, {
        postId: post.id,
        accountId: post.accountId,
        patch,
        scheduleInput,
        historyEvent: { event: 'edited', detail: 'Batch review edit from the Platform.' }
      });
      post = updated.post;
    }
    return { item: itemView(post) };
  }

  async function changeItemDestination(context, batchId, postId, input = {}) {
    const commercialContext = await resolveScope(context);
    const post = await findBatchItem(context, batchId, postId, commercialContext.workspaceScope);

    const provider = String(input.provider || '').trim().toLowerCase();
    const accountId = String(input.accountId || '').trim();
    if (!provider || !accountId) {
      throw new BatchServiceError('Select a destination provider and connected channel.');
    }
    const youtube = provider === 'youtube'
      ? {
          ...(typeof input.youtubeTitle === 'string' ? { title: input.youtubeTitle } : {}),
          ...(typeof input.youtubeDescription === 'string' ? { description: input.youtubeDescription } : {})
        }
      : undefined;

    const result = await applicationService.changePostDestination(context, {
      postId: post.id,
      provider,
      accountId,
      youtube
    });
    return { item: itemView(result.post), identityChanged: result.identityChanged };
  }

  // Connected destinations the review surface may offer. Only connected
  // accounts of schedulable providers are listed; nothing is fabricated for
  // unconfigured providers.
  async function listDestinations(context) {
    const resolved = await applicationService.listConnectedAccounts(context);
    const schedulable = new Set(
      (resolved.providers || [])
        .filter((summary) => summary && summary.schedulable && summary.implementationStatus === 'active')
        .map((summary) => summary.id)
    );
    return {
      destinations: (resolved.accounts || [])
        .filter((account) => account.connectionStatus === 'connected' && schedulable.has(account.provider))
        .map((account) => ({
          provider: account.provider,
          providerDisplayName: account.providerDisplayName,
          accountId: account.accountId,
          label: account.username
            ? `@${account.username}`
            : (account.displayName || account.accountId),
          publishingReady: account.publishingReady === true
        }))
    };
  }

  async function acceptItems(context, batchId, input = {}) {
    if (!context.approval || !context.approval.approvedBy) {
      throw new BatchServiceError('Acceptance requires an explicit human approver.', {
        status: 403,
        code: 'forbidden'
      });
    }
    const commercialContext = await resolveScope(context);
    const scope = commercialContext.workspaceScope;
    const record = await storage.getBatchRecord(context.userId, batchId, scope);
    if (!record) {
      throw new BatchServiceError('Batch not found for this workspace.', { status: 404, code: 'not_found' });
    }
    const posts = await storage.getBatchPosts(context.userId, batchId, scope);
    const items = posts.map(itemView);

    const requestedIds = input.postIds === 'all' || input.postIds === undefined
      ? null
      : new Set((Array.isArray(input.postIds) ? input.postIds : [input.postIds]).map((id) => String(id || '').trim()));

    const targets = items.filter((item) => {
      if (item.approved) return false;
      if (requestedIds) return requestedIds.has(item.id);
      return item.readyToAccept;
    });
    if (requestedIds) {
      for (const id of requestedIds) {
        if (!items.some((item) => item.id === id)) {
          throw new BatchServiceError(`Item ${id} does not belong to this batch.`, { status: 404, code: 'not_found' });
        }
      }
    }
    if (targets.length === 0) {
      return { accepted: [], failed: [], skipped: items.filter((item) => item.approved).map((item) => item.id) };
    }

    // Safe staggered acceptance: walk targets in release order and guarantee
    // every accepted slot is (a) at least the safety buffer in the future and
    // (b) at least one stagger interval after the previous slot. Nothing is
    // ever pulled earlier, so nothing can publish immediately.
    //
    // Fan-out awareness: destination copies of the SAME source video
    // (matching sourceIndex) are one GROUP and move together — they keep one
    // shared slot rather than drifting apart from each other, even though
    // each member can still independently succeed, fail, or be skipped
    // (spec: synchronized fan-out slots must survive acceptance-time safety
    // correction). A non-batch/legacy item with no sourceIndex is its own
    // singleton group, so single-destination batches behave exactly as
    // before this change.
    const staggerMs = Math.max(1, record.staggerMinutes || settings.staggerDefaultMinutes) * 60_000;
    const bufferMs = settings.safetyBufferMinutes * 60_000;

    const groupKey = (item) => (item.sourceIndex !== null && item.sourceIndex !== undefined)
      ? `src:${item.sourceIndex}`
      : `item:${item.id}`;
    const groupsByKey = new Map();
    for (const item of targets) {
      const key = groupKey(item);
      if (!groupsByKey.has(key)) groupsByKey.set(key, []);
      groupsByKey.get(key).push(item);
    }
    const groups = [...groupsByKey.values()]
      .map((members) => {
        const sortedMembers = [...members].sort((a, b) => (a.batchOrder ?? 0) - (b.batchOrder ?? 0));
        const msValues = sortedMembers
          .map((member) => (member.scheduledAt ? Date.parse(member.scheduledAt) : NaN))
          .filter((value) => Number.isFinite(value));
        const representativeMs = msValues.length > 0 ? Math.min(...msValues) : Number.MAX_SAFE_INTEGER;
        return { members: sortedMembers, representativeMs, minBatchOrder: sortedMembers[0] ? (sortedMembers[0].batchOrder ?? 0) : 0 };
      })
      .sort((a, b) => {
        if (a.representativeMs !== b.representativeMs) return a.representativeMs - b.representativeMs;
        return a.minBatchOrder - b.minBatchOrder;
      });

    const accepted = [];
    const failed = [];
    let previousMs = 0;
    for (const group of groups) {
      const currentMs = group.representativeMs !== Number.MAX_SAFE_INTEGER ? group.representativeMs : NaN;
      const minimumMs = Math.max(now() + bufferMs, previousMs > 0 ? previousMs + staggerMs : 0);
      let finalMs = Number.isFinite(currentMs) ? currentMs : minimumMs;
      if (finalMs < minimumMs) finalMs = minimumMs;

      for (const item of group.members) {
        try {
          if (!item.readyToAccept) {
            throw new BatchServiceError(
              item.itemState === 'preparing'
                ? 'This item is still being prepared.'
                : `This item is not ready: ${item.validationProblems.join(', ') || item.itemState}.`,
              { status: 409, code: 'item_not_ready' }
            );
          }
          // Destination truth may have changed since review rendered: the
          // item's OWN provider/account must still resolve to a connected,
          // publishing-ready channel at the moment of acceptance.
          try {
            await applicationService.validateConnectedAccount(context, {
              provider: item.provider,
              accountId: item.accountId
            });
          } catch (error) {
            throw new BatchServiceError(
              `The destination channel is no longer available: ${error.message}`,
              { status: 409, code: 'destination_unavailable' }
            );
          }
          const itemCurrentMs = item.scheduledAt ? Date.parse(item.scheduledAt) : NaN;
          if (itemCurrentMs !== finalMs) {
            await applicationService.updatePost(context, {
              postId: item.id,
              accountId: item.accountId,
              patch: { scheduledAt: new Date(finalMs).toISOString() },
              historyEvent: {
                event: 'rescheduled',
                detail: `Moved to ${new Date(finalMs).toISOString()} at acceptance to keep a safe, synchronized release.`
              }
            });
          }
          const approval = await applicationService.approvePost(context, {
            postId: item.id,
            accountId: item.accountId,
            approvedBy: context.approval.approvedBy
          });
          if (!approval.ok) {
            throw new BatchServiceError('Approval was refused for this item.', { status: 409, code: 'approval_refused' });
          }
          accepted.push({ id: item.id, scheduledAt: new Date(finalMs).toISOString() });
        } catch (error) {
          failed.push({ id: item.id, reason: error.message || 'Acceptance failed.' });
        }
      }
      // The slot is considered occupied once its group has been processed,
      // regardless of individual member failures, so later groups never
      // collide with a partially-accepted group's reserved time.
      previousMs = finalMs;
    }

    const derived = await refreshBatchRecord(context, batchId, scope);
    return { accepted, failed, skipped: [], batchStatus: derived.status };
  }

  // ── Deletion (Phase A: safe delete) ───────────────────────────────────────
  // Batch items ARE ordinary posts, so the canonical delete authority stays
  // storage.deletePost's own transaction (state gates, usage release,
  // Cloudinary reference-count cleanup) via applicationService.deletePost.
  // This layer adds only what that canonical delete does not already know:
  // batch membership, the approval lock — approving a draft never changes
  // its queue `status`, so the generic status gate alone would otherwise
  // allow deleting an approved/accepted item — and batch-record bookkeeping.

  function approvalLockError() {
    return new BatchServiceError(
      'This item is already approved. Revoke its approval before deleting it.',
      { status: 409, code: 'approval_locked' }
    );
  }

  async function deleteItem(context, batchId, postId) {
    const commercialContext = await resolveScope(context);
    const scope = commercialContext.workspaceScope;
    const record = await storage.getBatchRecord(context.userId, batchId, scope);
    if (!record) {
      throw new BatchServiceError('Batch not found for this workspace.', { status: 404, code: 'not_found' });
    }
    const post = await findBatchItem(context, batchId, postId, scope);
    if (post.approved) throw approvalLockError();

    const result = await applicationService.deletePost(context, { postId: post.id, accountId: post.accountId });
    if (!result.deleted) {
      throw new BatchServiceError('This item could not be deleted (it may already be gone).', {
        status: 404,
        code: 'not_found'
      });
    }

    await storage.incrementBatchDeletedCount(context.userId, batchId, 1, scope);
    const derived = await refreshBatchRecord(context, batchId, scope);
    return { deleted: true, postId: post.id, batchStatus: derived.status };
  }

  async function deleteBatch(context, batchId) {
    const commercialContext = await resolveScope(context);
    const scope = commercialContext.workspaceScope;
    const record = await storage.getBatchRecord(context.userId, batchId, scope);
    if (!record) {
      throw new BatchServiceError('Batch not found for this workspace.', { status: 404, code: 'not_found' });
    }
    const posts = await storage.getBatchPosts(context.userId, batchId, scope);

    const deleted = [];
    const blocked = [];
    const failed = [];
    for (const post of posts) {
      try {
        if (post.approved) throw approvalLockError();
        const result = await applicationService.deletePost(context, { postId: post.id, accountId: post.accountId });
        if (!result.deleted) {
          throw new BatchServiceError('Item was already gone.', { status: 404, code: 'not_found' });
        }
        deleted.push(post.id);
      } catch (error) {
        const code = error && error.code;
        const entry = { id: post.id, reason: (error && error.message) || 'Delete failed.' };
        if (code === 'approval_locked' || code === 'queue_transition_blocked') blocked.push(entry);
        else failed.push(entry);
      }
    }

    if (deleted.length > 0) {
      await storage.incrementBatchDeletedCount(context.userId, batchId, deleted.length, scope);
    }

    const remaining = await storage.getBatchPosts(context.userId, batchId, scope);
    let batchClosed = false;
    let batchStatus;
    if (remaining.length === 0 && blocked.length === 0 && failed.length === 0) {
      // Full cleanup: every child post is gone and nothing was skipped —
      // close the batch record itself so zero residue remains (spec: never
      // report full success while residue exists; close/delete only after
      // child-state reconciliation).
      batchClosed = await storage.deleteBatchRecord(context.userId, batchId, scope);
      batchStatus = 'deleted';
    } else {
      const derived = await refreshBatchRecord(context, batchId, scope);
      batchStatus = derived.status;
    }

    return { deleted, blocked, failed, batchClosed, batchStatus };
  }

  return {
    createBatch,
    getBatchView,
    listBatches,
    listDestinations,
    resumePreparation,
    startPreparation,
    updateItem,
    changeItemDestination,
    acceptItems,
    deleteItem,
    deleteBatch,
    // Exposed for tests: deterministic identity + derived views.
    deriveBatchId,
    itemView,
    deriveBatchStatus
  };
}

const defaultService = createBatchService();

module.exports = {
  BatchServiceError,
  createBatchService,
  deriveBatchId,
  MAX_DESTINATIONS,
  ...defaultService
};
