'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { createHmac, randomUUID, timingSafeEqual } = require('crypto');
const bundledFfprobePath = require('ffprobe-static').path;
const config = require('./config');
const { runProcess } = require('./autoCaption');

const REQUIRED_TRACK_FIELDS = ['id', 'filename', 'category', 'mood', 'bpm', 'intensity', 'tags'];
const MAX_DURATION_DRIFT_SECONDS = 0.2;
const MUSIC_CATEGORIES = new Set([
  'anime-epic',
  'cyberpunk-dark',
  'motivation-calm',
  'emotional-orchestral',
  'aggressive-trap'
]);

async function loadMusicCatalog(options = {}) {
  const catalogPath = options.catalogPath || config.autoMusic.catalogPath;
  let parsed;
  try {
    parsed = JSON.parse(await fsp.readFile(catalogPath, 'utf8'));
  } catch (error) {
    throw autoMusicError(`Could not load music catalog: ${error.message}`, 'MUSIC_CATALOG_UNAVAILABLE', error);
  }

  const entries = Array.isArray(parsed) ? parsed : parsed.tracks;
  if (!Array.isArray(entries)) {
    throw autoMusicError('musicCatalog.json must contain an array of tracks', 'INVALID_MUSIC_CATALOG');
  }

  const ids = new Set();
  const tracks = [];
  for (const entry of entries) {
    const missing = REQUIRED_TRACK_FIELDS.filter((field) => entry == null || entry[field] == null);
    if (missing.length > 0) {
      throw autoMusicError(`Music catalog entry is missing: ${missing.join(', ')}`, 'INVALID_MUSIC_CATALOG');
    }
    const id = String(entry.id).trim();
    if (!id || ids.has(id)) throw autoMusicError(`Music catalog id is invalid or duplicated: ${id}`, 'INVALID_MUSIC_CATALOG');
    ids.add(id);

    const absolutePath = safeLibraryPath(entry.filename, options.libraryDir || config.autoMusic.libraryDir);
    if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
      console.warn('[auto-music] catalog track is unavailable', { id, filename: entry.filename });
      continue;
    }
    const category = String(entry.category).trim().toLowerCase();
    const bpm = Number(entry.bpm);
    const intensity = Number(entry.intensity);
    const tags = normalizeTags(entry.tags);
    if (
      !MUSIC_CATEGORIES.has(category) ||
      !Number.isFinite(bpm) || bpm <= 0 ||
      !Number.isFinite(intensity) || intensity < 0 || intensity > 1 ||
      tags.length === 0
    ) {
      throw autoMusicError(`Music catalog entry has invalid category, bpm, intensity, or tags: ${id}`, 'INVALID_MUSIC_CATALOG');
    }
    tracks.push({
      id,
      filename: String(entry.filename),
      category,
      mood: String(entry.mood).trim().toLowerCase(),
      bpm,
      intensity,
      tags,
      absolutePath
    });
  }

  if (tracks.length === 0) {
    throw autoMusicError('No usable tracks were found in the local music catalog', 'MUSIC_LIBRARY_EMPTY');
  }
  return tracks;
}

function selectMusicTrack(analysis = {}, catalog = []) {
  if (!Array.isArray(catalog) || catalog.length === 0) {
    throw autoMusicError('No music tracks are available for selection', 'MUSIC_LIBRARY_EMPTY');
  }

  const requestedCategory = String(analysis.musicCategory || '').toLowerCase();
  const requestedMood = normalizeTags([
    analysis.musicMood,
    ...(Array.isArray(analysis.musicTags) ? analysis.musicTags : [])
  ]);
  const requestedIntensity = clamp01(analysis.musicIntensity);
  const targetBpm = 70 + requestedIntensity * 100;

  const ranked = catalog.map((track) => {
    let score = track.category === requestedCategory ? 100 : 0;
    const searchable = new Set([track.mood, ...track.tags]);
    for (const term of requestedMood) {
      if ([...searchable].some((value) => value.includes(term) || term.includes(value))) score += 12;
    }
    score += Math.max(0, 25 - Math.abs(track.intensity - requestedIntensity) * 25);
    score += Math.max(0, 10 - Math.abs(track.bpm - targetBpm) / 10);
    return { track, score };
  });

  ranked.sort((a, b) => b.score - a.score || a.track.id.localeCompare(b.track.id));
  return ranked[0].track;
}

