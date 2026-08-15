'use strict';

// Runtime media staging seam. This is the only way bytes that did not arrive
// over a customer HTTP session can enter canonical staged media, so the test
// pins the whole refusal surface (token, configuration, durability
// acknowledgement, media policy, intake identity) alongside the accept path,
// exact replay, and immutable-intake conflict.

process.env.RUNTIME_CONTROL_TOKEN = 'test-runtime-token-1234567890';
process.env.PLATFORM_CANONICAL_MEDIA_REFERENCE_SECRET = 'runtime-staged-reference-test-secret-1234567890';
process.env.PLATFORM_CANONICAL_STAGING_PERSISTENT = 'true';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const express = require('express');

const config = require('../src/config');
const runtimeControlRoutes = require('../src/runtimeControlRoutes');
const { REFERENCE_PREFIX, createCanonicalStagedMedia } = require('../src/canonicalStagedMedia');

const TOKEN = 'test-runtime-token-1234567890';
const INTAKE_ID = `runtime-media-${'a'.repeat(40)}`;

function stagedMediaReader() {
  return createCanonicalStagedMedia({
    rootDir: config.canonicalExecution.stagedMediaDir,
    secret: config.canonicalExecution.mediaReferenceSecret
  });
}

test('runtime media staging: refusals, staging, exact replay, intake conflict', async (t) => {
  const app = express();
  app.use('/api/runtime', runtimeControlRoutes);
  app.use((error, req, res, next) => {
    if (!error) { next(); return; }
    res.status(error.status || 500).json({ ok: false, reason: error.message || 'Unexpected server error' });
  });

  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-media-stage-'));
  t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));
  t.after(() => fs.rmSync(path.join(config.canonicalExecution.stagedMediaDir, INTAKE_ID), {
    recursive: true,
    force: true
  }));

  const stage = ({
    token = TOKEN,
    intakeId = INTAKE_ID,
    bytes = Buffer.from('runtime-staged-video-bytes'),
    fileName = 'above-the-city.mp4',
    mimeType = 'video/mp4'
  } = {}) => {
    const form = new FormData();
    form.set('intakeId', intakeId);
    form.set('video', new Blob([bytes], { type: mimeType }), fileName);
    return fetch(`${baseUrl}/api/runtime/media/stage`, {
      method: 'POST',
      headers: { ...(token === null ? {} : { 'x-chanter-runtime-token': token }), Accept: 'application/json' },
      body: form
    });
  };

  // ── The runtime token gate applies here exactly as on every other route ──
  for (const token of [null, 'wrong-token']) {
    const refused = await stage({ token });
    assert.equal(refused.status, 401);
    assert.equal((await refused.json()).code, 'unauthorized');
  }

  // ── Unsigned staging cannot mint a reference anyone would trust ─────────
  const configuredSecret = config.canonicalExecution.mediaReferenceSecret;
  config.canonicalExecution.mediaReferenceSecret = '';
  const unsigned = await stage();
  assert.equal(unsigned.status, 503);
  assert.equal((await unsigned.json()).code, 'canonical_execution_unavailable');
  config.canonicalExecution.mediaReferenceSecret = configuredSecret;

  // ── Accepting bytes we promise to retain requires a durable staging root ─
  const acknowledged = config.canonicalExecution.persistentStagingAcknowledged;
  config.canonicalExecution.persistentStagingAcknowledged = false;
  const ephemeral = await stage();
  assert.equal(ephemeral.status, 503);
  assert.equal((await ephemeral.json()).code, 'staged_media_not_persistent');
  config.canonicalExecution.persistentStagingAcknowledged = acknowledged;

  // ── Intake identity is the immutability anchor, so it is validated first ─
  for (const intakeId of ['', 'runtime-media-short', `platform-autoposter-${'a'.repeat(40)}`, '../escape']) {
    const invalid = await stage({ intakeId });
    assert.equal(invalid.status, 400, `intakeId ${JSON.stringify(intakeId)} must be refused`);
    assert.equal((await invalid.json()).code, 'staged_media_intake_invalid');
  }

  // ── Runtime intake stays video-only, like every other creation path ─────
  const image = await stage({ fileName: 'cover.png', mimeType: 'image/png' });
  assert.equal(image.status, 400);
  assert.equal((await image.json()).code, 'staged_media_invalid');

  // ── Accept path: one signed reference plus the exact media identity ─────
  const videoBytes = Buffer.from('runtime-staged-video-bytes');
  const accepted = await stage({ bytes: videoBytes });
  assert.equal(accepted.status, 201);
  const acceptedBody = await accepted.json();
  assert.equal(acceptedBody.ok, true);
  assert.equal(acceptedBody.replayed, false);
  assert.ok(acceptedBody.reference.startsWith(REFERENCE_PREFIX));
  assert.equal(acceptedBody.media.byteSize, videoBytes.length);
  assert.equal(acceptedBody.media.mimeType, 'video/mp4');
  assert.equal(acceptedBody.media.extension, '.mp4');
  assert.equal(acceptedBody.media.fileName, 'above-the-city.mp4');
  assert.match(acceptedBody.media.sha256, /^[a-f0-9]{64}$/);

  // The reference must verify under the real signing secret and carry the
  // runtime intake identity, not a platform command identity.
  const parsed = stagedMediaReader().parseReference(acceptedBody.reference);
  assert.equal(parsed.commandId, INTAKE_ID);
  assert.equal(parsed.sha256, acceptedBody.media.sha256);

  // ── Exact replay returns the same reference and stages nothing new ──────
  const replay = await stage({ bytes: videoBytes });
  assert.equal(replay.status, 200);
  const replayBody = await replay.json();
  assert.equal(replayBody.replayed, true);
  assert.equal(replayBody.reference, acceptedBody.reference);
  assert.equal(replayBody.media.sha256, acceptedBody.media.sha256);

  // ── Changed bytes under the same intake conflict; they never replace ────
  const conflict = await stage({ bytes: Buffer.from('different-video-bytes-entirely') });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).code, 'intake_media_conflict');
  assert.equal(
    stagedMediaReader().parseReference(acceptedBody.reference).sha256,
    acceptedBody.media.sha256,
    'the original staged identity must survive a conflicting intake'
  );

  // ── The disposable multer copy is never left behind ─────────────────────
  const leaked = fs.readdirSync(config.uploadsDir).filter((name) => name.startsWith('runtime-media-'));
  assert.deepEqual(leaked, [], 'runtime staging must not leak temporary upload copies');
});
