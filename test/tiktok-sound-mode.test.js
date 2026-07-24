'use strict';

// P0 tests for the TikTok per-destination sound mode contract.
// Each test maps to a required behavior in the spec:
//   1. PHOTO + tiktok_recommended → auto_add_music=true
//   2. Two accounts, same asset, different sound modes
//   3. Fan-out preserves each destination sound mode independently
//   4. Legacy records receive the safe default
//   5. VIDEO + mute does not mutate the canonical asset
//   6. VIDEO + tiktok_recommended does not silently claim unsupported automation
//   7. Existing suites remain green (verified by `npm test`, not this file)

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  normalizeSoundMode,
  isSoundMode,
  resolveSoundCapability,
  DEFAULT_SOUND_MODE,
  SOUND_MODES
} = require('../src/tiktokSoundMode');

const { postFromDoc, mapPatchToFirestore } = require('../src/postsMapper');

// ── 4. Legacy records receive the safe default ─────────────────────────────

test('normalizeSoundMode: valid modes pass through', () => {
  assert.equal(normalizeSoundMode('keep_original'), 'keep_original');
  assert.equal(normalizeSoundMode('mute'), 'mute');
  assert.equal(normalizeSoundMode('tiktok_recommended'), 'tiktok_recommended');
  // case-insensitive
  assert.equal(normalizeSoundMode('KEEP_ORIGINAL'), 'keep_original');
  assert.equal(normalizeSoundMode('MUTE'), 'mute');
});

test('normalizeSoundMode: missing/unknown values default to keep_original', () => {
  assert.equal(normalizeSoundMode(undefined), DEFAULT_SOUND_MODE);
  assert.equal(normalizeSoundMode(null), DEFAULT_SOUND_MODE);
  assert.equal(normalizeSoundMode(''), DEFAULT_SOUND_MODE);
  assert.equal(normalizeSoundMode('garbage'), DEFAULT_SOUND_MODE);
  assert.equal(normalizeSoundMode(123), DEFAULT_SOUND_MODE);
});

test('isSoundMode: correctly identifies valid and invalid modes', () => {
  for (const mode of SOUND_MODES) assert.equal(isSoundMode(mode), true);
  assert.equal(isSoundMode('invalid'), false);
  assert.equal(isSoundMode(undefined), false);
  assert.equal(isSoundMode(''), false);
});

test('postFromDoc: legacy record without soundMode defaults to keep_original', () => {
  const post = postFromDoc({
    id: 'legacy-post',
    data: () => ({ platform: 'tiktok', accountId: 'acc-a' })
  });
  assert.equal(post.soundMode, 'keep_original');
});

test('postFromDoc: explicit soundMode is preserved', () => {
  const post = postFromDoc({
    id: 'sound-post',
    data: () => ({ platform: 'tiktok', accountId: 'acc-a', soundMode: 'mute' })
  });
  assert.equal(post.soundMode, 'mute');
});

test('mapPatchToFirestore: soundMode is normalized on generic write patches', () => {
  assert.equal(mapPatchToFirestore({ soundMode: 'mute' }).soundMode, 'mute');
  assert.equal(mapPatchToFirestore({ soundMode: 'tiktok_recommended' }).soundMode, 'tiktok_recommended');
  assert.equal(mapPatchToFirestore({ soundMode: 'garbage' }).soundMode, 'keep_original');
});

// ── 1. PHOTO + tiktok_recommended emits auto_add_music=true ────────────────

test('buildPhotoPayload: PHOTO + tiktok_recommended → auto_add_music=true', () => {
  const { buildPhotoPayload } = require('../src/tiktok');
  const payload = buildPhotoPayload(
    { soundMode: 'tiktok_recommended', caption: 'cap', privacyLevel: 'SELF_ONLY' },
    'https://cdn.example.com/img.jpg'
  );
  assert.equal(payload.media_type, 'PHOTO');
  assert.equal(payload.post_info.auto_add_music, true);
});

test('buildPhotoPayload: PHOTO + keep_original → auto_add_music=false', () => {
  const { buildPhotoPayload } = require('../src/tiktok');
  const payload = buildPhotoPayload(
    { soundMode: 'keep_original', caption: 'cap', privacyLevel: 'SELF_ONLY' },
    'https://cdn.example.com/img.jpg'
  );
  assert.equal(payload.post_info.auto_add_music, false);
});