async function mixBackgroundMusic(videoPath, trackPath, outputPath, metadata = {}, options = {}) {
  const sourceMetadata = await probeSourceVideoForMusic(videoPath, options);
  const duration = Number(sourceMetadata.durationSeconds || 0);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw autoMusicError('Video duration is required for music mixing', 'INVALID_VIDEO_DURATION');
  }

  const fadeSeconds = Math.min(config.autoMusic.fadeSeconds, Math.max(0.01, duration / 4));
  const fadeOutStart = Math.max(0, duration - fadeSeconds);
  const durationText = duration.toFixed(3);
  const hasOriginalAudio = Boolean(sourceMetadata.hasAudio);
  const musicVolume = hasOriginalAudio ? config.autoMusic.backgroundVolume : 1;
  const filter = hasOriginalAudio
    ? [
        `[0:a:0]volume=1.0,atrim=start=0:end=${durationText},apad=whole_dur=${durationText},atrim=start=0:end=${durationText},asetpts=N/SR/TB[original]`,
        `[1:a:0]volume=${musicVolume.toFixed(3)},atrim=start=0:end=${durationText},asetpts=N/SR/TB,afade=t=in:st=0:d=${fadeSeconds.toFixed(3)},afade=t=out:st=${fadeOutStart.toFixed(3)}:d=${fadeSeconds.toFixed(3)}[music]`,
        `[original][music]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,atrim=start=0:end=${durationText},asetpts=N/SR/TB,alimiter=limit=0.95[aout]`
      ].join(';')
    : `[1:a:0]volume=1.0,atrim=start=0:end=${durationText},asetpts=N/SR/TB,afade=t=in:st=0:d=${fadeSeconds.toFixed(3)},afade=t=out:st=${fadeOutStart.toFixed(3)}:d=${fadeSeconds.toFixed(3)},alimiter=limit=0.95[aout]`;

  const runCommand = options.runCommand || runProcess;
  const videoStrategies = [
    { name: 'copy', args: ['-c:v', 'copy'] },
    { name: 'transcode', args: ['-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p'] }
  ];

  let lastError;
  for (const strategy of videoStrategies) {
    try {
      await fsp.rm(outputPath, { force: true });
      await runCommand(
        options.ffmpegPath || resolveFfmpegPath(),
        [
          '-hide_banner', '-loglevel', 'error',
          '-i', videoPath,
          '-stream_loop', '-1', '-i', trackPath,
          '-filter_complex', filter,
          '-map', '0:v:0', '-map', '[aout]',
          '-t', durationText,
          ...strategy.args,
          '-c:a', 'aac', '-b:a', '192k',
          '-movflags', '+faststart',
          '-map_metadata', '0',
          '-shortest',
          '-y', outputPath
        ],
        { timeoutMs: options.timeoutMs || config.autoMusic.renderTimeoutMs }
      );

      const stats = await fsp.stat(outputPath);
      if (!stats.isFile() || stats.size === 0) {
        throw autoMusicError('FFmpeg did not create a usable final video', 'AUTO_MUSIC_RENDER_FAILED');
      }

      const renderedMetadata = await probeSourceVideoForMusic(outputPath, options);
      const durationDiff = Math.abs(renderedMetadata.durationSeconds - duration);
      if (durationDiff < MAX_DURATION_DRIFT_SECONDS) {
        return {
          outputPath,
          size: stats.size,
          hasOriginalAudio,
          musicVolume,
          durationSeconds: duration,
          renderedDurationSeconds: renderedMetadata.durationSeconds,
          durationDiffSeconds: Number(durationDiff.toFixed(3)),
          videoMode: strategy.name
        };
      }

      throw autoMusicError(
        `Rendered video duration drifted by ${durationDiff.toFixed(3)}s from source duration ${durationText}s`,
        'AUTO_MUSIC_DURATION_MISMATCH'
      );
    } catch (error) {
      lastError = error;
      await fsp.rm(outputPath, { force: true });
      if (strategy.name === 'copy') {
        console.warn('[auto-music] stream-copy render failed; retrying with video transcode:', error.message);
      }
    }
  }

  throw autoMusicError(
    `Auto Music render failed: ${lastError ? lastError.message : 'unknown FFmpeg error'}`,
    lastError && lastError.code ? lastError.code : 'AUTO_MUSIC_RENDER_FAILED',
    lastError
  );
}

/**
 * Produce a muted derivative of `videoPath` at `outputPath` (destination-level
 * sound mode: mute). Streams every non-audio track through unchanged (`-c copy`)
 * and drops audio (`-an`) — a fast remux, no re-encode — so it stays in the
 * source container and, crucially, never mutates the canonical source: the
 * output is always a distinct file. Reuses the same ffmpeg resolution and
 * injectable runCommand as the rest of this module.
 */
