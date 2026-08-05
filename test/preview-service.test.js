'use strict';

process.env.AUTO_MUSIC_TOKEN_SECRET = 'test-preview-service-secret';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ffmpegPath = require('ffmpeg-static');
const { runProcess } = require('../src/autoCaption');
const config = require('../src/config');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chanter-preview-service-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function createTestImage(dir, name = 'test-image.png') {
  const imagePath = path.join(dir, name);
  await runProcess(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=size=1920x1280:rate=1',
    '-frames:v', '1',
    '-y', imagePath
  ], { timeoutMs: 30_000 });
  return imagePath;
}

async function createTestTrack(dir, librarySubdir, name = 'test-track.mp3', durationSeconds = 18) {
  const trackDir = path.join(dir, 'library', librarySubdir);
  fs.mkdirSync(trackDir, { recursive: true });
  const trackPath = path.join(trackDir, name);
  await runProcess(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
    '-t', String(durationSeconds),
    '-c:a', 'libmp3lame', '-b:a', '96k',
    '-y', trackPath
  ], { timeoutMs: 30_000 });
  return trackPath;
}

async function setupRegisteredTrack(dir) {
  const registryPath = path.join(dir, 'registry.json');
  const libraryDir = path.join(dir, 'library');
  await createTestTrack(dir, 'test', 'demo.mp3', 18);

  const musicRegistry = require('../src/musicRegistry');
  const track = await musicRegistry.registerMusicTrack({
    id: 'service-test-track',
    filename: 'test/demo.mp3',
    title: 'Service Test Track',
    provider: 'test-generator',
    providerAssetId: '',
    category: 'cyberpunk-dark',
    mood: 'dark',
    bpm: 120,
    intensity: 0.7,
    tags: ['test'],
    rightsStatus: 'verified',
    licencePlan: 'test-free',
    licenceEvidenceRef: 'repo-generated-test-fixture:scripts/generate-demo-music.js'
  }, { registryPath, libraryDir });

  return { track, registryPath, libraryDir };
}

test('creates a preview, persists manifest, and issues a valid token', async (t) => {
  const dir = tempDir(t);
  const previewDir = path.join(dir, 'previews');
  const manifestDir = path.join(dir, 'previews', 'manifests');
  const imagePath = await createTestImage(dir);
  const { track, registryPath, libraryDir } = await setupRegisteredTrack(dir);

  const origPreviewDir = config.mediaPreview.previewDir;
  const origManifestDir = config.mediaPreview.manifestDir;
  config.mediaPreview.previewDir = previewDir;
  config.mediaPreview.manifestDir = manifestDir;
  t.after(() => {
    config.mediaPreview.previewDir = origPreviewDir;
    config.mediaPreview.manifestDir = origManifestDir;
  });

  const previewService = require('../src/previewService');
  const result = await previewService.createImageMusicPreview({
    userId: 'test-user',
    imagePath,
    originalName: 'test-image.png',
    originalSize: fs.statSync(imagePath).size,
    durationSeconds: 5,
    trackId: 'service-test-track',
    segmentStartSeconds: 0,
    focalX: 0.5,
    focalY: 0.5
  }, { registryPath, libraryDir, previewDir, manifestDir });

  // Verify return shape
  assert.ok(result.previewId);
  assert.ok(result.token);
  assert.ok(result.previewUrl.startsWith('/uploads/previews/'));
  assert.equal(result.manifest.version, 1);
  assert.equal(result.manifest.kind, 'image_music_preview');
  assert.equal(result.manifest.render.width, 1080);
  assert.equal(result.manifest.render.height, 1920);
  assert.equal(result.manifest.render.durationSeconds, 5);
  assert.equal(result.manifest.music.trackId, 'service-test-track');
  assert.equal(result.manifest.music.rightsStatus, 'verified');
  assert.ok(result.manifest.music.trackSha256);
  assert.ok(result.manifest.output.size > 0);

  // Verify manifest persisted to disk
  const manifestFiles = fs.readdirSync(manifestDir).filter((f) => f.endsWith('.json'));
  assert.equal(manifestFiles.length, 1);
  const manifest = JSON.parse(fs.readFileSync(path.join(manifestDir, manifestFiles[0]), 'utf8'));
  assert.equal(manifest.version, 1);

  // Verify token round-trip
  const previewFilename = result.manifest.output.filename;
  const verified = previewService.verifyPreviewToken(result.token, {
    userId: 'test-user',
    outputFilename: previewFilename,
    outputSize: result.manifest.output.size
  });
  assert.ok(verified);
  assert.equal(verified.userId, 'test-user');
  assert.equal(verified.outputFilename, previewFilename);
});

