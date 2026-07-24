'use strict';

// CHANTER Platform customer surface: the unified shell plus the AutoPoster
// batch module (massive upload -> AI preparation -> human review -> staggered
// scheduling). Pages are Greek-first; every API returns JSON. All routes sit
// behind the same admin session and CSRF origin middleware as the classic
// console — this file adds no new authority, only a new surface over the
// existing application-service boundary.

const express = require('express');
const multer = require('multer');
const fs = require('fs/promises');
const path = require('path');
const { randomUUID } = require('crypto');
const config = require('./config');
const applicationService = require('./autoposterApplicationService');
const batchService = require('./batchService');
const { requireAdminApi, requireAdminPage, resolveUserId } = require('./auth');
const { isSupportedBatchUploadFile, BATCH_MEDIA_UPLOAD_MESSAGE } = require('./mediaPolicy');

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

// ── Pages (Greek-first, admin session) ─────────────────────────────────────

router.get('/platform', requireAdminPage, (req, res) => {
  res.render('platform', { appName: config.appName });
});

router.get('/platform/autoposter', requireAdminPage, asyncRoute(async (req, res) => {
  const context = websiteContext(req);
  let destinations = [];
  let accountsError = '';
  try {
    const resolved = await batchService.listDestinations(context);
    // Intake only offers destinations ready to receive a fan-out draft right
    // now, AND excludes YouTube (requires a human-entered per-item title
    // that cannot exist yet at bulk intake — add it per item during review
    // instead). Review's existing destination selector deliberately still
    // shows every connected account (unchanged from V1.1).
    destinations = resolved.destinations.filter(
      (destination) => destination.publishingReady && destination.provider !== 'youtube'
    );
  } catch (error) {
    accountsError = error.message || 'Connected channels are unavailable right now.';
  }
  res.render('platform-autoposter', {
    appName: config.appName,
    destinations,
    accountsError,
    batchDefaults: {
      staggerMinutes: config.batchIntake.staggerDefaultMinutes,
      staggerMin: config.batchIntake.staggerMinMinutes,
      staggerMax: config.batchIntake.staggerMaxMinutes,
      maxItems: config.batchIntake.maxItems,
      maxDestinations: batchService.MAX_DESTINATIONS
    }
  });
}));

router.get('/platform/autoposter/batches/:batchId', requireAdminPage, (req, res) => {
  res.render('platform-batch', {
    appName: config.appName,
    batchId: String(req.params.batchId || '').trim(),
    safetyBufferMinutes: config.batchIntake.safetyBufferMinutes
  });
});

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
      scheduleMode: req.body.scheduleMode,
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
