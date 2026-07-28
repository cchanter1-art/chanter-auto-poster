'use strict';

process.env.ADMIN_PASSWORD = 'canonical-route-admin-password';
process.env.PLATFORM_CANONICAL_EXECUTION_ENABLED = 'true';
process.env.PLATFORM_CANONICAL_STAGING_PERSISTENT = 'true';
process.env.PLATFORM_CANONICAL_MEDIA_REFERENCE_SECRET = 'canonical-route-media-reference-secret-1234567890';
process.env.OPERATOR_BASE_URL = 'http://127.0.0.1:4010';
process.env.OPERATOR_MISSION_SUBMIT_TOKEN = 'canonical-route-submit-token';
process.env.OPERATOR_CONTROL_TOKEN = 'canonical-route-control-token';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const express = require('express');

const auth = require('../src/auth');
auth.requireAdminPage = (req, res, next) => next();
auth.requireAdminApi = (req, res, next) => next();
auth.resolveUserId = () => 'owner';

const config = require('../src/config');
const autoMusic = require('../src/autoMusic');
const batchService = require('../src/batchService');
const canonicalExecution = require('../src/platformCanonicalExecution');
const { OperatorCommandClientError } = require('../src/operatorAutoPosterCommandClient');

const directCalls = [];
const canonicalCalls = [];
const originalDirect = batchService.createBatch;
const originalCanonical = canonicalExecution.acceptComposerRequest;

batchService.createBatch = async (context, input) => {
  directCalls.push({ context, input });
  return {
    replayed: false,
    batch: { batchId: 'legacy-batch-1' },
    items: []
  };
};
canonicalExecution.acceptComposerRequest = async (context, input) => {
  canonicalCalls.push({ context, input });
  return {
    accepted: true,
    awaitingApproval: true,
    replayed: false,
    command: {
      commandId: `platform-autoposter-${'a'.repeat(40)}`,
      productState: 'draft_created',
      publicationApprovalState: 'human_required'
    }
  };
};

const platformRoutes = require('../src/platformRoutes');

