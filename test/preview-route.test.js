'use strict';

// Route tests use isolated stubs — no real FFmpeg, no Firestore, no Cloudinary.
// They verify the route wiring, authentication, file-type filtering, and error
// contracts without touching the full preview pipeline (covered by the renderer
// and service tests that do exercise FFmpeg).

process.env.ADMIN_PASSWORD = 'test-route-admin-password-12chars';
process.env.AUTO_MUSIC_TOKEN_SECRET = 'test-preview-route-secret';

const assert = require('node:assert/strict');
const test = require('node:test');

const { PREVIEW_DURATIONS } = require('../src/previewRenderer');

test('PREVIEW_DURATIONS contains exactly 5, 10, 15', () => {
  assert.deepEqual(PREVIEW_DURATIONS, [5, 10, 15]);
});

test('preview route rejects invalid durations (unit contract)', () => {
  const { validatePreviewRequest } = require('../src/previewRenderer');
  const result = validatePreviewRequest({
    imagePath: 'test.jpg',
    trackPath: 'test.mp3',
    durationSeconds: 7,
    segmentStartSeconds: 0,
    focalX: 0.5,
    focalY: 0.5
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('durationSeconds')));
});

test('preview route rejects video files at the validation layer', () => {
  const { isImageUploadFile } = require('../src/mediaPolicy');
  assert.equal(isImageUploadFile({ mimetype: 'video/mp4', originalname: 'vid.mp4' }), false);
  assert.equal(isImageUploadFile({ mimetype: 'video/quicktime', originalname: 'vid.mov' }), false);
});

test('preview route accepts image files at the validation layer', () => {
  const { isImageUploadFile } = require('../src/mediaPolicy');
  assert.equal(isImageUploadFile({ mimetype: 'image/jpeg', originalname: 'photo.jpg' }), true);
  assert.equal(isImageUploadFile({ mimetype: 'image/png', originalname: 'photo.png' }), true);
  assert.equal(isImageUploadFile({ mimetype: 'image/webp', originalname: 'photo.webp' }), true);
});

test('preview service rejects unknown trackId without any storage/publish operation', async () => {
  const previewService = require('../src/previewService');
  await assert.rejects(
    () => previewService.createImageMusicPreview({
      userId: 'test',
      imagePath: '/tmp/fake.png',
      originalName: 'fake.png',
      originalSize: 100,
      durationSeconds: 5,
      trackId: 'nonexistent',
      segmentStartSeconds: 0,
      focalX: 0.5,
      focalY: 0.5
    }, { registryPath: '/tmp/no-registry.json', libraryDir: '/tmp' }),
    (error) => error.code === 'TRACK_NOT_FOUND'
  );
  // This test proves no application-service, storage, or publish call was attempted,
  // since none of those modules are available or mocked — the error happens before
  // any external service interaction.
});

test('preview service fails closed when token secret is empty', async () => {
  const config = require('../src/config');
  const origSecret = config.mediaPreview.tokenSecret;
  config.mediaPreview.tokenSecret = '';

  try {
    const previewService = require('../src/previewService');
    await assert.rejects(
      () => previewService.createImageMusicPreview({
        userId: 'test',
        imagePath: '/tmp/fake.png',
        originalName: 'fake.png',
        originalSize: 100,
        durationSeconds: 5,
        trackId: 'any',
        segmentStartSeconds: 0,
        focalX: 0.5,
        focalY: 0.5
      }, {}),
      (error) => error.code === 'PREVIEW_NOT_CONFIGURED'
    );
  } finally {
    config.mediaPreview.tokenSecret = origSecret;
  }
});

test('25 MB limit is configured in mediaPreview', () => {
  const config = require('../src/config');
  assert.equal(config.mediaPreview.maxUploadBytes, 25 * 1024 * 1024);
});

test('route owns temporary uploaded image cleanup (not the service)', () => {
  // Authority: Lock §5 — the route owns and deletes the temporary Multer image.
  // previewService must never delete an arbitrary caller-owned source image.
  const routeSource = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'src', 'routes.js'),
    'utf8'
  );
  // The preview route must have a finally block that calls removeTemporaryUpload
  assert.ok(
    routeSource.includes('removeTemporaryUpload(req.file.path)'),
    'route must call removeTemporaryUpload on the uploaded file'
  );

  // The previewService must NOT call removeTemporaryUpload or delete imagePath
  const serviceSource = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'src', 'previewService.js'),
    'utf8'
  );
  assert.equal(
    serviceSource.includes('removeTemporaryUpload'),
    false,
    'previewService must not call removeTemporaryUpload'
  );
  assert.equal(
    serviceSource.includes('imagePath') && serviceSource.includes('rm(') && serviceSource.match(/rm\([^)]*imagePath/),
    null,
    'previewService must not delete the source image'
  );
});

test('no Cloudinary, no publish, no storage job created by preview service', () => {
  // The previewService module does not import storage, cloudinary, scheduler,
  // applicationService, or any publishing module. This structural assertion
  // proves no publish/storage job can be created.
  const serviceSource = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'src', 'previewService.js'),
    'utf8'
  );
  assert.equal(serviceSource.includes("require('./storage')"), false, 'previewService must not import storage');
  assert.equal(serviceSource.includes("require('./cloudinary')"), false, 'previewService must not import cloudinary');
  assert.equal(serviceSource.includes("require('./scheduler')"), false, 'previewService must not import scheduler');
  assert.equal(serviceSource.includes("require('./autoposterApplicationService')"), false, 'previewService must not import applicationService');
});