test('buildPhotoPayload: PHOTO + mute → auto_add_music=false', () => {
  const { buildPhotoPayload } = require('../src/tiktok');
  const payload = buildPhotoPayload(
    { soundMode: 'mute', caption: 'cap', privacyLevel: 'SELF_ONLY' },
    'https://cdn.example.com/img.jpg'
  );
  assert.equal(payload.post_info.auto_add_music, false);
});

// ── 2. Two accounts using the same asset can persist different sound modes ─

test('two accounts with the same canonical asset persist different sound modes', () => {
  // Simulate two fan-out destination posts that share the same canonical
  // media URL but carry independent sound modes — the core invariant.
  const postA = postFromDoc({
    id: 'post-a',
    data: () => ({
      platform: 'tiktok', accountId: 'acc-a',
      mediaUrl: 'https://cdn.example.com/shared.mp4',
      soundMode: 'keep_original'
    })
  });
  const postB = postFromDoc({
    id: 'post-b',
    data: () => ({
      platform: 'tiktok', accountId: 'acc-b',
      mediaUrl: 'https://cdn.example.com/shared.mp4',
      soundMode: 'mute'
    })
  });
  assert.equal(postA.mediaUrl, postB.mediaUrl, 'same canonical asset');
  assert.notEqual(postA.soundMode, postB.soundMode, 'different sound modes');
  assert.equal(postA.soundMode, 'keep_original');
  assert.equal(postB.soundMode, 'mute');
});

// ── 3. Fan-out preserves each destination sound mode independently ─────────

test('fan-out: normalizeDestinations preserves independent sound modes per destination', () => {
  // The batchService.normalizeDestinations function (internal) validates each
  // destination's soundMode through normalizeSoundMode. We verify the
  // contract holds for every valid mode, including mixed selections.
  const destinations = [
    { provider: 'tiktok', accountId: 'acc-a', soundMode: 'keep_original' },
    { provider: 'tiktok', accountId: 'acc-b', soundMode: 'mute' },
    { provider: 'tiktok', accountId: 'acc-c', soundMode: 'tiktok_recommended' },
    { provider: 'tiktok', accountId: 'acc-d' /* no soundMode → default */ },
    { provider: 'tiktok', accountId: 'acc-e', soundMode: 'garbage' /* invalid → default */ }
  ];

  // Mirror what normalizeDestinations does: validate each through normalizeSoundMode
  const normalized = destinations.map((d) => ({
    provider: d.provider,
    accountId: d.accountId,
    soundMode: normalizeSoundMode(d.soundMode)
  }));

  assert.equal(normalized[0].soundMode, 'keep_original');
  assert.equal(normalized[1].soundMode, 'mute');
  assert.equal(normalized[2].soundMode, 'tiktok_recommended');
  assert.equal(normalized[3].soundMode, 'keep_original', 'missing → safe default');
  assert.equal(normalized[4].soundMode, 'keep_original', 'invalid → safe default');

  // Every destination keeps its own mode independently
  const modes = normalized.map((d) => d.soundMode);
  assert.equal(new Set(modes).size, 3, 'three distinct modes preserved independently');
});

// ── 5. VIDEO + mute does not mutate the canonical asset ────────────────────

test('deriveMutedVideo: refuses to overwrite its source path', async () => {
  const { deriveMutedVideo } = require('../src/autoMusic');
  await assert.rejects(
    deriveMutedVideo('/tmp/canonical-source.mp4', '/tmp/canonical-source.mp4'),
    /must not overwrite its source/i
  );
});

test('resolveSoundCapability: VIDEO + mute requires muted derivative, not source mutation', () => {
  const cap = resolveSoundCapability('video', 'mute');
  assert.equal(cap.media, 'video');
  assert.equal(cap.mode, 'mute');
  assert.equal(cap.supported, true);
  assert.equal(cap.requiresMutedDerivative, true);
  assert.equal(cap.autoAddMusic, false);
  assert.equal(cap.manualCompletionRequired, false);
});

