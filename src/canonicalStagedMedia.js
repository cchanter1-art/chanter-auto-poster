'use strict';

// Immutable, intake-bound media staging for canonical commands. A reference
// authenticates metadata; it never grants a public download URL. Runtime
// resolution verifies the stable source again and materializes a disposable
// copy because AutoPoster's storage layer owns cleanup of every file it is
// handed.

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { createHash, createHmac, randomUUID, timingSafeEqual } = require('crypto');

const REFERENCE_PREFIX = 'chanter-autoposter-staged://v1/';
// Two intake namespaces share one staging store: customer platform commands
// and the runtime media seam. Both are opaque 40-hex identities derived by
// their own caller, so neither can name a directory outside the staging root
// or forge the other's intake.
const RUNTIME_INTAKE_ID_PATTERN = /^runtime-media-[a-f0-9]{40}$/;
const COMMAND_ID_PATTERN = /^(?:platform-autoposter|runtime-media)-[a-f0-9]{40}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.webm']);
const VIDEO_MIME_TYPES = new Set(['video/mp4', 'video/quicktime', 'video/webm']);
const MIME_BY_EXTENSION = Object.freeze({
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm'
});
const UNSAFE_FILE_NAME_PATTERN = /[\x00-\x1f<>:"/\\|?*]/;

class StagedMediaError extends Error {
  constructor(message, {
    status = 400,
    code = 'staged_media_invalid',
    retryable = false,
    details = {}
  } = {}) {
    super(message);
    this.name = 'StagedMediaError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

function safeExtension(file) {
  const explicit = path.extname(String((file && file.originalname) || '')).toLowerCase();
  if (VIDEO_EXTENSIONS.has(explicit)) return explicit;
  const mime = String((file && file.mimetype) || '').toLowerCase();
  if (mime === 'video/quicktime') return '.mov';
  if (mime === 'video/webm') return '.webm';
  if (mime === 'video/mp4') return '.mp4';
  throw new StagedMediaError('Canonical staged media must be an MP4, MOV, or WebM video.');
}

function safeFileName(file, extension) {
  const value = path.basename(String((file && file.originalname) || `video${extension}`));
  if (
    !value
    || value.length > 255
    || value.endsWith('.')
    || value.endsWith(' ')
    || UNSAFE_FILE_NAME_PATTERN.test(value)
  ) {
    throw new StagedMediaError('The uploaded video filename is not safe for canonical staging.');
  }
  return value;
}

async function sha256File(filePath) {
  const digest = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => digest.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return digest.digest('hex');
}

function signature(secret, encoded) {
  return createHmac('sha256', secret).update(encoded).digest('hex');
}

function signedReference(secret, payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${REFERENCE_PREFIX}${encoded}.${signature(secret, encoded)}`;
}

function parseReference(reference, secret) {
  const raw = String(reference || '');
  if (!raw.startsWith(REFERENCE_PREFIX) || !secret) {
    throw new StagedMediaError('The staged media reference is invalid or unavailable.');
  }
  const signed = raw.slice(REFERENCE_PREFIX.length);
  const [encoded, supplied, extra] = signed.split('.');
  if (!encoded || !supplied || extra) {
    throw new StagedMediaError('The staged media reference is malformed.');
  }
  const expectedBytes = Buffer.from(signature(secret, encoded));
  const suppliedBytes = Buffer.from(supplied);
  if (
    expectedBytes.length !== suppliedBytes.length
    || !timingSafeEqual(expectedBytes, suppliedBytes)
  ) {
    throw new StagedMediaError('The staged media reference signature is invalid.');
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw new StagedMediaError('The staged media reference payload is invalid.');
  }
  const keys = Object.keys(payload || {}).sort();
  const expectedKeys = [
    'byteSize',
    'commandId',
    'extension',
    'fileName',
    'mimeType',
    'schemaVersion',
    'sha256'
  ].sort();
  if (
    JSON.stringify(keys) !== JSON.stringify(expectedKeys)
    || payload.schemaVersion !== 'chanter.autoposter.staged-media.v1'
    || !COMMAND_ID_PATTERN.test(String(payload.commandId || ''))
    || !SHA256_PATTERN.test(String(payload.sha256 || ''))
    || !VIDEO_EXTENSIONS.has(String(payload.extension || ''))
    || !Number.isSafeInteger(payload.byteSize)
    || payload.byteSize < 1
    || path.basename(String(payload.fileName || '')) !== String(payload.fileName || '')
    || !VIDEO_MIME_TYPES.has(String(payload.mimeType || '').toLowerCase())
    || MIME_BY_EXTENSION[String(payload.extension || '')] !== String(payload.mimeType || '').toLowerCase()
    || !String(payload.fileName || '')
    || String(payload.fileName).length > 255
    || String(payload.fileName).endsWith('.')
    || String(payload.fileName).endsWith(' ')
    || UNSAFE_FILE_NAME_PATTERN.test(String(payload.fileName))
  ) {
    throw new StagedMediaError('The staged media reference contract is invalid.');
  }
  return payload;
}

async function readManifest(manifestPath) {
  try {
    return JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw new StagedMediaError('Existing canonical media staging metadata is unreadable.', {
      status: 503,
      code: 'staged_media_unavailable',
      retryable: true
    });
  }
}

function assertSameIntake(existing, incoming) {
  const same = existing
    && existing.commandId === incoming.commandId
    && existing.sha256 === incoming.sha256
    && existing.byteSize === incoming.byteSize
    && existing.extension === incoming.extension
    && existing.mimeType === incoming.mimeType;
  if (!same) {
    throw new StagedMediaError(
      'This intake key is already bound to different staged media. Start a new composition for changed media.',
      { status: 409, code: 'intake_media_conflict' }
    );
  }
}

function createCanonicalStagedMedia(options = {}) {
  const configuredRootDir = String(options.rootDir || '').trim();
  const rootDir = configuredRootDir ? path.resolve(configuredRootDir) : '';
  const secret = String(options.secret || '');

  function requireConfiguration() {
    if (secret.length < 32 || !rootDir) {
      throw new StagedMediaError(
        'Canonical staged-media signing is not configured.',
        { status: 503, code: 'canonical_execution_unavailable', retryable: true }
      );
    }
  }

  function mediaPath(payload) {
    return path.join(rootDir, payload.commandId, `${payload.sha256}${payload.extension}`);
  }

  async function stage(commandId, file) {
    requireConfiguration();
    if (!COMMAND_ID_PATTERN.test(String(commandId || ''))) {
      throw new StagedMediaError('Canonical command identity is invalid.');
    }
    if (!file || !file.path) {
      throw new StagedMediaError('One uploaded video is required for canonical staging.');
    }
    const sourcePath = path.resolve(String(file.path));
    const stats = await fsp.stat(sourcePath).catch(() => null);
    if (!stats || !stats.isFile() || stats.size < 1) {
      throw new StagedMediaError('The uploaded video is unavailable for canonical staging.');
    }
    const extension = safeExtension(file);
    const mimeType = String(file.mimetype || '').toLowerCase();
    if (!VIDEO_MIME_TYPES.has(mimeType) || MIME_BY_EXTENSION[extension] !== mimeType) {
      throw new StagedMediaError(
        'Canonical staged media filename extension and video MIME type do not match.'
      );
    }
    const sha256 = await sha256File(sourcePath);
    const payload = {
      schemaVersion: 'chanter.autoposter.staged-media.v1',
      commandId,
      fileName: safeFileName(file, extension),
      mimeType,
      byteSize: stats.size,
      sha256,
      extension
    };

    const commandDir = path.join(rootDir, commandId);
    const manifestPath = path.join(commandDir, 'media.json');
    await fsp.mkdir(commandDir, { recursive: true });
    const existing = await readManifest(manifestPath);
    if (existing) {
      assertSameIntake(existing, payload);
      const stablePath = mediaPath(existing);
      const stableStats = await fsp.stat(stablePath).catch(() => null);
      if (!stableStats || stableStats.size !== existing.byteSize) {
        throw new StagedMediaError('Canonical staged media is missing or incomplete.', {
          status: 503,
          code: 'staged_media_unavailable',
          retryable: true
        });
      }
      return { reference: signedReference(secret, existing), media: existing, replayed: true };
    }

    const stablePath = mediaPath(payload);
    const temporaryPath = `${stablePath}.${randomUUID()}.tmp`;
    await fsp.copyFile(sourcePath, temporaryPath);
    try {
      await fsp.rename(temporaryPath, stablePath);
    } catch (error) {
      await fsp.rm(temporaryPath, { force: true }).catch(() => {});
      if (error && error.code !== 'EEXIST') throw error;
    }
    try {
      await fsp.writeFile(manifestPath, JSON.stringify(payload), { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
      assertSameIntake(await readManifest(manifestPath), payload);
    }
    return { reference: signedReference(secret, payload), media: payload, replayed: false };
  }

  async function materialize(reference) {
    requireConfiguration();
    const payload = parseReference(reference, secret);
    const stablePath = mediaPath(payload);
    const stats = await fsp.stat(stablePath).catch(() => null);
    if (!stats || !stats.isFile() || stats.size !== payload.byteSize) {
      throw new StagedMediaError('Canonical staged media is unavailable for execution.', {
        status: 503,
        code: 'staged_media_unavailable',
        retryable: true
      });
    }
    const actualHash = await sha256File(stablePath);
    if (actualHash !== payload.sha256) {
      throw new StagedMediaError('Canonical staged media failed its integrity check.', {
        status: 409,
        code: 'staged_media_integrity_failed'
      });
    }
    const tempPath = path.join(
      os.tmpdir(),
      `chanter-autoposter-${payload.commandId}-${randomUUID()}${payload.extension}`
    );
    await fsp.copyFile(stablePath, tempPath);
    return {
      file: {
        path: tempPath,
        filename: path.basename(tempPath),
        originalname: payload.fileName,
        mimetype: payload.mimeType,
        size: payload.byteSize
      },
      media: payload,
      cleanup: () => fsp.rm(tempPath, { force: true })
    };
  }

  // Called only after AutoPoster has returned a durable product job whose
  // media upload succeeded. Exact replay is then served from the product
  // record, so the accepted staging copy no longer owns recovery.
  async function release(reference) {
    requireConfiguration();
    const payload = parseReference(reference, secret);
    const commandDir = path.resolve(rootDir, payload.commandId);
    if (path.dirname(commandDir) !== rootDir) {
      throw new StagedMediaError('Canonical staged-media cleanup target is invalid.');
    }
    await fsp.rm(commandDir, { recursive: true, force: true });
    return { released: true, commandId: payload.commandId };
  }

  return {
    stage,
    materialize,
    release,
    parseReference: (reference) => parseReference(reference, secret)
  };
}

module.exports = {
  REFERENCE_PREFIX,
  RUNTIME_INTAKE_ID_PATTERN,
  StagedMediaError,
  createCanonicalStagedMedia
};
