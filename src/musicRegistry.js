'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { createHash, randomUUID } = require('crypto');
const config = require('./config');
const { resolveFfprobePath } = require('./ffmpegPaths');
const { runProcess } = require('./autoCaption');

const REGISTRY_SCHEMA_VERSION = 1;
const REQUIRED_FIELDS = [
  'id', 'filename', 'title', 'provider', 'category', 'mood',
  'bpm', 'intensity', 'tags', 'rightsStatus', 'licenceEvidenceRef'
];
const VALID_RIGHTS_STATUSES = new Set(['verified', 'unverified', 'restricted']);

const registryLocks = new Map();

async function withRegistryLock(registryPath, fn) {
  const key = path.resolve(registryPath);
  const previous = registryLocks.get(key) || Promise.resolve();

  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });

  const nextChain = previous.then(() => current, () => current);
  registryLocks.set(key, nextChain);

  try {
    await previous.catch(() => {});
    return await fn();
  } finally {
    release();
    if (registryLocks.get(key) === nextChain) {
      registryLocks.delete(key);
    }
  }
}

// ── Public API ───────────────────────────────────────────────────────────

async function registerMusicTrack(input, options = {}) {
  const record = validateRegistrationRecord(input);
  const libraryDir = options.libraryDir || config.autoMusic.libraryDir;
  const registryPath = options.registryPath || registryFilePath();
  const absolutePath = safeLibraryPath(record.filename, libraryDir);

  return withRegistryLock(registryPath, async () => {
    const stat = await fsp.stat(absolutePath).catch(() => null);
    if (!stat || !stat.isFile()) {
      throw registryError(`Track file does not exist: ${record.filename}`, 'TRACK_FILE_MISSING');
    }

    const sha256 = await computeSha256(absolutePath);
    const durationSeconds = await probeTrackDuration(absolutePath, options);

    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      throw registryError('Track duration must be a finite positive number', 'INVALID_TRACK_DURATION');
    }

    const finalRecord = {
      id: record.id,
      sha256,
      filename: record.filename,
      title: record.title,
      provider: record.provider,
      providerAssetId: record.providerAssetId || '',
      category: record.category,
      mood: record.mood,
      bpm: record.bpm,
      intensity: record.intensity,
      tags: record.tags,
      durationSeconds: Number(durationSeconds.toFixed(3)),
      instrumental: record.instrumental !== false,
      rightsStatus: record.rightsStatus,
      licencePlan: record.licencePlan || '',
      licenceEvidenceRef: record.licenceEvidenceRef,
      sourceCreatedAt: record.sourceCreatedAt || '',
      registeredAt: new Date().toISOString()
    };

    const registry = await loadRegistryFile(registryPath);
    if (registry.tracks.some((t) => t.id === finalRecord.id)) {
      throw registryError(`Duplicate track ID: ${finalRecord.id}`, 'DUPLICATE_TRACK_ID');
    }
    if (registry.tracks.some((t) => t.sha256 === finalRecord.sha256)) {
      throw registryError(`Duplicate track hash: ${finalRecord.sha256.slice(0, 16)}…`, 'DUPLICATE_TRACK_HASH');
    }

    registry.tracks.push(finalRecord);
    await writeRegistryFile(registryPath, registry);

    return {
      ...finalRecord,
      absolutePath
    };
  });
}

async function loadRegisteredMusic(options = {}) {
  const libraryDir = options.libraryDir || config.autoMusic.libraryDir;
  const registryPath = options.registryPath || registryFilePath();

  return withRegistryLock(registryPath, async () => {
    const registry = await loadRegistryFile(registryPath);

    return registry.tracks
      .filter((t) => t.rightsStatus === 'verified')
      .map((t) => ({
        ...t,
        absolutePath: safeLibraryPath(t.filename, libraryDir)
      }))
      .filter((t) => {
        try {
          return fs.existsSync(t.absolutePath) && fs.statSync(t.absolutePath).isFile();
        } catch { return false; }
      });
  });
}

