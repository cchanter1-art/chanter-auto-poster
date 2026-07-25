'use strict';

// CHANTER Platform customer surface: the unified shell (Overview, Modules,
// Work, Approvals, Evidence, System health) with AutoPoster mounted as its
// first module (massive upload -> AI preparation -> human review -> staggered
// scheduling). Pages are Greek-first; every API returns JSON. All routes sit
// behind the same admin session and CSRF origin middleware as the classic
// console — this file adds no new authority, only a new surface over the
// existing application-service boundary.
//
// The shell surfaces are strictly read-only projections. Every state-changing
// action still belongs to the module that owns it (AutoPoster acceptance stays
// on the batch review page), and internal operations — repository control,
// commit preparation, push, deployment, worker administration — are not
// reachable from here at all; they live behind the Operator boundary.

const express = require('express');
const multer = require('multer');
const fs = require('fs/promises');
const path = require('path');
const { randomUUID } = require('crypto');
const config = require('./config');
const applicationService = require('./autoposterApplicationService');
const batchService = require('./batchService');
const platformModules = require('./platformModules');
const platformStatus = require('./platformStatus');
const platformWorkProviders = require('./platformWorkProviders');
const { createAutoPosterWorkProvider } = require('./platformAutoPosterProvider');
const { createRecurringSeriesWorkProvider } = require('./platformSeriesProvider');
const { createOperatorWorkProvider } = require('./platformOperatorProvider');
const { readConnectedHealth } = require('./runtimeConnectedHealth');
const providers = require('./providers');
const autoMusic = require('./autoMusic');
const autoCaption = require('./autoCaption');
const maxScheduler = require('./maxScheduler');
const { groupDestinationsByProvider, countSelectableAccounts } = require('./destinationChips');
const { requireAdminApi, requireAdminPage, resolveUserId } = require('./auth');
const { isSupportedBatchUploadFile, BATCH_MEDIA_UPLOAD_MESSAGE } = require('./mediaPolicy');

// Every connected, publishing-ready provider is selectable in the canonical
// composer. YouTube used to be shown grouped-but-disabled because it needs a
// human-entered per-video title that bulk intake had no way to collect; the
// composer's Caption step now collects it, so the reason no longer holds.
// The substance of the rule is unchanged and still enforced server-side by
// batchService.createBatch: a YouTube destination without a typed title is
// refused, and one title may not describe several videos.
function isIntakeSelectableProvider() {
  return true;
}
const INTAKE_UNAVAILABLE_REASON = '';

const router = express.Router();

// Batch intake accepts video AND image sources (opt-in image media lives only
// on this path). The stored-filename extension must reflect the real media
// type: an image saved with a fabricated .mp4 name would be misclassified as a
// video by the provider's filename fallback (tiktok.isVideoPost).
function batchUploadExtension(file) {
  const explicit = path.extname(file.originalname || '').toLowerCase();
  if (explicit) return explicit;
  const mime = String(file.mimetype || '').toLowerCase();
  if (mime === 'image/jpeg') return '.jpg';
  if (mime === 'image/png') return '.png';
  if (mime === 'image/webp') return '.webp';
  if (mime === 'video/quicktime') return '.mov';
  if (mime === 'video/webm') return '.webm';
  return mime.startsWith('image/') ? '.jpg' : '.mp4';
}

const batchUpload = multer({
  storage: multer.diskStorage({
    destination: config.uploadsDir,
    filename: (req, file, callback) => {
      callback(null, `batch-${Date.now()}-${randomUUID()}${batchUploadExtension(file)}`);
    }
  }),
  fileFilter: (req, file, callback) => {
    if (isSupportedBatchUploadFile(file)) { callback(null, true); return; }
    const error = new Error(BATCH_MEDIA_UPLOAD_MESSAGE);
    error.status = 400;
    callback(error);
  },
  limits: { files: config.batchIntake.maxItems, fileSize: 250 * 1024 * 1024 }
});

function asyncRoute(handler) {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}

function websiteContext(req, options = {}) {
  const userId = resolveUserId(req);
  return applicationService.createExecutionContext({
    userId,
    actorId: options.actorId || `admin:${userId}`,
    accountId: options.accountId || '',
    source: 'website',
    workspaceId: String(req.get('x-chanter-workspace-id') || req.query.workspaceId || '').trim(),
    correlationId: req.get('x-request-id') || '',
    approval: options.approval || null,
    idempotency: { key: options.idempotencyKey || '' }
  });
}

function approverContext(req) {
  const userId = resolveUserId(req);
  return websiteContext(req, { approval: { approvedBy: `admin:${userId}` } });
}

