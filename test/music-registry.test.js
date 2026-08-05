'use strict';

process.env.AUTO_MUSIC_TOKEN_SECRET = 'test-music-registry-secret';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createHash } = require('node:crypto');
const ffmpegPath = require('ffmpeg-static');
const { runProcess } = require('../src/autoCaption');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chanter-music-registry-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function createTestTrackSync(dir, filename) {
  const trackDir = path.join(dir, 'library', path.dirname(filename));
  fs.mkdirSync(trackDir, { recursive: true });
  const trackPath = path.join(dir, 'library', filename);
  // Minimum valid MP3-like content for SHA-256 testing
  fs.writeFileSync(trackPath, Buffer.from('fake-audio-content-for-sha256-test'));
  return trackPath;
}

async function createRealTestTrack(dir, filename) {
  const trackDir = path.join(dir, 'library', path.dirname(filename));
  fs.mkdirSync(trackDir, { recursive: true });
  const trackPath = path.join(dir, 'library', filename);
  await runProcess(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
    '-t', '18',
    '-c:a', 'libmp3lame', '-b:a', '96k',
    '-y', trackPath
  ], { timeoutMs: 30_000 });
  return trackPath;
}

function baseRegistration(overrides = {}) {
  return {
    id: 'test-track-01',
    filename: 'test/test-track-01.mp3',
    title: 'Test Track One',
    provider: 'test-generator',
    providerAssetId: 'gen-001',
    category: 'cyberpunk-dark',
    mood: 'dark futuristic',
    bpm: 120,
    intensity: 0.7,
    tags: ['test', 'cyberpunk'],
    rightsStatus: 'verified',
    licencePlan: 'test-free',
    licenceEvidenceRef: 'repo-generated-test-fixture:scripts/generate-demo-music.js',
    sourceCreatedAt: '2025-01-01T00:00:00Z',
    ...overrides
  };
}

test('validates and registers a music track with SHA-256', async (t) => {
  const dir = tempDir(t);
  const registryPath = path.join(dir, 'registry.json');
  const libraryDir = path.join(dir, 'library');
  await createRealTestTrack(dir, 'test/test-track-01.mp3');

  const musicRegistry = require('../src/musicRegistry');
  const result = await musicRegistry.registerMusicTrack(
    baseRegistration(),
    { registryPath, libraryDir }
  );

  assert.equal(result.id, 'test-track-01');
  assert.ok(result.sha256 && result.sha256.length === 64, 'SHA-256 hash is 64 hex chars');
  assert.ok(result.durationSeconds > 0, 'duration is positive');
  assert.equal(result.rightsStatus, 'verified');
  assert.equal(result.licenceEvidenceRef, 'repo-generated-test-fixture:scripts/generate-demo-music.js');
  assert.ok(result.registeredAt);

  // Verify SHA-256 stability
  const rawData = fs.readFileSync(result.absolutePath);
  const expectedHash = createHash('sha256').update(rawData).digest('hex');
  assert.equal(result.sha256, expectedHash);

  // Verify registry was persisted
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  assert.equal(registry.version, 1);
  assert.equal(registry.tracks.length, 1);
  assert.equal(registry.tracks[0].id, 'test-track-01');
});

test('rejects duplicate track ID', async (t) => {
  const dir = tempDir(t);
  const registryPath = path.join(dir, 'registry.json');
  const libraryDir = path.join(dir, 'library');
  await createRealTestTrack(dir, 'test/test-track-01.mp3');

  const musicRegistry = require('../src/musicRegistry');
  await musicRegistry.registerMusicTrack(
    baseRegistration(),
    { registryPath, libraryDir }
  );

  await assert.rejects(
    () => musicRegistry.registerMusicTrack(
      baseRegistration({ filename: 'test/test-track-01.mp3' }),
      { registryPath, libraryDir }
    ),
    (error) => error.code === 'DUPLICATE_TRACK_ID'
  );
});

test('rejects duplicate track hash', async (t) => {
  const dir = tempDir(t);
  const registryPath = path.join(dir, 'registry.json');
  const libraryDir = path.join(dir, 'library');
  const trackPath = await createRealTestTrack(dir, 'test/test-track-01.mp3');
  // Copy the same file as a different name
  const copyPath = path.join(dir, 'library', 'test', 'test-track-copy.mp3');
  fs.copyFileSync(trackPath, copyPath);

  const musicRegistry = require('../src/musicRegistry');
  await musicRegistry.registerMusicTrack(
    baseRegistration(),
    { registryPath, libraryDir }
  );

  await assert.rejects(
    () => musicRegistry.registerMusicTrack(
      baseRegistration({ id: 'copy-track', filename: 'test/test-track-copy.mp3' }),
      { registryPath, libraryDir }
    ),
    (error) => error.code === 'DUPLICATE_TRACK_HASH'
  );
});

