'use strict';

process.env.AUTO_MUSIC_TOKEN_SECRET = 'test-preview-renderer-secret';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ffmpegPath = require('ffmpeg-static');
const { runProcess } = require('../src/autoCaption');
const config = require('../src/config');
const { PREVIEW_DURATIONS, validatePreviewRequest, renderImageMusicPreview } = require('../src/previewRenderer');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chanter-preview-renderer-test-'));
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

async function createTestTrack(dir, name = 'test-track.mp3', durationSeconds = 18) {
  const trackPath = path.join(dir, name);
  await runProcess(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
    '-t', String(durationSeconds),
    '-c:a', 'libmp3lame', '-b:a', '96k',
    '-y', trackPath
  ], { timeoutMs: 30_000 });
  return trackPath;
}

test('PREVIEW_DURATIONS is frozen [5, 10, 15]', () => {
  assert.deepEqual(PREVIEW_DURATIONS, [5, 10, 15]);
  assert.ok(Object.isFrozen(PREVIEW_DURATIONS));
});

test('validatePreviewRequest rejects invalid durations', () => {
  const result = validatePreviewRequest({
    imagePath: 'test.png',
    trackPath: 'test.mp3',
    durationSeconds: 7,
    segmentStartSeconds: 0,
    focalX: 0.5,
    focalY: 0.5
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('durationSeconds')));
});

test('validatePreviewRequest accepts valid 5/10/15 durations', () => {
  for (const d of [5, 10, 15]) {
    const result = validatePreviewRequest({
      imagePath: 'test.png',
      trackPath: 'test.mp3',
      durationSeconds: d,
      segmentStartSeconds: 0,
      focalX: 0.5,
      focalY: 0.5
    });
    assert.equal(result.valid, true, `duration ${d} should be valid`);
  }
});

test('validatePreviewRequest rejects non-image extensions', () => {
  const result = validatePreviewRequest({
    imagePath: 'video.mp4',
    trackPath: 'test.mp3',
    durationSeconds: 5,
    segmentStartSeconds: 0,
    focalX: 0.5,
    focalY: 0.5
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('Image')));
});

test('renders 5s, 10s, 15s previews at 1080x1920 with H.264+AAC', async (t) => {
  const dir = tempDir(t);
  const previewDir = path.join(dir, 'previews');
  fs.mkdirSync(previewDir, { recursive: true });
  const imagePath = await createTestImage(dir);
  const trackPath = await createTestTrack(dir, 'track.mp3', 18);

  // Override config for isolated test
  const origPreviewDir = config.mediaPreview.previewDir;
  config.mediaPreview.previewDir = previewDir;
  t.after(() => { config.mediaPreview.previewDir = origPreviewDir; });

  for (const duration of [5, 10, 15]) {
    const outputPath = path.join(previewDir, `preview-${duration}s.mp4`);
    const result = await renderImageMusicPreview({
      imagePath,
      trackPath,
      durationSeconds: duration,
      segmentStartSeconds: 0,
      focalX: 0.5,
      focalY: 0.5,
      outputPath
    }, { timeoutMs: 60_000 });

    assert.equal(result.width, 1080);
    assert.equal(result.height, 1920);
    assert.equal(result.frameRate, 30);
    assert.equal(result.durationSeconds, duration);
    assert.ok(result.durationDiffSeconds < 0.2, `drift ${result.durationDiffSeconds} < 0.2`);
    assert.ok(result.size > 1000);
    assert.ok(fs.existsSync(outputPath));

    // Probe output to verify codec and dimensions
    const probeResult = await runProcess(require('ffprobe-static').path, [
      '-v', 'error',
      '-show_streams',
      '-of', 'json',
      outputPath
    ], { timeoutMs: 30_000 });
    const streams = JSON.parse(probeResult.stdout).streams;
    const video = streams.find((s) => s.codec_type === 'video');
    const audio = streams.find((s) => s.codec_type === 'audio');

    assert.equal(Number(video.width), 1080);
    assert.equal(Number(video.height), 1920);
    assert.equal(video.codec_name, 'h264');
    assert.equal(audio.codec_name, 'aac');
  }
});