function validateRegistrationRecord(input) {
  if (!input || typeof input !== 'object') {
    throw registryError('Registration input must be an object', 'INVALID_REGISTRATION');
  }

  const missing = REQUIRED_FIELDS.filter((f) => input[f] == null || input[f] === '');
  if (missing.length > 0) {
    throw registryError(`Missing required fields: ${missing.join(', ')}`, 'INVALID_REGISTRATION');
  }

  const id = String(input.id).trim();
  if (!id) throw registryError('Track ID must not be empty', 'INVALID_REGISTRATION');

  const rightsStatus = String(input.rightsStatus).trim().toLowerCase();
  if (!VALID_RIGHTS_STATUSES.has(rightsStatus)) {
    throw registryError(
      `rightsStatus must be one of: ${[...VALID_RIGHTS_STATUSES].join(', ')}`,
      'INVALID_REGISTRATION'
    );
  }

  const bpm = Number(input.bpm);
  const intensity = Number(input.intensity);
  if (!Number.isFinite(bpm) || bpm <= 0) {
    throw registryError('bpm must be a finite positive number', 'INVALID_REGISTRATION');
  }
  if (!Number.isFinite(intensity) || intensity < 0 || intensity > 1) {
    throw registryError('intensity must be a finite number between 0 and 1', 'INVALID_REGISTRATION');
  }

  const tags = normalizeTags(input.tags);
  if (tags.length === 0) {
    throw registryError('At least one tag is required', 'INVALID_REGISTRATION');
  }

  return {
    id,
    filename: String(input.filename).trim(),
    title: String(input.title).trim(),
    provider: String(input.provider).trim(),
    providerAssetId: String(input.providerAssetId || '').trim(),
    category: String(input.category).trim().toLowerCase(),
    mood: String(input.mood).trim().toLowerCase(),
    bpm,
    intensity,
    tags,
    instrumental: input.instrumental !== false,
    rightsStatus,
    licencePlan: String(input.licencePlan || '').trim(),
    licenceEvidenceRef: String(input.licenceEvidenceRef).trim(),
    sourceCreatedAt: String(input.sourceCreatedAt || '').trim()
  };
}

async function getRegisteredTrackById(trackId, options = {}) {
  const libraryDir = options.libraryDir || config.autoMusic.libraryDir;
  const registryPath = options.registryPath || registryFilePath();

  return withRegistryLock(registryPath, async () => {
    const registry = await loadRegistryFile(registryPath);
    const record = registry.tracks.find((t) => t.id === trackId);
    if (!record) return null;

    return {
      ...record,
      absolutePath: safeLibraryPath(record.filename, libraryDir)
    };
  });
}

async function probeTrackDuration(trackPath, options = {}) {
  const runCommand = options.runCommand || runProcess;
  const result = await runCommand(
    options.ffprobePath || resolveFfprobePath(),
    [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      trackPath
    ],
    { timeoutMs: options.timeoutMs || 30_000 }
  );

  const duration = Number(String(result.stdout || '').trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw registryError('Could not determine track duration', 'TRACK_PROBE_FAILED');
  }
  return Number(duration.toFixed(3));
}

// ── Internal helpers ─────────────────────────────────────────────────────

function registryFilePath() {
  return path.join(config.rootDir, 'data', 'music-registry.json');
}

async function loadRegistryFile(filePath) {
  let raw;
  try {
    raw = await fsp.readFile(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { version: REGISTRY_SCHEMA_VERSION, tracks: [] };
    }
    throw registryError(`Failed to read music registry: ${err.message}`, 'INVALID_MUSIC_REGISTRY');
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw registryError('Malformed music registry JSON', 'INVALID_MUSIC_REGISTRY');
  }

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    parsed.version !== REGISTRY_SCHEMA_VERSION ||
    !Array.isArray(parsed.tracks)
  ) {
    throw registryError('Invalid music registry schema', 'INVALID_MUSIC_REGISTRY');
  }

  for (const track of parsed.tracks) {
    if (
      !track ||
      typeof track !== 'object' ||
      typeof track.id !== 'string' ||
      !track.id ||
      typeof track.sha256 !== 'string' ||
      !track.sha256 ||
      typeof track.filename !== 'string' ||
      !track.filename ||
      typeof track.rightsStatus !== 'string' ||
      !track.rightsStatus
    ) {
      throw registryError('Invalid stored track record in registry', 'INVALID_MUSIC_REGISTRY');
    }
  }

  return parsed;
}

async function writeRegistryFile(filePath, registry) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const content = JSON.stringify(registry, null, 2) + '\n';
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await fsp.writeFile(tempPath, content, 'utf8');
    await fsp.rename(tempPath, filePath);
  } catch (error) {
    await fsp.rm(tempPath, { force: true });
    throw error;
  }
}

async function computeSha256(filePath) {
  const data = await fsp.readFile(filePath);
  return createHash('sha256').update(data).digest('hex');
}

function safeLibraryPath(filename, libraryDir) {
  const root = path.resolve(libraryDir);
  const resolved = path.resolve(root, String(filename || ''));
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw registryError(`Track path is outside the library: ${filename}`, 'PATH_TRAVERSAL');
  }
  return resolved;
}

function normalizeTags(values) {
  const raw = Array.isArray(values) ? values : String(values || '').split(/[\s,]+/);
  return [...new Set(raw.map((v) => String(v || '').trim().toLowerCase()).filter(Boolean))];
}

function registryError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

module.exports = {
  registerMusicTrack,
  loadRegisteredMusic,
  validateRegistrationRecord,
  getRegisteredTrackById,
  probeTrackDuration,
  computeSha256
};