test('rejects path traversal', async (t) => {
  const dir = tempDir(t);
  const registryPath = path.join(dir, 'registry.json');
  const libraryDir = path.join(dir, 'library');
  fs.mkdirSync(libraryDir, { recursive: true });

  const musicRegistry = require('../src/musicRegistry');
  await assert.rejects(
    () => musicRegistry.registerMusicTrack(
      baseRegistration({ filename: '../../etc/passwd' }),
      { registryPath, libraryDir }
    ),
    (error) => error.code === 'PATH_TRAVERSAL'
  );
});

test('rejects missing licence evidence', async (t) => {
  const musicRegistry = require('../src/musicRegistry');
  assert.throws(
    () => musicRegistry.validateRegistrationRecord(
      baseRegistration({ licenceEvidenceRef: '' })
    ),
    (error) => error.code === 'INVALID_REGISTRATION'
  );
});

test('excludes unverified tracks from render eligibility', async (t) => {
  const dir = tempDir(t);
  const registryPath = path.join(dir, 'registry.json');
  const libraryDir = path.join(dir, 'library');
  await createRealTestTrack(dir, 'test/test-unverified.mp3');

  const musicRegistry = require('../src/musicRegistry');
  await musicRegistry.registerMusicTrack(
    baseRegistration({
      id: 'unverified-track',
      filename: 'test/test-unverified.mp3',
      rightsStatus: 'unverified'
    }),
    { registryPath, libraryDir }
  );

  const eligible = await musicRegistry.loadRegisteredMusic({ registryPath, libraryDir });
  assert.equal(eligible.length, 0, 'unverified track must not appear in eligible tracks');
});

test('excludes restricted tracks from render eligibility', async (t) => {
  const dir = tempDir(t);
  const registryPath = path.join(dir, 'registry.json');
  const libraryDir = path.join(dir, 'library');
  await createRealTestTrack(dir, 'test/test-restricted.mp3');

  const musicRegistry = require('../src/musicRegistry');
  await musicRegistry.registerMusicTrack(
    baseRegistration({
      id: 'restricted-track',
      filename: 'test/test-restricted.mp3',
      rightsStatus: 'restricted'
    }),
    { registryPath, libraryDir }
  );

  const eligible = await musicRegistry.loadRegisteredMusic({ registryPath, libraryDir });
  assert.equal(eligible.length, 0, 'restricted track must not appear in eligible tracks');
});

test('rejects invalid registration fields', async (t) => {
  const musicRegistry = require('../src/musicRegistry');

  // Missing required fields
  assert.throws(
    () => musicRegistry.validateRegistrationRecord({}),
    (error) => error.code === 'INVALID_REGISTRATION'
  );

  // Invalid bpm
  assert.throws(
    () => musicRegistry.validateRegistrationRecord(baseRegistration({ bpm: -1 })),
    (error) => error.code === 'INVALID_REGISTRATION'
  );

  // Invalid intensity
  assert.throws(
    () => musicRegistry.validateRegistrationRecord(baseRegistration({ intensity: 2 })),
    (error) => error.code === 'INVALID_REGISTRATION'
  );

  // Invalid rightsStatus
  assert.throws(
    () => musicRegistry.validateRegistrationRecord(baseRegistration({ rightsStatus: 'pirated' })),
    (error) => error.code === 'INVALID_REGISTRATION'
  );

  // Empty tags
  assert.throws(
    () => musicRegistry.validateRegistrationRecord(baseRegistration({ tags: [] })),
    (error) => error.code === 'INVALID_REGISTRATION'
  );
});

test('getRegisteredTrackById returns null for unknown track', async (t) => {
  const dir = tempDir(t);
  const registryPath = path.join(dir, 'registry.json');
  const libraryDir = path.join(dir, 'library');
  fs.mkdirSync(libraryDir, { recursive: true });

  const musicRegistry = require('../src/musicRegistry');
  const result = await musicRegistry.getRegisteredTrackById('nonexistent', { registryPath, libraryDir });
  assert.equal(result, null);
});