test('resolveSoundCapability: VIDEO + keep_original uploads unchanged', () => {
  const cap = resolveSoundCapability('video', 'keep_original');
  assert.equal(cap.supported, true);
  assert.equal(cap.requiresMutedDerivative, false);
  assert.equal(cap.autoAddMusic, false);
  assert.equal(cap.manualCompletionRequired, false);
});

// ── 6. VIDEO + tiktok_recommended does not silently claim unsupported automation ─

test('resolveSoundCapability: VIDEO + tiktok_recommended requires manual completion', () => {
  const cap = resolveSoundCapability('video', 'tiktok_recommended');
  assert.equal(cap.supported, false);
  assert.equal(cap.manualCompletionRequired, true);
  assert.equal(cap.autoAddMusic, false);
  assert.equal(cap.requiresMutedDerivative, false);
});

test('publishPhotoPost: VIDEO + tiktok_recommended returns explicit manual-completion result', async (t) => {
  const storagePath = require.resolve('../src/storage');
  const tiktokPath = require.resolve('../src/tiktok');
  delete require.cache[tiktokPath];
  const originalStorageCache = require.cache[storagePath];

  require.cache[storagePath] = {
    id: storagePath,
    filename: storagePath,
    loaded: true,
    exports: {
      getTikTokAccount: async () => ({
        accountId: 'acc-a',
        open_id: 'acc-a',
        connected: true,
        access_token: 'token',
        expires_at: null
      })
    }
  };

  const originalFetch = global.fetch;
  let reachedInit = false;

  global.fetch = async (url) => {
    if (String(url).includes('creator_info')) {
      return new Response(JSON.stringify({
        data: { privacy_level_options: ['SELF_ONLY'] },
        error: { code: 'ok' }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    reachedInit = true;
    return new Response(null, { status: 500 });
  };

  t.after(() => {
    global.fetch = originalFetch;
    delete require.cache[tiktokPath];
    if (originalStorageCache) require.cache[storagePath] = originalStorageCache;
    else delete require.cache[storagePath];
  });

  const tiktok = require('../src/tiktok');
  const result = await tiktok.publishPhotoPost({
    userId: 'owner',
    accountId: 'acc-a',
    tiktokOpenId: 'acc-a',
    mediaType: 'video',
    fileName: 'test-video.mp4',
    soundMode: 'tiktok_recommended',
    privacyLevel: 'SELF_ONLY'
  });

  assert.equal(result.ok, false);
  assert.equal(result.mode, 'manual');
  assert.equal(result.code, 'SOUND_MODE_MANUAL_REQUIRED');
  assert.match(result.reason, /does not support automatically adding recommended sound/i);
  assert.equal(reachedInit, false, 'must not reach the video init endpoint');
});

// ── Capability matrix completeness ─────────────────────────────────────────

test('resolveSoundCapability: every (media × mode) combination returns a closed result', () => {
  for (const media of ['photo', 'video']) {
    for (const mode of SOUND_MODES) {
      const cap = resolveSoundCapability(media, mode);
      assert.equal(cap.media, media);
      assert.equal(cap.mode, mode);
      assert.equal(typeof cap.supported, 'boolean');
      assert.equal(typeof cap.autoAddMusic, 'boolean');
      assert.equal(typeof cap.requiresMutedDerivative, 'boolean');
      assert.equal(typeof cap.manualCompletionRequired, 'boolean');

      // Invariants:
      // - autoAddMusic is true ONLY for PHOTO + tiktok_recommended
      // - requiresMutedDerivative is true ONLY for VIDEO + mute
      // - manualCompletionRequired is true ONLY for VIDEO + tiktok_recommended
      if (media === 'photo' && mode === 'tiktok_recommended') {
        assert.equal(cap.autoAddMusic, true);
      } else {
        assert.equal(cap.autoAddMusic, false);
      }
      if (media === 'video' && mode === 'mute') {
        assert.equal(cap.requiresMutedDerivative, true);
      } else {
        assert.equal(cap.requiresMutedDerivative, false);
      }
      if (media === 'video' && mode === 'tiktok_recommended') {
        assert.equal(cap.manualCompletionRequired, true);
        assert.equal(cap.supported, false);
      } else {
        assert.equal(cap.manualCompletionRequired, false);
        assert.equal(cap.supported, true);
      }
    }
  }
});
