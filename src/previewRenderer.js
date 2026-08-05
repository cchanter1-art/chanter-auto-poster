'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const config = require('./config');
const { resolveFfmpegPath, resolveFfprobePath } = require('./ffmpegPaths');
const { runProcess } = require('./autoCaption');

const PREVIEW_DURATIONS = Object.freeze([5, 10, 15]);
const TARGET_WIDTH = 1080;
const TARGET_HEIGHT = 1920;
const TARGET_FPS = 30;
const MAX_DURATION_DRIFT_SECONDS = 0.2;
const SUPPORTED_IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

function validatePreviewRequest(input) {
  const errors = [];

  if (!input || typeof input !== 'object') {
    return { valid: false, errors: ['Input must be an object'] };
  }

  if (!PREVIEW_DURATIONS.includes(input.durationSeconds)) {
    errors.push(`durationSeconds must be one of: ${PREVIEW_DURATIONS.join(', ')}`);
  }

  if (input.imagePath != null) {
    const ext = path.extname(String(input.imagePath)).toLowerCase();
    if (!SUPPORTED_IMAGE_EXTENSIONS.has(ext)) {
      errors.push(`Image must be JPG, JPEG, PNG, or WebP (got ${ext || 'none'})`);
    }
  } else {
    errors.push('imagePath is required');
  }

  if (input.trackPath == null) {
    errors.push('trackPath is required');
  }

  const focalX = Number(input.focalX);
  const focalY = Number(input.focalY);
  if (!Number.isFinite(focalX)) errors.push('focalX must be a finite number');
  if (!Number.isFinite(focalY)) errors.push('focalY must be a finite number');

  const segmentStart = Number(input.segmentStartSeconds);
  if (!Number.isFinite(segmentStart) || segmentStart < 0) {
    errors.push('segmentStartSeconds must be a finite non-negative number');
  }

  return { valid: errors.length === 0, errors };
}