async function deriveMutedVideo(videoPath, outputPath, options = {}) {
  if (path.resolve(videoPath) === path.resolve(outputPath)) {
    throw autoMusicError('Muted derivative must not overwrite its source', 'MUTED_VIDEO_INVALID_TARGET');
  }
  const runCommand = options.runCommand || runProcess;
  await fsp.rm(outputPath, { force: true });
  await runCommand(
    options.ffmpegPath || resolveFfmpegPath(),
    [
      '-hide_banner', '-loglevel', 'error',
      '-i', videoPath,
      '-map', '0',
      '-c', 'copy',
      '-an',
      '-y', outputPath
    ],
    { timeoutMs: options.timeoutMs || config.autoMusic.renderTimeoutMs }
  );

  const stats = await fsp.stat(outputPath);
  if (!stats.isFile() || stats.size === 0) {
    throw autoMusicError('FFmpeg did not create a usable muted video', 'MUTED_VIDEO_RENDER_FAILED');
  }
  return { outputPath, size: stats.size };
}

async function prepareAutoMusic({ videoPath, originalName, originalSize, userId, analysis }, options = {}) {
  await fsp.mkdir(config.uploadsDir, { recursive: true });
  await cleanupExpiredPreparedMediaFiles();
  const catalog = options.catalog || await loadMusicCatalog(options);
  const track = selectMusicTrack(analysis, catalog);
  const fileName = `auto-music-${randomUUID()}.mp4`;
  const outputPath = path.join(config.uploadsDir, fileName);

  try {
    const render = await mixBackgroundMusic(
      videoPath,
      track.absolutePath,
      outputPath,
      analysis.metadata,
      options
    );
    const token = createPreparedMediaToken({
      userId,
      originalName,
      originalSize,
      renderedFileName: fileName,
      renderedSize: render.size,
      trackId: track.id,
      trackCategory: track.category,
      trackMood: track.mood
    });
    return {
      prepared: true,
      token,
      track: publicTrack(track),
      render
    };
  } catch (error) {
    await fsp.rm(outputPath, { force: true });
    throw error;
  }
}

function createPreparedMediaToken(payload) {
  requireTokenSecret();
  const body = Buffer.from(JSON.stringify({
    version: 1,
    userId: String(payload.userId || ''),
    originalName: String(payload.originalName || ''),
    originalSize: Number(payload.originalSize || 0),
    renderedFileName: path.basename(String(payload.renderedFileName || '')),
    renderedSize: Number(payload.renderedSize || 0),
    trackId: String(payload.trackId || ''),
    trackCategory: String(payload.trackCategory || ''),
    trackMood: String(payload.trackMood || ''),
    expiresAt: Date.now() + config.autoMusic.tokenTtlMs
  })).toString('base64url');
  return `${body}.${signToken(body)}`;
}

function verifyPreparedMediaToken(token, { userId, file } = {}) {
  if (!config.autoMusic.tokenSecret) return null;
  const [body, signature, extra] = String(token || '').split('.');
  if (!body || !signature || extra) return null;
  const expected = Buffer.from(signToken(body));
  const supplied = Buffer.from(signature);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;

  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); }
  catch { return null; }
  const originalMime = String(file && file.mimetype || '').toLowerCase();
  const originalExtension = path.extname(String(file && file.originalname || '')).toLowerCase();
  if (
    payload.version !== 1 ||
    Number(payload.expiresAt || 0) <= Date.now() ||
    String(payload.userId || '') !== String(userId || '') ||
    !file ||
    (!originalMime.startsWith('video/') && !['.mp4', '.mov', '.webm'].includes(originalExtension)) ||
    String(payload.originalName || '') !== String(file.originalname || '') ||
    Number(payload.originalSize || 0) !== Number(file.size || 0)
  ) return null;

  const renderedFileName = path.basename(String(payload.renderedFileName || ''));
  if (!/^auto-music-[0-9a-f-]+\.mp4$/i.test(renderedFileName)) return null;
  const renderedPath = path.resolve(config.uploadsDir, renderedFileName);
  if (!isWithin(renderedPath, config.uploadsDir) || !fs.existsSync(renderedPath)) return null;
  const stats = fs.statSync(renderedPath);
  if (!stats.isFile() || stats.size !== Number(payload.renderedSize || 0)) return null;

  return {
    file: {
      path: renderedPath,
      filename: renderedFileName,
      originalname: file.originalname,
      mimetype: 'video/mp4',
      size: stats.size
    },
    trackId: String(payload.trackId || ''),
    trackCategory: String(payload.trackCategory || ''),
    trackMood: String(payload.trackMood || ''),
    originalName: String(payload.originalName || ''),
    originalSize: Number(payload.originalSize || 0)
  };
}