test('batch intake chooses exactly one path and canonical failures never fall back', async (t) => {
  t.after(() => {
    batchService.createBatch = originalDirect;
    canonicalExecution.acceptComposerRequest = originalCanonical;
  });

  const app = express();
  app.use(platformRoutes);
  app.use((error, req, res, next) => {
    if (!error) { next(); return; }
    res.status(error.status || 500).json({ ok: false, reason: error.message || 'Unexpected error' });
  });
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const form = new FormData();
  form.append('videos', new Blob(['canonical-video'], { type: 'video/mp4' }), 'canonical.mp4');
  form.append('destinations', JSON.stringify([{
    provider: 'tiktok',
    accountId: 'account-a',
    soundMode: 'keep_original'
  }]));
  form.append('scheduleMode', 'interval');
  form.append('startDate', '2026-07-27');
  form.append('startTime', '09:00');
  form.append('timezoneName', 'Asia/Nicosia');
  form.append('timezoneOffsetMinutes', '-180');
  form.append('intakeKey', 'route-canonical-1');
  form.append('requestedAt', '2026-07-26T10:00:00.000Z');

  const accepted = await fetch(`${baseUrl}/api/platform/batches`, {
    method: 'POST',
    headers: { Accept: 'application/json' },
    body: form
  });
  assert.equal(accepted.status, 201);
  const acceptedBody = await accepted.json();
  assert.equal(acceptedBody.ok, true);
  assert.equal(acceptedBody.accepted, true);
  assert.equal(acceptedBody.awaitingApproval, true);
  assert.equal(canonicalCalls.length, 1);
  assert.equal(directCalls.length, 0, 'enabled request never dual-writes through createBatch');
  assert.equal(canonicalCalls[0].input.files.length, 1);
  assert.equal(
    fs.existsSync(canonicalCalls[0].input.files[0].path),
    false,
    'multer source is removed after canonical custody succeeds'
  );

  canonicalExecution.acceptComposerRequest = async (context, input) => {
    canonicalCalls.push({ context, input });
    return batchService.validateCanonicalSubmission(context, input);
  };
  const multiFileForm = new FormData();
  multiFileForm.append('videos', new Blob(['canonical-video-a'], { type: 'video/mp4' }), 'canonical-a.mp4');
  multiFileForm.append('videos', new Blob(['canonical-video-b'], { type: 'video/mp4' }), 'canonical-b.mp4');
  multiFileForm.append('destinations', JSON.stringify([{
    provider: 'tiktok',
    accountId: 'account-a',
    soundMode: 'keep_original'
  }]));
  multiFileForm.append('intakeKey', 'route-canonical-multi-file');
  const multiFile = await fetch(`${baseUrl}/api/platform/batches`, {
    method: 'POST',
    headers: { Accept: 'application/json' },
    body: multiFileForm
  });
  assert.equal(multiFile.status, 409);
  assert.equal((await multiFile.json()).code, 'canonical_scope_unsupported');
  assert.equal(canonicalCalls[1].input.files.length, 2, 'route preserves the true uploaded source count');
  assert.ok(
    canonicalCalls[1].input.files.every((file) => !fs.existsSync(file.path)),
    'every rejected upload is removed'
  );
  assert.equal(directCalls.length, 0);

  const originalBytes = Buffer.from('canonical-token-source');
  const renderedNames = [
    'auto-music-22222222-2222-4222-8222-222222222222.mp4',
    'auto-music-33333333-3333-4333-8333-333333333333.mp4'
  ];
  fs.mkdirSync(config.uploadsDir, { recursive: true });
  const renderedPaths = renderedNames.map((name, index) => {
    const filePath = path.join(config.uploadsDir, name);
    fs.writeFileSync(filePath, Buffer.from(`rendered-${index}`));
    return filePath;
  });
  t.after(() => renderedPaths.forEach((filePath) => fs.rmSync(filePath, { force: true })));
  const musicTokens = renderedNames.map((renderedFileName, index) => autoMusic.createPreparedMediaToken({
    userId: 'owner',
    originalName: 'canonical-token.mp4',
    originalSize: originalBytes.length,
    renderedFileName,
    renderedSize: fs.statSync(renderedPaths[index]).size,
    trackId: `track-${index}`
  }));
  const multiTokenForm = new FormData();
  multiTokenForm.append('videos', new Blob([originalBytes], { type: 'video/mp4' }), 'canonical-token.mp4');
  multiTokenForm.append('autoMusicTokens', JSON.stringify(musicTokens));
  multiTokenForm.append('destinations', JSON.stringify([{
    provider: 'tiktok',
    accountId: 'account-a',
    soundMode: 'keep_original'
  }]));
  multiTokenForm.append('intakeKey', 'route-canonical-multi-token');
  const multiToken = await fetch(`${baseUrl}/api/platform/batches`, {
    method: 'POST',
    headers: { Accept: 'application/json' },
    body: multiTokenForm
  });
  assert.equal(multiToken.status, 409);
  assert.equal((await multiToken.json()).code, 'canonical_scope_unsupported');
  assert.equal(canonicalCalls[2].input.files.length, 2, 'verified alternatives are not truncated to one');
  assert.ok(renderedPaths.every((filePath) => !fs.existsSync(filePath)), 'rejected derivatives are removed');
  assert.equal(directCalls.length, 0);

  canonicalExecution.acceptComposerRequest = async () => {
    throw new OperatorCommandClientError('Operator is offline.', {
      status: 503,
      code: 'operator_unavailable',
      retryable: true
    });
  };
  const failedForm = new FormData();
  failedForm.append('publicMediaUrl', 'https://cdn.example.com/failure.mp4');
  failedForm.append('destinations', JSON.stringify([{
    provider: 'tiktok',
    accountId: 'account-a',
    soundMode: 'keep_original'
  }]));
  failedForm.append('intakeKey', 'route-canonical-failure');
  const unavailable = await fetch(`${baseUrl}/api/platform/batches`, {
    method: 'POST',
    headers: { Accept: 'application/json' },
    body: failedForm
  });
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), {
    ok: false,
    code: 'operator_unavailable',
    reason: 'Operator is offline.',
    details: {},
    retryable: true
  });
  assert.equal(directCalls.length, 0, 'Operator failure never falls back to direct product creation');

  // Rollback gate: the same route preserves the exact legacy service path when
  // disabled, and does not also submit a command.
  config.canonicalExecution.enabled = false;
  canonicalExecution.acceptComposerRequest = originalCanonical;
  const legacyForm = new FormData();
  legacyForm.append('publicMediaUrl', 'https://cdn.example.com/legacy.mp4');
  legacyForm.append('destinations', JSON.stringify([{
    provider: 'tiktok',
    accountId: 'account-a',
    soundMode: 'keep_original'
  }]));
  legacyForm.append('intakeKey', 'route-legacy-1');
  const legacy = await fetch(`${baseUrl}/api/platform/batches`, {
    method: 'POST',
    headers: { Accept: 'application/json' },
    body: legacyForm
  });
  assert.equal(legacy.status, 201);
  assert.equal((await legacy.json()).batch.batchId, 'legacy-batch-1');
  assert.equal(directCalls.length, 1);
  assert.equal(canonicalCalls.length, 3);
});