test('focal point (0.5, 0.5) centers the crop', async (t) => {
  const dir = tempDir(t);
  const previewDir = path.join(dir, 'previews');
  fs.mkdirSync(previewDir, { recursive: true });
  const imagePath = await createTestImage(dir);
  const trackPath = await createTestTrack(dir, 'track.mp3', 8);

  const origPreviewDir = config.mediaPreview.previewDir;
  config.mediaPreview.previewDir = previewDir;
  t.after(() => { config.mediaPreview.previewDir = origPreviewDir; });

  const outputPath = path.join(previewDir, 'center-crop.mp4');
  const result = await renderImageMusicPreview({
    imagePath, trackPath, durationSeconds: 5, segmentStartSeconds: 0,
    focalX: 0.5, focalY: 0.5, outputPath
  }, { timeoutMs: 60_000 });

  assert.equal(result.focalX, 0.5);
  assert.equal(result.focalY, 0.5);
  assert.equal(result.width, 1080);
  assert.equal(result.height, 1920);
});

test('focal point (0, 0) anchors at top-left safely', async (t) => {
  const dir = tempDir(t);
  const previewDir = path.join(dir, 'previews');
  fs.mkdirSync(previewDir, { recursive: true });
  const imagePath = await createTestImage(dir);
  const trackPath = await createTestTrack(dir, 'track.mp3', 8);

  const origPreviewDir = config.mediaPreview.previewDir;
  config.mediaPreview.previewDir = previewDir;
  t.after(() => { config.mediaPreview.previewDir = origPreviewDir; });

  const outputPath = path.join(previewDir, 'topleft-crop.mp4');
  const result = await renderImageMusicPreview({
    imagePath, trackPath, durationSeconds: 5, segmentStartSeconds: 0,
    focalX: 0, focalY: 0, outputPath
  }, { timeoutMs: 60_000 });

  assert.equal(result.focalX, 0);
  assert.equal(result.focalY, 0);
  assert.equal(result.width, 1080);
  assert.equal(result.height, 1920);
});

test('focal point (1, 1) anchors at bottom-right safely', async (t) => {
  const dir = tempDir(t);
  const previewDir = path.join(dir, 'previews');
  fs.mkdirSync(previewDir, { recursive: true });
  const imagePath = await createTestImage(dir);
  const trackPath = await createTestTrack(dir, 'track.mp3', 8);

  const origPreviewDir = config.mediaPreview.previewDir;
  config.mediaPreview.previewDir = previewDir;
  t.after(() => { config.mediaPreview.previewDir = origPreviewDir; });

  const outputPath = path.join(previewDir, 'botright-crop.mp4');
  const result = await renderImageMusicPreview({
    imagePath, trackPath, durationSeconds: 5, segmentStartSeconds: 0,
    focalX: 1, focalY: 1, outputPath
  }, { timeoutMs: 60_000 });

  assert.equal(result.focalX, 1);
  assert.equal(result.focalY, 1);
  assert.equal(result.width, 1080);
  assert.equal(result.height, 1920);
});

test('focal values outside [0,1] are clamped', async (t) => {
  const dir = tempDir(t);
  const previewDir = path.join(dir, 'previews');
  fs.mkdirSync(previewDir, { recursive: true });
  const imagePath = await createTestImage(dir);
  const trackPath = await createTestTrack(dir, 'track.mp3', 8);

  const origPreviewDir = config.mediaPreview.previewDir;
  config.mediaPreview.previewDir = previewDir;
  t.after(() => { config.mediaPreview.previewDir = origPreviewDir; });

  const outputPath = path.join(previewDir, 'clamped-crop.mp4');
  const result = await renderImageMusicPreview({
    imagePath, trackPath, durationSeconds: 5, segmentStartSeconds: 0,
    focalX: -0.5, focalY: 1.7, outputPath
  }, { timeoutMs: 60_000 });

  assert.equal(result.focalX, 0, 'negative focal clamped to 0');
  assert.equal(result.focalY, 1, 'focal > 1 clamped to 1');
  assert.equal(result.width, 1080);
  assert.equal(result.height, 1920);
});