// Multipart intake carries array/object fields (destinations, dailySlots) as
// JSON-encoded strings. Anything malformed collapses to an empty array —
// batchService's own validation produces the actual user-facing error.
function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Auto Music tokens staged by POST /api/auto-caption, resolved back into the
// prepared derivatives storage already knows how to match to their own source
// file. Identical trust model to the classic intake path: an invalid, expired
// or mismatched token is never fatal — it is dropped with a warning and the
// ORIGINAL upload is used, so music can never silently substitute the wrong
// media. Verification is per file, so one token can only ever claim one source.
function resolvePreparedMediaList(tokens, userId, files) {
  const staged = [];
  for (const token of Array.isArray(tokens) ? tokens : []) {
    if (!String(token || '').trim()) continue;
    let matched = null;
    for (const file of files) {
      try {
        const prepared = autoMusic.verifyPreparedMediaToken(token, { userId, file });
        if (prepared) { matched = prepared; break; }
      } catch (error) {
        console.warn('[auto-music] prepared media verification failed; using original upload', {
          code: (error && error.code) || 'PREPARED_MEDIA_INVALID'
        });
        matched = null;
        break;
      }
    }
    if (matched) staged.push(matched);
    else console.warn('[auto-music] prepared media token was invalid or expired; using original upload');
  }
  return staged;
}

async function removeTemporaryUploads(files) {
  for (const file of Array.isArray(files) ? files : []) {
    if (file && file.path) await fs.unlink(file.path).catch(() => {});
  }
}

function sendServiceError(res, error) {
  if (error && (error.name === 'BatchServiceError' || error.name === 'AutoPosterApplicationError')) {
    res.status(error.status || 400).json({
      ok: false,
      code: error.code || 'validation_failed',
      reason: error.message,
      details: error.details || {}
    });
    return true;
  }
  return false;
}

// ── Shell projections (read-only) ──────────────────────────────────────────

// The Platform's work providers. The shell iterates this registry; it does not
// know which modules produced what, so a new module reaches Work / Approvals /
// Evidence by registering here and nothing on those surfaces changes.
//
// Operator registers only when OPERATOR_BASE_URL is configured. Unconfigured is
// not an outage, so no provider is registered and nothing is claimed.
const workRegistry = platformWorkProviders.createWorkRegistry();
workRegistry.register(createAutoPosterWorkProvider());
// Recurring series occurrences are Release Queue jobs, so they register under
// the module that owns that surface rather than under AutoPoster.
workRegistry.register(createRecurringSeriesWorkProvider());
const operatorWorkProvider = createOperatorWorkProvider(config.operatorWork);
if (operatorWorkProvider) workRegistry.register(operatorWorkProvider);

// Every shell surface degrades to a partial or empty projection plus a visible
// reason instead of a 500: an unreachable module must not make the Platform
// itself look broken, and it must never look healthy either. A module that
// fails is named; the modules that answered are still reported.
async function loadPlatformWork(req) {
  try {
    const collected = await workRegistry.collect(websiteContext(req));
    return {
      items: collected.items,
      summary: collected.summary,
      degraded: collected.degraded,
      error: collected.error
    };
  } catch (error) {
    // The registry isolates provider failures itself, so reaching here means
    // the aggregation layer could not run at all.
    return {
      items: [],
      summary: platformStatus.summarizeWork([]),
      degraded: [],
      error: (error && error.message) || 'Work is unavailable right now.'
    };
  }
}

// Reuses the same bounded, read-only storage probe the Agent Runtime control
// surface uses (src/runtimeConnectedHealth.js) — one cheap read, never a write,
// never a provider call. Required lazily to match runtimeControlRoutes and keep
// boot order independent of Firebase configuration.
async function loadPlatformHealth() {
  const firestoreModule = require('./firestore');
  let configured = false;
  try {
    firestoreModule.validateFirebaseConfig();
    configured = true;
  } catch {
    configured = false;
  }
  const health = await readConnectedHealth({
    getFirestore: firestoreModule.getFirestore,
    configured,
    emulatorHost: process.env.FIRESTORE_EMULATOR_HOST || '',
    timeoutMs: 2500
  });
  return {
    ok: Boolean(health && health.ok),
    storage: (health && health.storage) || { provider: 'firestore', mode: 'unknown', reachable: null },
    observedAt: (health && health.observedAt) || new Date().toISOString()
  };
}

// ── Pages (Greek-first, admin session) ─────────────────────────────────────

