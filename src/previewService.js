'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { createHash, createHmac, randomUUID, timingSafeEqual } = require('crypto');
const config = require('./config');
const musicRegistry = require('./musicRegistry');
const { renderImageMusicPreview, PREVIEW_DURATIONS } = require('./previewRenderer');

// ── Public API ───────────────────────────────────────────────────────────

async function createImageMusicPreview(request, options = {}) {
  requireTokenSecret();
  const {
    userId,
    imagePath,
    originalName,
    originalSize,
    durationSeconds,
    trackId,
    segmentStartSeconds,
    focalX,
    focalY
  } = request;

  // Resolve verified registered track by ID
  const track = await musicRegistry.getRegisteredTrackById(trackId, options);
  if (!track) {
    throw serviceError(`Track not found: ${trackId}`, 'TRACK_NOT_FOUND');
  }
  if (track.rightsStatus !== 'verified') {
    throw serviceError(`Track is not render-eligible (status: ${track.rightsStatus})`, 'TRACK_NOT_VERIFIED');
  }

  // Ensure preview and manifest directories exist
  const previewDir = options.previewDir || config.mediaPreview.previewDir;
  const manifestDir = options.manifestDir || config.mediaPreview.manifestDir;
  await fsp.mkdir(previewDir, { recursive: true });
  await fsp.mkdir(manifestDir, { recursive: true });

  const previewId = randomUUID();
  const previewFilename = `preview-${previewId}.mp4`;
  const manifestFilename = `preview-${previewId}.json`;
  const outputPath = path.join(previewDir, previewFilename);
  const manifestPath = path.join(manifestDir, manifestFilename);

  let render;
  try {
    render = await renderImageMusicPreview({
      imagePath,
      trackPath: track.absolutePath,
      durationSeconds,
      segmentStartSeconds,
      focalX,
      focalY,
      outputPath
    }, options);
  } catch (error) {
    // Cleanup partial artifacts on render failure
    await fsp.rm(outputPath, { force: true });
    await fsp.rm(manifestPath, { force: true });
    throw error;
  }

  // Build manifest
  const manifest = {
    version: 1,
    kind: 'image_music_preview',
    createdAt: new Date().toISOString(),
    sourceImage: {
      originalName: String(originalName || ''),
      originalSize: Number(originalSize || 0)
    },
    render: {
      width: render.width,
      height: render.height,
      frameRate: render.frameRate,
      durationSeconds: render.durationSeconds,
      focalX: render.focalX,
      focalY: render.focalY
    },
    music: {
      trackId: track.id,
      trackSha256: track.sha256,
      segmentStartSeconds: render.segmentStartSeconds,
      segmentDurationSeconds: render.durationSeconds,
      rightsStatus: track.rightsStatus,
      licenceEvidenceRef: track.licenceEvidenceRef || ''
    },
    output: {
      filename: previewFilename,
      size: render.size
    }
  };

  // Persist manifest — if this fails, clean up both artifacts
  try {
    const manifestContent = JSON.stringify(manifest, null, 2) + '\n';
    const tempManifest = `${manifestPath}.${randomUUID()}.tmp`;
    try {
      await fsp.writeFile(tempManifest, manifestContent, 'utf8');
      await fsp.rename(tempManifest, manifestPath);
    } catch (writeError) {
      await fsp.rm(tempManifest, { force: true });
      throw writeError;
    }
  } catch (manifestError) {
    await fsp.rm(outputPath, { force: true });
    await fsp.rm(manifestPath, { force: true });
    throw serviceError(
      `Manifest write failed: ${manifestError.message}`,
      'MANIFEST_WRITE_FAILED',
      manifestError
    );
  }

  // Compute manifest hash for token binding
  const manifestRaw = await fsp.readFile(manifestPath, 'utf8');
  const manifestSha256 = createHash('sha256').update(manifestRaw).digest('hex');

  // Issue preview token — if this fails, clean up both artifacts
  let token;
  try {
    token = createPreviewToken({
      userId: String(userId || ''),
      outputFilename: previewFilename,
      outputSize: render.size,
      manifestSha256,
      expiresAt: Date.now() + config.mediaPreview.tokenTtlMs
    });
  } catch (tokenError) {
    await fsp.rm(outputPath, { force: true });
    await fsp.rm(manifestPath, { force: true });
    throw tokenError;
  }

  return {
    previewId,
    token,
    manifest,
    render,
    previewUrl: `/uploads/previews/${previewFilename}`
  };
}

function createPreviewToken(payload) {
  requireTokenSecret();
  const body = Buffer.from(JSON.stringify({
    version: 1,
    kind: 'media_preview',
    userId: String(payload.userId || ''),
    outputFilename: String(payload.outputFilename || ''),
    outputSize: Number(payload.outputSize || 0),
    manifestSha256: String(payload.manifestSha256 || ''),
    expiresAt: Number(payload.expiresAt || 0)
  })).toString('base64url');
  return `${body}.${signToken(body)}`;
}

function verifyPreviewToken(token, { userId, outputFilename, outputSize } = {}) {
  if (!config.mediaPreview.tokenSecret) return null;
  const [body, signature, extra] = String(token || '').split('.');
  if (!body || !signature || extra) return null;

  const expected = Buffer.from(signToken(body));
  const supplied = Buffer.from(signature);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;

  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); }
  catch { return null; }

  if (
    payload.version !== 1 ||
    payload.kind !== 'media_preview' ||
    Number(payload.expiresAt || 0) <= Date.now() ||
    String(payload.userId || '') !== String(userId || '') ||
    String(payload.outputFilename || '') !== String(outputFilename || '') ||
    Number(payload.outputSize || 0) !== Number(outputSize || 0)
  ) return null;

  return {
    userId: payload.userId,
    outputFilename: payload.outputFilename,
    outputSize: payload.outputSize,
    manifestSha256: payload.manifestSha256
  };
}

async function cleanupExpiredPreviews(options = {}) {
  const previewDir = options.previewDir || config.mediaPreview.previewDir;
  const manifestDir = options.manifestDir || config.mediaPreview.manifestDir;
  const ttlMs = config.mediaPreview.tokenTtlMs;
  const cutoff = Date.now() - ttlMs;

  for (const dir of [previewDir, manifestDir]) {
    let entries = [];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
    catch { continue; }

    await Promise.all(entries
      .filter((e) => e.isFile() && /^preview-[0-9a-f-]+\.(mp4|json)$/i.test(e.name))
      .map(async (e) => {
        const filePath = path.join(dir, e.name);
        try {
          const stats = await fsp.stat(filePath);
          if (stats.mtimeMs < cutoff) await fsp.rm(filePath, { force: true });
        } catch { /* best-effort */ }
      }));
  }
}

// ── Internal ─────────────────────────────────────────────────────────────

function signToken(body) {
  return createHmac('sha256', config.mediaPreview.tokenSecret).update(body).digest('base64url');
}

function requireTokenSecret() {
  if (!config.mediaPreview.tokenSecret) {
    throw serviceError('Media preview token signing is not configured (MEDIA_PREVIEW_TOKEN_SECRET)', 'PREVIEW_NOT_CONFIGURED');
  }
}

function serviceError(message, code, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

module.exports = {
  createImageMusicPreview,
  createPreviewToken,
  verifyPreviewToken,
  cleanupExpiredPreviews,
  PREVIEW_DURATIONS
};