async function renderImageMusicPreview(params, options = {}) {
  const {
    imagePath,
    trackPath,
    durationSeconds,
    segmentStartSeconds,
    focalX: rawFocalX,
    focalY: rawFocalY,
    outputPath
  } = params;

  // ── Validate ──────────────────────────────────────────────────────────
  const validation = validatePreviewRequest(params);
  if (!validation.valid) {
    throw previewError(`Invalid preview request: ${validation.errors.join('; ')}`, 'INVALID_PREVIEW_REQUEST');
  }

  // Clamp focal values
  const focalX = clamp01(rawFocalX);
  const focalY = clamp01(rawFocalY);

  // Verify source files exist
  for (const [label, filePath] of [['Image', imagePath], ['Track', trackPath]]) {
    const stat = await fsp.stat(filePath).catch(() => null);
    if (!stat || !stat.isFile()) {
      throw previewError(`${label} file does not exist: ${filePath}`, 'SOURCE_FILE_MISSING');
    }
  }

  // Verify output path safety
  const resolvedOutput = path.resolve(outputPath);
  const resolvedImage = path.resolve(imagePath);
  const resolvedTrack = path.resolve(trackPath);
  if (resolvedOutput === resolvedImage || resolvedOutput === resolvedTrack) {
    throw previewError('Output path must not overwrite a source file', 'OUTPUT_PATH_UNSAFE');
  }

  const previewDir = path.resolve(config.mediaPreview.previewDir);
  const relativeToPreviewDir = path.relative(previewDir, resolvedOutput);
  if (!relativeToPreviewDir || relativeToPreviewDir.startsWith('..') || path.isAbsolute(relativeToPreviewDir)) {
    throw previewError('Output must be inside the preview directory', 'OUTPUT_PATH_UNSAFE');
  }

  // Verify segment fits within track
  const segStart = Number(segmentStartSeconds);
  const trackDuration = await probeAudioDuration(trackPath, options);
  const segEnd = segStart + durationSeconds;
  if (segEnd > trackDuration + 0.05) {
    throw previewError(
      `Segment ${segStart}–${segEnd}s exceeds track duration ${trackDuration}s`,
      'SEGMENT_OVERFLOW'
    );
  }

  // ── Build FFmpeg command ──────────────────────────────────────────────
  const fadeSeconds = Math.min(
    config.mediaPreview.fadeSeconds,
    Math.max(0.01, durationSeconds / 4)
  );
  const fadeOutStart = Math.max(0, durationSeconds - fadeSeconds);
  const durationText = durationSeconds.toFixed(3);

  // Focal-point crop: compute crop window centered on the focal point, clamped
  // crop=1080:1920:x:y where:
  //   x = clamp(iw * focalX - ow/2, 0, iw - ow)
  //   y = clamp(ih * focalY - oh/2, 0, ih - oh)
  const cropX = `min(max(iw*${focalX.toFixed(4)}-${TARGET_WIDTH}/2\\,0)\\,iw-${TARGET_WIDTH})`;
  const cropY = `min(max(ih*${focalY.toFixed(4)}-${TARGET_HEIGHT}/2\\,0)\\,ih-${TARGET_HEIGHT})`;

  const videoFilter = [
    `scale=${TARGET_WIDTH}:${TARGET_HEIGHT}:force_original_aspect_ratio=increase`,
    `crop=${TARGET_WIDTH}:${TARGET_HEIGHT}:${cropX}:${cropY}`,
    'setsar=1',
    `fps=${TARGET_FPS}`,
    'format=yuv420p'
  ].join(',');

  const audioFilter = [
    `atrim=start=${segStart.toFixed(3)}:end=${segEnd.toFixed(3)}`,
    'asetpts=N/SR/TB',
    `afade=t=in:st=0:d=${fadeSeconds.toFixed(3)}`,
    `afade=t=out:st=${fadeOutStart.toFixed(3)}:d=${fadeSeconds.toFixed(3)}`,
    'alimiter=limit=0.95'
  ].join(',');

  const runCommand = options.runCommand || runProcess;
  const ffmpegPath = options.ffmpegPath || resolveFfmpegPath();

  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-loop', '1', '-framerate', String(TARGET_FPS), '-i', imagePath,
    '-i', trackPath,
    '-vf', videoFilter,
    '-af', audioFilter,
    '-t', durationText,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart',
    '-map_metadata', '-1',
    '-shortest',
    '-y', outputPath
  ];

  // ── Render ────────────────────────────────────────────────────────────
  await fsp.mkdir(path.dirname(outputPath), { recursive: true });
  try {
    await runCommand(ffmpegPath, args, {
      timeoutMs: options.timeoutMs || config.mediaPreview.renderTimeoutMs
    });

    const stats = await fsp.stat(outputPath);
    if (!stats.isFile() || stats.size === 0) {
      throw previewError('FFmpeg did not create a usable preview video', 'PREVIEW_RENDER_FAILED');
    }

    // Verify output dimensions, codec, and duration
    const probeResult = await probeVideoOutput(outputPath, options);
    const durationDiff = Math.abs(probeResult.durationSeconds - durationSeconds);
    if (durationDiff >= MAX_DURATION_DRIFT_SECONDS) {
      throw previewError(
        `Preview duration drifted by ${durationDiff.toFixed(3)}s (max ${MAX_DURATION_DRIFT_SECONDS}s)`,
        'PREVIEW_DURATION_MISMATCH'
      );
    }

    return {
      outputPath,
      size: stats.size,
      width: TARGET_WIDTH,
      height: TARGET_HEIGHT,
      frameRate: TARGET_FPS,
      durationSeconds,
      renderedDurationSeconds: probeResult.durationSeconds,
      durationDiffSeconds: Number(durationDiff.toFixed(3)),
      segmentStartSeconds: segStart,
      focalX,
      focalY
    };
  } catch (error) {
    await fsp.rm(outputPath, { force: true });
    if (error.code && error.code.startsWith('PREVIEW_')) throw error;
    throw previewError(
      `Preview render failed: ${error.message}`,
      'PREVIEW_RENDER_FAILED',
      error
    );
  }
}

// ── Internal helpers ─────────────────────────────────────────────────────

async function probeAudioDuration(filePath, options = {}) {
  const runCommand = options.runCommand || runProcess;
  const result = await runCommand(
    options.ffprobePath || resolveFfprobePath(),
    [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath
    ],
    { timeoutMs: options.timeoutMs || 30_000 }
  );
  const duration = Number(String(result.stdout || '').trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw previewError('Could not determine audio duration', 'AUDIO_PROBE_FAILED');
  }
  return Number(duration.toFixed(3));
}

async function probeVideoOutput(filePath, options = {}) {
  const runCommand = options.runCommand || runProcess;
  const result = await runCommand(
    options.ffprobePath || resolveFfprobePath(),
    [
      '-v', 'error',
      '-show_streams', '-show_format',
      '-of', 'json',
      filePath
    ],
    { timeoutMs: options.timeoutMs || 30_000 }
  );

  let probe;
  try { probe = JSON.parse(result.stdout); }
  catch (error) {
    throw previewError('FFprobe returned invalid metadata', 'PREVIEW_PROBE_FAILED', error);
  }

  const streams = Array.isArray(probe.streams) ? probe.streams : [];
  const video = streams.find((s) => s.codec_type === 'video');
  if (!video) throw previewError('No video stream in output', 'PREVIEW_PROBE_FAILED');

  const duration = Number(video.duration)
    || Number(probe.format && probe.format.duration)
    || 0;

  return {
    durationSeconds: Number(duration.toFixed(3)),
    width: Number(video.width),
    height: Number(video.height),
    codecName: video.codec_name
  };
}

function clamp01(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5;
}

function previewError(message, code, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

module.exports = {
  PREVIEW_DURATIONS,
  validatePreviewRequest,
  renderImageMusicPreview
};