router.get('/platform', requireAdminPage, asyncRoute(async (req, res) => {
  const work = await loadPlatformWork(req);
  res.render('platform', {
    appName: config.appName,
    active: 'overview',
    customerModules: platformModules.listCustomerModules(),
    internalModuleCount: platformModules.listInternalModules().length,
    workSummary: work.summary,
    workError: work.error,
    workDegraded: work.degraded
  });
}));

router.get('/platform/modules', requireAdminPage, (req, res) => {
  res.render('platform-modules', {
    appName: config.appName,
    active: 'modules',
    customerModules: platformModules.listCustomerModules(),
    internalModules: platformModules.listInternalModules()
  });
});

router.get('/platform/work', requireAdminPage, asyncRoute(async (req, res) => {
  const work = await loadPlatformWork(req);
  res.render('platform-work', {
    appName: config.appName,
    active: 'work',
    platformStatus,
    items: work.items,
    workSummary: work.summary,
    workError: work.error,
    workDegraded: work.degraded,
    firstCustomerModule: platformModules.listCustomerModules()[0] || null
  });
}));

router.get('/platform/approvals', requireAdminPage, asyncRoute(async (req, res) => {
  const work = await loadPlatformWork(req);
  res.render('platform-approvals', {
    appName: config.appName,
    active: 'approvals',
    platformStatus,
    items: work.items.filter((item) => item.needsApproval),
    workError: work.error,
    workDegraded: work.degraded
  });
}));

router.get('/platform/evidence', requireAdminPage, asyncRoute(async (req, res) => {
  const work = await loadPlatformWork(req);
  res.render('platform-evidence', {
    appName: config.appName,
    active: 'evidence',
    platformStatus,
    // Only work that actually carries a durable record is indexable here.
    items: work.items.filter((item) => item.evidenceAvailable),
    workError: work.error,
    workDegraded: work.degraded
  });
}));

router.get('/platform/health', requireAdminPage, asyncRoute(async (req, res) => {
  const [work, health] = await Promise.all([loadPlatformWork(req), loadPlatformHealth()]);
  res.render('platform-health', {
    appName: config.appName,
    active: 'health',
    health,
    workSummary: work.summary,
    workError: work.error,
    workDegraded: work.degraded,
    workProviderCount: workRegistry.list().length,
    customerModuleCount: platformModules.listCustomerModules().length,
    internalModuleCount: platformModules.listInternalModules().length
  });
}));

// The one canonical customer posting surface: Upload -> Accounts -> Caption ->
// Schedule -> Review -> Accept. One account and many accounts are the same
// page, the same submission path and the same validation — the number of
// selected destinations is the only difference between them. What a package
// changes is which capabilities inside this page are usable, never which page,
// route, or product the customer receives.
router.get('/platform/compose', requireAdminPage, asyncRoute(async (req, res) => {
  const context = websiteContext(req);
  let destinationGroups = [];
  let selectableCount = 0;
  let accountsError = '';
  try {
    const resolved = await batchService.listDestinations(context);
    // Every connected, publishing-ready account is grouped by provider and
    // rendered as a clickable chip. Selectability (not visibility) encodes the
    // intake rule: YouTube is shown grouped-but-disabled because it needs a
    // human-entered per-item title that cannot exist yet at bulk intake — it
    // stays reachable per item during review (unchanged from V1.1). The
    // empty-state gate below keys off selectable accounts, so the form still
    // only appears when there is at least one account to fan out to.
    const publishingReady = resolved.destinations.filter((destination) => destination.publishingReady);
    destinationGroups = groupDestinationsByProvider(publishingReady, {
      isSelectable: isIntakeSelectableProvider,
      unavailableReason: () => INTAKE_UNAVAILABLE_REASON
    });
    selectableCount = countSelectableAccounts(destinationGroups);
  } catch (error) {
    accountsError = error.message || 'Connected channels are unavailable right now.';
  }
  // Resolved through the same seam the write path enforces with, so the page
  // can never offer a capability the API would refuse.
  const capabilities = await batchService.getComposerCapabilities(context);
  res.render('platform-compose', {
    appName: config.appName,
    active: 'compose',
    destinationGroups,
    selectableCount,
    accountsError,
    capabilities,
    // Honest availability, not a promise: each control renders inert when its
    // service is unconfigured rather than failing at submit time.
    autoCaptionConfigured: autoCaption.hasConfiguredCaptionProvider(),
    autoMusicConfigured: autoMusic.isAutoMusicConfigured(),
    composeDefaults: {
      maxItems: capabilities.maxItemsPerDraft,
      safetyBufferMinutes: config.batchIntake.safetyBufferMinutes,
      // Real recurrence bounds from the engine that enforces them, so the
      // preview cannot promise a series the server would refuse.
      maxDailyOccurrences: maxScheduler.MAX_DAILY_OCCURRENCES,
      maxRecurringJobs: maxScheduler.MAX_RECURRING_JOBS,
      schedulingHorizonDays: capabilities.schedulingHorizonDays
    }
  });
}));