test('rejects wrong userId in token verification', async (t) => {
  const dir = tempDir(t);
  const previewDir = path.join(dir, 'previews');
  const manifestDir = path.join(dir, 'previews', 'manifests');
  const imagePath = await createTestImage(dir);
  const { registryPath, libraryDir } = await setupRegisteredTrack(dir);

  const origPreviewDir = config.mediaPreview.previewDir;
  const origManifestDir = config.mediaPreview.manifestDir;
  config.mediaPreview.previewDir = previewDir;
  config.mediaPreview.manifestDir = manifestDir;
  t.after(() => {
    config.mediaPreview.previewDir = origPreviewDir;
    config.mediaPreview.manifestDir = origManifestDir;
  });

  const previewService = require('../src/previewService');
  const result = await previewService.createImageMusicPreview({
    userId: 'real-user',
    imagePath,
    originalName: 'test-image.png',
    originalSize: fs.statSync(imagePath).size,
    durationSeconds: 5,
    trackId: 'service-test-track',
    segmentStartSeconds: 0,
    focalX: 0.5,
    focalY: 0.5
  }, { registryPath, libraryDir, previewDir, manifestDir });

  const verified = previewService.verifyPreviewToken(result.token, {
    userId: 'wrong-user',
    outputFilename: result.manifest.output.filename,
    outputSize: result.manifest.output.size
  });
  assert.equal(verified, null, 'wrong userId must reject token');
});

test('rejects tampered token', async (t) => {
  const dir = tempDir(t);
  const previewDir = path.join(dir, 'previews');
  const manifestDir = path.join(dir, 'previews', 'manifests');
  const imagePath = await createTestImage(dir);
  const { registryPath, libraryDir } = await setupRegisteredTrack(dir);

  const origPreviewDir = config.mediaPreview.previewDir;
  const origManifestDir = config.mediaPreview.manifestDir;
  config.mediaPreview.previewDir = previewDir;
  config.mediaPreview.manifestDir = manifestDir;
  t.after(() => {
    config.mediaPreview.previewDir = origPreviewDir;
    config.mediaPreview.manifestDir = origManifestDir;
  });

  const previewService = require('../src/previewService');
  const result = await previewService.createImageMusicPreview({
    userId: 'test-user',
    imagePath,
    originalName: 'test-image.png',
    originalSize: fs.statSync(imagePath).size,
    durationSeconds: 5,
    trackId: 'service-test-track',
    segmentStartSeconds: 0,
    focalX: 0.5,
    focalY: 0.5
  }, { registryPath, libraryDir, previewDir, manifestDir });

  const tampered = result.token + 'x';
  const verified = previewService.verifyPreviewToken(tampered, {
    userId: 'test-user',
    outputFilename: result.manifest.output.filename,
    outputSize: result.manifest.output.size
  });
  assert.equal(verified, null, 'tampered token must be rejected');
});