test('segmentStartSeconds is applied', async (t) => {
  const dir = tempDir(t);
  const previewDir = path.join(dir, 'previews');
  fs.mkdirSync(previewDir, { recursive: true });
  const imagePath = await createTestImage(dir);
  const trackPath = await createTestTrack(dir, 'track.mp3', 18);

  const origPreviewDir = config.mediaPreview.previewDir;
  config.mediaPreview.previewDir = previewDir;
  t.after(() => { config.mediaPreview.previewDir = origPreviewDir; });

  const outputPath = path.join(previewDir, 'segment-start.mp4');
  const result = await renderImageMusicPreview({
    imagePath, trackPath, durationSeconds: 5, segmentStartSeconds: 5,
    focalX: 0.5, focalY: 0.5, outputPath
  }, { timeoutMs: 60_000 });

  assert.equal(result.segmentStartSeconds, 5);
  assert.equal(result.durationSeconds, 5);
  assert.ok(result.durationDiffSeconds < 0.2);
});

test('rejects segment overflow', async (t) => {
  const dir = tempDir(t);
  const previewDir = path.join(dir, 'previews');
  fs.mkdirSync(previewDir, { recursive: true });
  const imagePath = await createTestImage(dir);
  const trackPath = await createTestTrack(dir, 'track.mp3', 8);

  const origPreviewDir = config.mediaPreview.previewDir;
  config.mediaPreview.previewDir = previewDir;
  t.after(() => { config.mediaPreview.previewDir = origPreviewDir; });

  await assert.rejects(
    () => renderImageMusicPreview({
      imagePath, trackPath, durationSeconds: 10, segmentStartSeconds: 5,
      focalX: 0.5, focalY: 0.5,
      outputPath: path.join(previewDir, 'overflow.mp4')
    }, { timeoutMs: 60_000 }),
    (error) => error.code === 'SEGMENT_OVERFLOW'
  );
});

test('rejects output path that overwrites source', async (t) => {
  const dir = tempDir(t);
  const previewDir = path.join(dir, 'previews');
  fs.mkdirSync(previewDir, { recursive: true });
  const imagePath = await createTestImage(dir);
  const trackPath = await createTestTrack(dir, 'track.mp3', 8);

  const origPreviewDir = config.mediaPreview.previewDir;
  config.mediaPreview.previewDir = previewDir;
  t.after(() => { config.mediaPreview.previewDir = origPreviewDir; });

  await assert.rejects(
    () => renderImageMusicPreview({
      imagePath, trackPath, durationSeconds: 5, segmentStartSeconds: 0,
      focalX: 0.5, focalY: 0.5,
      outputPath: imagePath
    }, { timeoutMs: 60_000 }),
    (error) => error.code === 'OUTPUT_PATH_UNSAFE'
  );
});

test('rejects output path outside preview directory', async (t) => {
  const dir = tempDir(t);
  const previewDir = path.join(dir, 'previews');
  fs.mkdirSync(previewDir, { recursive: true });
  const imagePath = await createTestImage(dir);
  const trackPath = await createTestTrack(dir, 'track.mp3', 8);

  const origPreviewDir = config.mediaPreview.previewDir;
  config.mediaPreview.previewDir = previewDir;
  t.after(() => { config.mediaPreview.previewDir = origPreviewDir; });

  await assert.rejects(
    () => renderImageMusicPreview({
      imagePath, trackPath, durationSeconds: 5, segmentStartSeconds: 0,
      focalX: 0.5, focalY: 0.5,
      outputPath: path.join(dir, 'escape.mp4')
    }, { timeoutMs: 60_000 }),
    (error) => error.code === 'OUTPUT_PATH_UNSAFE'
  );
});