// Review + Accept: steps 5 and 6 of the same canonical flow. The human
// approval gate lives here, on the durable record, exactly as before.
router.get('/platform/compose/:batchId', requireAdminPage, (req, res) => {
  res.render('platform-batch', {
    appName: config.appName,
    active: 'compose',
    batchId: String(req.params.batchId || '').trim(),
    safetyBufferMinutes: config.batchIntake.safetyBufferMinutes
  });
});

// ── Legacy compatibility ───────────────────────────────────────────────────
// The former bulk-only module route and its review path. Thin redirects, no
// second implementation, absent from the primary navigation. Saved links keep
// working and land on the canonical composer instead of a dead end.
router.get('/platform/autoposter', requireAdminPage, (req, res) => {
  res.redirect(302, '/platform/compose');
});

router.get('/platform/autoposter/batches/:batchId', requireAdminPage, (req, res) => {
  res.redirect(302, `/platform/compose/${encodeURIComponent(String(req.params.batchId || '').trim())}`);
});

// ── Shell APIs (admin session, JSON, read-only) ────────────────────────────

router.get('/api/platform/modules', requireAdminApi, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, modules: platformModules.listModules() });
});

router.get('/api/platform/work', requireAdminApi, asyncRoute(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const work = await loadPlatformWork(req);
  res.json({
    ok: !work.error,
    items: work.items,
    summary: work.summary,
    // Which modules answered and which could not, so an API consumer can tell a
    // partial read from a whole one without inspecting the item list.
    providers: workRegistry.list(),
    degraded: work.degraded,
    reason: work.error
  });
}));

router.get('/api/platform/health', requireAdminApi, asyncRoute(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const health = await loadPlatformHealth();
  res.json({
    ok: health.ok,
    storage: health.storage,
    // Fixed platform guarantee, not a runtime reading: nothing on this surface
    // can publish, and acceptance always requires a human on the module page.
    publishing: { humanApprovalRequired: true },
    modules: {
      customer: platformModules.listCustomerModules().length,
      internal: platformModules.listInternalModules().length
    },
    observedAt: health.observedAt
  });
}));

// ── Batch APIs (admin session, JSON) ───────────────────────────────────────

function uploadBatchMedia(req, res, next) {
  batchUpload.array('videos')(req, res, (error) => {
    if (error) {
      res.status(error.status || 400).json({ ok: false, code: 'upload_rejected', reason: error.message || 'Upload failed.' });
      return;
    }
    next();
  });
}

router.post('/api/platform/batches', requireAdminApi, uploadBatchMedia, asyncRoute(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const files = req.files || [];
  try {
    const result = await batchService.createBatch(websiteContext(req), {
      files,
      destinations: parseJsonArray(req.body.destinations),
      // One main caption and hashtag set, inherited by every selected
      // destination. Left blank, per-item AI preparation fills them in as
      // before — this only stops the composer's caption step from being
      // discarded on the way to the service that already accepted it.
      caption: req.body.caption,
      hashtags: req.body.hashtags,
      // Already-hosted media as an alternative to uploading; the service
      // refuses both sources at once and validateMedia keeps URLs video-only.
      mediaUrl: req.body.publicMediaUrl,
      // Auto Music derivatives staged before submit.
      preparedMedia: resolvePreparedMediaList(
        parseJsonArray(req.body.autoMusicTokens),
        resolveUserId(req),
        files
      ),
      // Provider metadata, collected contextually by the composer.
      youtube: {
        title: req.body.youtubeTitle,
        description: req.body.youtubeDescription
      },
      scheduleMode: req.body.scheduleMode,
      // Recurring series: one source set repeated across a bounded run of days.
      // The service delegates the expansion to the existing recurring engine.
      endDate: req.body.endDate,
      approveSeries: String(req.body.approveSeries || '') === '1',
      startDate: req.body.startDate,
      startTime: req.body.startTime,
      timezoneName: req.body.timezoneName,
      timezoneOffsetMinutes: req.body.timezoneOffsetMinutes,
      staggerMinutes: req.body.staggerMinutes,
      firstDay: req.body.firstDay,
      lastDay: req.body.lastDay,
      postsPerDay: req.body.postsPerDay,
      dailyStartTime: req.body.dailyStartTime,
      dailyEndTime: req.body.dailyEndTime,
      intraDayIntervalMinutes: req.body.intraDayIntervalMinutes,
      dailySlots: parseJsonArray(req.body.dailySlots),
      intakeKey: req.body.intakeKey
    });
    if (result.replayed) await removeTemporaryUploads(files);
    res.status(result.replayed ? 200 : 201).json({ ok: true, ...result });
  } catch (error) {
    await removeTemporaryUploads(files);
    if (!sendServiceError(res, error)) throw error;
  }
}));