async function cleanupExpiredPreparedMediaFiles() {
  let entries = [];
  try { entries = await fsp.readdir(config.uploadsDir, { withFileTypes: true }); }
  catch { return; }
  const cutoff = Date.now() - config.autoMusic.tokenTtlMs;
  await Promise.all(entries
    .filter((entry) => entry.isFile() && /^auto-music-[0-9a-f-]+\.mp4$/i.test(entry.name))
    .map(async (entry) => {
      const filePath = path.join(config.uploadsDir, entry.name);
      try {
        const stats = await fsp.stat(filePath);
        if (stats.mtimeMs < cutoff) await fsp.rm(filePath, { force: true });
      } catch {
        // Best-effort cleanup must not block an upload.
      }
    }));
}

function isAutoMusicConfigured() {
  return Boolean(
    config.autoMusic.tokenSecret &&
    fs.existsSync(config.autoMusic.catalogPath) &&
    fs.existsSync(config.autoMusic.libraryDir)
  );
}

function safeLibraryPath(filename, libraryDir) {
  const root = path.resolve(libraryDir);
  const resolved = path.resolve(root, String(filename || ''));
  if (!isWithin(resolved, root)) {
    throw autoMusicError(`Music catalog path is outside the library: ${filename}`, 'INVALID_MUSIC_CATALOG');
  }
  return resolved;
}

function isWithin(candidate, root) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function normalizeTags(values) {
  const raw = Array.isArray(values) ? values : String(values || '').split(/[\s,]+/);
  return [...new Set(raw.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean))];
}

function publicTrack(track) {
  return {
    id: track.id,
    filename: track.filename,
    category: track.category,
    mood: track.mood,
    bpm: track.bpm,
    intensity: track.intensity,
    tags: track.tags
  };
}

function resolveFfmpegPath() {
  return config.autoCaption.ffmpegPath || require('ffmpeg-static') || 'ffmpeg';
}

function resolveFfprobePath() {
  return config.autoCaption.ffprobePath || bundledFfprobePath || 'ffprobe';
}

async function probeSourceVideoForMusic(videoPath, options = {}) {
  const runCommand = options.probeRunCommand || options.runCommand || runProcess;
  const result = await runCommand(
    options.ffprobePath || resolveFfprobePath(),
    ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', videoPath],
    { timeoutMs: options.timeoutMs || config.autoCaption.ffmpegTimeoutMs }
  );

  let probe;
  try {
    probe = JSON.parse(result.stdout);
  } catch (error) {
    throw autoMusicError('FFprobe returned invalid video metadata', 'VIDEO_PROBE_FAILED', error);
  }

  const streams = Array.isArray(probe.streams) ? probe.streams : [];
  const video = streams.find((stream) => stream.codec_type === 'video');
  const audio = streams.find((stream) => stream.codec_type === 'audio');
  if (!video) throw autoMusicError('The uploaded file does not contain a video stream', 'VIDEO_STREAM_MISSING');

  const duration = finiteNumber(video.duration)
    || parseDurationTag(video.tags && (video.tags.DURATION || video.tags.duration))
    || finiteNumber(probe.format && probe.format.duration);

  return {
    durationSeconds: Number(duration.toFixed(3)),
    hasAudio: Boolean(audio)
  };
}

function signToken(body) {
  return createHmac('sha256', config.autoMusic.tokenSecret).update(body).digest('base64url');
}

function requireTokenSecret() {
  if (!config.autoMusic.tokenSecret) {
    throw autoMusicError('Auto Music token signing is not configured', 'AUTO_MUSIC_NOT_CONFIGURED');
  }
}

function clamp01(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : 0.5;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function parseDurationTag(value) {
  const text = String(value || '').trim();
  const parts = text.split(':').map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return 0;
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

function autoMusicError(message, code, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

module.exports = {
  loadMusicCatalog,
  selectMusicTrack,
  mixBackgroundMusic,
  deriveMutedVideo,
  prepareAutoMusic,
  createPreparedMediaToken,
  verifyPreparedMediaToken,
  cleanupExpiredPreparedMediaFiles,
  isAutoMusicConfigured
};