test('rejects unverified track by trackId', async (t) => {
  const dir = tempDir(t);
  const registryPath = path.join(dir, 'registry.json');
  const libraryDir = path.join(dir, 'library');
  await createTestTrack(dir, 'test', 'unverified.mp3', 18);

  const musicRegistry = require('../src/musicRegistry');
  await musicRegistry.registerMusicTrack({
    id: 'unverified-svc',
    filename: 'test/unverified.mp3',
    title: 'Unverified',
    provider: 'test',
    category: 'cyberpunk-dark',
    mood: 'dark',
    bpm: 120,
    intensity: 0.7,
    tags: ['test'],
    rightsStatus: 'unverified',
    licencePlan: '',
    licenceEvidenceRef: 'pending-review'
  }, { registryPath, libraryDir });

  const previewDir = path.join(dir, 'previews');
  const manifestDir = path.join(dir, 'previews', 'manifests');
  const imagePath = await createTestImage(dir);

  const previewService = require('../src/previewService');
  await assert.rejects(
    () => previewService.createImageMusicPreview({
      userId: 'test-user',
      imagePath,
      originalName: 'test.png',
      originalSize: 100,
      durationSeconds: 5,
      trackId: 'unverified-svc',
      segmentStartSeconds: 0,
      focalX: 0.5,
      focalY: 0.5
    }, { registryPath, libraryDir, previewDir, manifestDir }),
    (error) => error.code === 'TRACK_NOT_VERIFIED'
  );
});

test('rejects unknown trackId', async (t) => {
  const dir = tempDir(t);
  const registryPath = path.join(dir, 'registry.json');
  const libraryDir = path.join(dir, 'library');
  fs.mkdirSync(libraryDir, { recursive: true });

  const imagePath = await createTestImage(dir);
  const previewDir = path.join(dir, 'previews');
  const manifestDir = path.join(dir, 'previews', 'manifests');

  const previewService = require('../src/previewService');
  await assert.rejects(
    () => previewService.createImageMusicPreview({
      userId: 'test-user',
      imagePath,
      originalName: 'test.png',
      originalSize: 100,
      durationSeconds: 5,
      trackId: 'nonexistent-track',
      segmentStartSeconds: 0,
      focalX: 0.5,
      focalY: 0.5
    }, { registryPath, libraryDir, previewDir, manifestDir }),
    (error) => error.code === 'TRACK_NOT_FOUND'
  );
});

test('cleanup removes expired preview and manifest files', async (t) => {
  const dir = tempDir(t);
  const previewDir = path.join(dir, 'previews');
  const manifestDir = path.join(dir, 'previews', 'manifests');
  fs.mkdirSync(previewDir, { recursive: true });
  fs.mkdirSync(manifestDir, { recursive: true });

  // Create fake expired files
  const oldPreview = path.join(previewDir, 'preview-00000000-0000-4000-8000-000000000000.mp4');
  const oldManifest = path.join(manifestDir, 'preview-00000000-0000-4000-8000-000000000000.json');
  fs.writeFileSync(oldPreview, 'fake');
  fs.writeFileSync(oldManifest, '{}');
  // Set mtime to past
  const pastTime = new Date(Date.now() - config.mediaPreview.tokenTtlMs - 60_000);
  fs.utimesSync(oldPreview, pastTime, pastTime);
  fs.utimesSync(oldManifest, pastTime, pastTime);

  const previewService = require('../src/previewService');
  await previewService.cleanupExpiredPreviews({ previewDir, manifestDir });

  assert.equal(fs.existsSync(oldPreview), false, 'expired preview should be removed');
  assert.equal(fs.existsSync(oldManifest), false, 'expired manifest should be removed');
});

test('fails closed when token secret is empty', async (t) => {
  const origSecret = config.mediaPreview.tokenSecret;
  config.mediaPreview.tokenSecret = '';
  t.after(() => { config.mediaPreview.tokenSecret = origSecret; });

  const dir = tempDir(t);
  const imagePath = await createTestImage(dir);

  const previewService = require('../src/previewService');
  await assert.rejects(
    () => previewService.createImageMusicPreview({
      userId: 'test',
      imagePath,
      originalName: 'test.png',
      originalSize: 100,
      durationSeconds: 5,
      trackId: 'any',
      segmentStartSeconds: 0,
      focalX: 0.5,
      focalY: 0.5
    }, {}),
    (error) => error.code === 'PREVIEW_NOT_CONFIGURED'
  );
});