router.get('/api/platform/destinations', requireAdminApi, asyncRoute(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const result = await batchService.listDestinations(websiteContext(req));
    res.json({ ok: true, ...result });
  } catch (error) {
    if (!sendServiceError(res, error)) throw error;
  }
}));

router.get('/api/platform/batches', requireAdminApi, asyncRoute(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const result = await batchService.listBatches(websiteContext(req));
    res.json({ ok: true, ...result });
  } catch (error) {
    if (!sendServiceError(res, error)) throw error;
  }
}));

router.get('/api/platform/batches/:batchId', requireAdminApi, asyncRoute(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const result = await batchService.getBatchView(websiteContext(req), req.params.batchId);
    res.json({ ok: true, ...result });
  } catch (error) {
    if (!sendServiceError(res, error)) throw error;
  }
}));

router.post('/api/platform/batches/:batchId/prepare', requireAdminApi, asyncRoute(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const result = await batchService.resumePreparation(websiteContext(req), req.params.batchId);
    res.json({ ok: true, resumed: true, ...result });
  } catch (error) {
    if (!sendServiceError(res, error)) throw error;
  }
}));

router.patch(
  '/api/platform/batches/:batchId/items/:postId',
  requireAdminApi,
  express.json({ limit: '64kb' }),
  asyncRoute(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const result = await batchService.updateItem(
        websiteContext(req),
        req.params.batchId,
        req.params.postId,
        {
          caption: req.body.caption,
          hashtags: req.body.hashtags,
          scheduleInput: req.body.scheduleInput,
          privacyLevel: req.body.privacyLevel,
          youtubeTitle: req.body.youtubeTitle,
          youtubeDescription: req.body.youtubeDescription
        }
      );
      res.json({ ok: true, ...result });
    } catch (error) {
      if (!sendServiceError(res, error)) throw error;
    }
  })
);

router.post(
  '/api/platform/batches/:batchId/items/:postId/destination',
  requireAdminApi,
  express.json({ limit: '32kb' }),
  asyncRoute(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const result = await batchService.changeItemDestination(
        websiteContext(req),
        req.params.batchId,
        req.params.postId,
        {
          provider: req.body.provider,
          accountId: req.body.accountId,
          youtubeTitle: req.body.youtubeTitle,
          youtubeDescription: req.body.youtubeDescription
        }
      );
      res.json({ ok: true, ...result });
    } catch (error) {
      if (!sendServiceError(res, error)) throw error;
    }
  })
);

router.post(
  '/api/platform/batches/:batchId/items/:postId/accept',
  requireAdminApi,
  express.json({ limit: '16kb' }),
  asyncRoute(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const result = await batchService.acceptItems(approverContext(req), req.params.batchId, {
        postIds: [req.params.postId]
      });
      res.json({ ok: result.failed.length === 0, ...result });
    } catch (error) {
      if (!sendServiceError(res, error)) throw error;
    }
  })
);

router.post(
  '/api/platform/batches/:batchId/accept-all',
  requireAdminApi,
  express.json({ limit: '16kb' }),
  asyncRoute(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const result = await batchService.acceptItems(approverContext(req), req.params.batchId, {
        postIds: 'all'
      });
      res.json({ ok: result.failed.length === 0, ...result });
    } catch (error) {
      if (!sendServiceError(res, error)) throw error;
    }
  })
);

// ── Deletion (Phase A: safe delete) ─────────────────────────────────────────

router.post(
  '/api/platform/batches/:batchId/items/:postId/delete',
  requireAdminApi,
  express.json({ limit: '16kb' }),
  asyncRoute(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const result = await batchService.deleteItem(websiteContext(req), req.params.batchId, req.params.postId);
      res.json({ ok: true, ...result });
    } catch (error) {
      if (!sendServiceError(res, error)) throw error;
    }
  })
);

router.post(
  '/api/platform/batches/:batchId/delete',
  requireAdminApi,
  express.json({ limit: '16kb' }),
  asyncRoute(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const result = await batchService.deleteBatch(websiteContext(req), req.params.batchId);
      res.json({ ok: result.blocked.length === 0 && result.failed.length === 0, ...result });
    } catch (error) {
      if (!sendServiceError(res, error)) throw error;
    }
  })
);

module.exports = router;