test('cleans up partial output on FFmpeg failure', async (t) => {
  const dir = tempDir(t);
  const previewDir = path.join(dir, 'previews');
  fs.mkdirSync(previewDir, { recursive: true });
  const trackPath = await createTestTrack(dir, 'track.mp3', 8);
  // Create a non-image file to trigger FFmpeg failure
  const badImage = path.join(dir, 'bad.png');
  fs.writeFileSync(badImage, 'not an image');

  const origPreviewDir = config.mediaPreview.previewDir;
  config.mediaPreview.previewDir = previewDir;
  t.after(() => { config.mediaPreview.previewDir = origPreviewDir; });

  const outputPath = path.join(previewDir, 'should-not-exist.mp4');
  await assert.rejects(
    () => renderImageMusicPreview({
      imagePath: badImage, trackPath, durationSeconds: 5, segmentStartSeconds: 0,
      focalX: 0.5, focalY: 0.5, outputPath
    }, { timeoutMs: 30_000 }),
    (error) => error.code === 'PREVIEW_RENDER_FAILED'
  );

  assert.equal(fs.existsSync(outputPath), false, 'partial output must be cleaned up');
});

test('probeVideoOutput enforces measured output contract and rejects violations', async () => {
  const { probeVideoOutput } = require('../src/previewRenderer');

  const validProbeJson = (overrides = {}) => JSON.stringify({
    streams: [
      { codec_type: 'video', width: 1080, height: 1920, codec_name: 'h264', avg_frame_rate: '30/1', duration: '5.000', ...overrides.video },
      { codec_type: 'audio', codec_name: 'aac', duration: '5.000', ...overrides.audio }
    ],
    format: { duration: '5.000' }
  });

  const mockRun = (jsonStr) => async () => ({ stdout: jsonStr, stderr: '' });

  // Valid probe returns measured values
  const validRes = await probeVideoOutput('fake.mp4', { runCommand: mockRun(validProbeJson()) });
  assert.equal(validRes.width, 1080);
  assert.equal(validRes.height, 1920);
  assert.equal(validRes.videoCodec, 'h264');
  assert.equal(validRes.audioCodec, 'aac');
  assert.equal(validRes.frameRate, 30);

  // Missing video stream
  await assert.rejects(
    () => probeVideoOutput('fake.mp4', { runCommand: mockRun(JSON.stringify({ streams: [{ codec_type: 'audio', codec_name: 'aac' }] })) }),
    (err) => err.code === 'PREVIEW_PROBE_FAILED' && err.message.includes('No video stream')
  );

  // Missing audio stream
  await assert.rejects(
    () => probeVideoOutput('fake.mp4', { runCommand: mockRun(JSON.stringify({ streams: [{ codec_type: 'video', width: 1080, height: 1920, codec_name: 'h264' }] })) }),
    (err) => err.code === 'PREVIEW_PROBE_FAILED' && err.message.includes('No audio stream')
  );

  // Invalid width
  await assert.rejects(
    () => probeVideoOutput('fake.mp4', { runCommand: mockRun(validProbeJson({ video: { width: 720 } })) }),
    (err) => err.code === 'PREVIEW_PROBE_FAILED' && err.message.includes('width 720')
  );

  // Invalid height
  await assert.rejects(
    () => probeVideoOutput('fake.mp4', { runCommand: mockRun(validProbeJson({ video: { height: 1080 } })) }),
    (err) => err.code === 'PREVIEW_PROBE_FAILED' && err.message.includes('height 1080')
  );

  // Invalid video codec
  await assert.rejects(
    () => probeVideoOutput('fake.mp4', { runCommand: mockRun(validProbeJson({ video: { codec_name: 'hevc' } })) }),
    (err) => err.code === 'PREVIEW_PROBE_FAILED' && err.message.includes('hevc')
  );

  // Invalid audio codec
  await assert.rejects(
    () => probeVideoOutput('fake.mp4', { runCommand: mockRun(validProbeJson({ audio: { codec_name: 'mp3' } })) }),
    (err) => err.code === 'PREVIEW_PROBE_FAILED' && err.message.includes('mp3')
  );

  // Invalid frame rate
  await assert.rejects(
    () => probeVideoOutput('fake.mp4', { runCommand: mockRun(validProbeJson({ video: { avg_frame_rate: '60/1' } })) }),
    (err) => err.code === 'PREVIEW_PROBE_FAILED' && err.message.includes('frame rate 60')
  );
});
