'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

test('persists Cloudinary video URLs, enforces video-only intake, and keeps public URL fallback', async (t) => {
  const firestorePath = require.resolve('../src/firestore');
  const cloudinaryPath = require.resolve('../src/cloudinary');
  const storagePath = require.resolve('../src/storage');
  const mapperPath = require.resolve('../src/postsMapper');
  delete require.cache[storagePath];
  delete require.cache[mapperPath];

  const committed = [];
  const uploadCalls = [];
  const destroyed = [];
  const timestamp = { toDate: () => new Date('2026-06-20T12:00:00.000Z') };
  let uploadBehavior = async (file) => ({
    mediaUrl: file.mimetype.startsWith('video/')
      ? 'https://res.cloudinary.com/test/video/upload/video.mp4'
      : 'https://res.cloudinary.com/test/image/upload/image.jpg',
    publicId: file.mimetype.startsWith('video/') ? 'uploads/video' : 'uploads/image',
    resourceType: file.mimetype.startsWith('video/') ? 'video' : 'image'
  });

  require.cache[cloudinaryPath] = {
    id: cloudinaryPath,
    filename: cloudinaryPath,
    loaded: true,
    exports: {
      uploadMediaFile: async (file) => {
        uploadCalls.push(file);
        return uploadBehavior(file);
      },
      destroyMediaAsset: async (publicId, resourceType) => destroyed.push({ publicId, resourceType }),
      checkCloudinaryHealth: async ({ writeTest }) => ({
        ok: true,
        provider: 'cloudinary',
        writeTest: { requested: writeTest }
      })
    }
  };

  const postsCollection = {
    where: () => ({
      get: async () => ({ docs: [] }),
      select: () => ({ get: async () => ({ docs: [] }) })
    }),
    doc: (id) => ({ id })
  };
  require.cache[firestorePath] = {
    id: firestorePath,
    filename: firestorePath,
    loaded: true,
    exports: {
      postsCollection: () => postsCollection,
      configDoc: () => ({}),
      getFirestore: () => ({
        batch: () => ({
          set: (ref, data) => committed.push({ ref, data, method: 'set' }),
          create: (ref, data) => committed.push({ ref, data, method: 'create' }),
          commit: async () => {}
        })
      }),
      Timestamp: { now: () => timestamp, fromDate: (date) => ({ toDate: () => date }) },
      FieldValue: { serverTimestamp: () => timestamp, increment: () => 1 }
    }
  };

  const storage = require('../src/storage');
  const accountDefaults = { accountId: 'account-a', tiktokOpenId: 'account-a', username: 'account_a' };
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chanter-cloudinary-test-'));
  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    delete require.cache[storagePath];
    delete require.cache[mapperPath];
    delete require.cache[firestorePath];
    delete require.cache[cloudinaryPath];
  });

  const webmPath = path.join(tempDir, 'small.webm');
  const videoPath = path.join(tempDir, 'small.mp4');
  fs.writeFileSync(webmPath, Buffer.from('small-webm'));
  fs.writeFileSync(videoPath, Buffer.from('small-mp4'));

  const [webmPost] = await storage.addUploadedPosts('owner', [{
    path: webmPath,
    size: fs.statSync(webmPath).size,
    filename: 'small.webm',
    originalname: 'small.webm',
    mimetype: 'video/webm'
  }], accountDefaults);
  const [videoPost] = await storage.addUploadedPosts('owner', [{
    path: videoPath,
    size: fs.statSync(videoPath).size,
    filename: 'small.mp4',
    originalname: 'small.mp4',
    mimetype: 'video/mp4'
  }], accountDefaults);

  assert.equal(uploadCalls.length, 2);
  assert.equal(webmPost.mediaSource, 'cloudinary');
  assert.equal(webmPost.mediaUrl, 'https://res.cloudinary.com/test/video/upload/video.mp4');
  assert.equal(webmPost.mediaPath, webmPost.mediaUrl);
  assert.equal(webmPost.cloudinaryPublicId, 'uploads/video');
  assert.equal(webmPost.mediaStoragePath, '');
  assert.equal(webmPost.status, 'pending');
  assert.equal(webmPost.accountId, 'account-a');
  assert.equal(webmPost.tiktokOpenId, 'account-a');
  assert.equal(webmPost.username, 'account_a');
  assert.equal(webmPost.scheduledAt, null);
  assert.equal(committed[0].data.scheduledAt, null);
  assert.equal('scheduledTimeUTC' in committed[0].data, false);
  assert.equal(videoPost.mediaType, 'video');
  assert.equal(videoPost.mediaUrl, 'https://res.cloudinary.com/test/video/upload/video.mp4');
  assert.equal(videoPost.cloudinaryResourceType, 'video');

  const scheduledAt = '2026-07-12T09:00:00.000Z';
  const [runtimePost] = await storage.addUploadedPosts('owner', [], {
    ...accountDefaults,
    publicMediaUrl: 'https://cdn.example.com/runtime.mp4',
    scheduledAt,
    documentId: 'runtime-deterministic-id',
    createOnly: true,
    provider: 'tiktok',
    creationSource: 'runtime',
    createdBy: 'mcp-client',
    correlationId: 'trace-1',
    idempotencyKey: 'idem-1',
    runtimeIdempotencyKey: 'idem-1',
    runtimeScheduledBy: 'mcp-client'
  });
  const runtimeWrite = committed.at(-1);
  assert.equal(runtimeWrite.method, 'create');
  assert.equal(runtimeWrite.ref.id, 'runtime-deterministic-id');
  assert.equal(runtimePost.status, 'scheduled');
  assert.equal(runtimePost.scheduledAt, scheduledAt);
  assert.equal(runtimePost.provider, 'tiktok');
  assert.equal(runtimePost.creationSource, 'runtime');
  assert.equal(runtimePost.idempotencyKey, 'idem-1');
  assert.equal(runtimePost.approved, false);

  // Video-only intake: neither an image file nor an image URL can create a
  // new TikTok job, and nothing is uploaded for a rejected request.
  const imagePath = path.join(tempDir, 'small.jpg');
  fs.writeFileSync(imagePath, Buffer.from('small-image'));
  const uploadsBeforeRejection = uploadCalls.length;
  const committedBeforeRejection = committed.length;
  await assert.rejects(
    storage.addUploadedPosts('owner', [{
      path: imagePath,
      size: fs.statSync(imagePath).size,
      filename: 'small.jpg',
      originalname: 'small.jpg',
      mimetype: 'image/jpeg'
    }], accountDefaults),
    /video-only/i
  );
  await assert.rejects(
    storage.addUploadedPosts('owner', [], {
      ...accountDefaults,
      publicMediaUrl: 'https://cdn.example.com/photo.jpg'
    }),
    /video-only/i
  );
  assert.equal(uploadCalls.length, uploadsBeforeRejection, 'rejected image intake uploaded nothing');
  assert.equal(committed.length, committedBeforeRejection, 'rejected image intake committed nothing');

  const musicOriginalPath = path.join(tempDir, 'music-original.mov');
  const preparedPath = path.join(tempDir, 'auto-music-prepared.mp4');
  fs.writeFileSync(musicOriginalPath, Buffer.from('original-video'));
  fs.writeFileSync(preparedPath, Buffer.from('prepared-video'));
  const musicOriginal = {
    path: musicOriginalPath,
    size: fs.statSync(musicOriginalPath).size,
    filename: 'music-original.mov',
    originalname: 'music-original.mov',
    mimetype: 'video/quicktime'
  };
  const preparedMedia = {
    file: {
      path: preparedPath,
      size: fs.statSync(preparedPath).size,
      filename: 'auto-music-prepared.mp4',
      originalname: 'music-original.mov',
      mimetype: 'video/mp4'
    },
    originalName: musicOriginal.originalname,
    originalSize: musicOriginal.size,
    trackId: 'track-calm',
    trackCategory: 'motivation-calm',
    trackMood: 'calm uplifting'
  };
  const [musicPost] = await storage.addUploadedPosts('owner', [musicOriginal], {
    ...accountDefaults,
    preparedMedia
  });
  assert.equal(uploadCalls.at(-1).path, preparedPath);
  assert.equal(musicPost.autoMusicApplied, true);
  assert.equal(musicPost.mimeType, 'video/mp4');
  assert.equal(musicPost.musicTrackId, 'track-calm');
  assert.equal(musicPost.musicCategory, 'motivation-calm');

  const fallbackOriginalPath = path.join(tempDir, 'music-fallback.mov');
  const failedPreparedPath = path.join(tempDir, 'auto-music-failed.mp4');
  fs.writeFileSync(fallbackOriginalPath, Buffer.from('fallback-original-video'));
  fs.writeFileSync(failedPreparedPath, Buffer.from('failed-prepared-video'));
  const fallbackOriginal = {
    path: fallbackOriginalPath,
    size: fs.statSync(fallbackOriginalPath).size,
    filename: 'music-fallback.mov',
    originalname: 'music-fallback.mov',
    mimetype: 'video/quicktime'
  };
  uploadBehavior = async (file) => {
    if (file.path === failedPreparedPath) {
      const error = new Error('Prepared upload unavailable');
      error.code = 'CLOUDINARY_UPLOAD_FAILED';
      throw error;
    }
    return {
      mediaUrl: 'https://res.cloudinary.com/test/video/upload/original.mov',
      publicId: 'uploads/original',
      resourceType: 'video'
    };
  };
  const [originalFallbackPost] = await storage.addUploadedPosts('owner', [fallbackOriginal], {
    ...accountDefaults,
    preparedMedia: {
      file: {
        path: failedPreparedPath,
        size: fs.statSync(failedPreparedPath).size,
        filename: 'auto-music-failed.mp4',
        originalname: fallbackOriginal.originalname,
        mimetype: 'video/mp4'
      },
      originalName: fallbackOriginal.originalname,
      originalSize: fallbackOriginal.size,
      trackId: 'track-failed'
    }
  });
  assert.equal(uploadCalls.at(-2).path, failedPreparedPath);
  assert.equal(uploadCalls.at(-1).path, fallbackOriginalPath);
  assert.equal(originalFallbackPost.autoMusicApplied, false);
  assert.equal(originalFallbackPost.mediaUrl, 'https://res.cloudinary.com/test/video/upload/original.mov');

  // A LIST of prepared derivatives — what the canonical composer stages when
  // several files are uploaded at once. Each one may only ever replace the
  // exact source it was rendered from; an unmatched source keeps its original.
  // Every upload succeeds again, so the only thing under test below is which
  // file each source actually uploaded.
  uploadBehavior = async (file) => ({
    mediaUrl: `https://res.cloudinary.com/test/video/upload/${path.basename(file.path)}`,
    publicId: `uploads/${path.basename(file.path)}`,
    resourceType: 'video'
  });
  const listSourceAPath = path.join(tempDir, 'list-a.mov');
  const listSourceBPath = path.join(tempDir, 'list-b.mov');
  const listPreparedAPath = path.join(tempDir, 'list-a-prepared.mp4');
  fs.writeFileSync(listSourceAPath, Buffer.from('list-source-a'));
  fs.writeFileSync(listSourceBPath, Buffer.from('list-source-b-longer'));
  fs.writeFileSync(listPreparedAPath, Buffer.from('list-prepared-a'));
  const listSourceA = {
    path: listSourceAPath, size: fs.statSync(listSourceAPath).size,
    filename: 'list-a.mov', originalname: 'list-a.mov', mimetype: 'video/quicktime'
  };
  const listSourceB = {
    path: listSourceBPath, size: fs.statSync(listSourceBPath).size,
    filename: 'list-b.mov', originalname: 'list-b.mov', mimetype: 'video/quicktime'
  };
  const listPosts = await storage.addUploadedPosts('owner', [listSourceA, listSourceB], {
    ...accountDefaults,
    preparedMedia: [
      {
        file: {
          path: listPreparedAPath, size: fs.statSync(listPreparedAPath).size,
          filename: 'list-a-prepared.mp4', originalname: listSourceA.originalname, mimetype: 'video/mp4'
        },
        originalName: listSourceA.originalname,
        originalSize: listSourceA.size,
        trackId: 'track-list-a'
      },
      {
        // Same name as B but a different size: not the same file, so it must
        // NOT be substituted.
        file: {
          path: listPreparedAPath, size: 1,
          filename: 'stale.mp4', originalname: listSourceB.originalname, mimetype: 'video/mp4'
        },
        originalName: listSourceB.originalname,
        originalSize: listSourceB.size + 1,
        trackId: 'track-stale'
      }
    ]
  });
  const listByName = new Map(listPosts.map((post) => [post.originalName, post]));
  assert.equal(listByName.get('list-a.mov').autoMusicApplied, true, 'the exactly matched source is replaced');
  assert.equal(listByName.get('list-a.mov').musicTrackId, 'track-list-a');
  assert.equal(listByName.get('list-b.mov').autoMusicApplied, false, 'a size mismatch never substitutes media');
  assert.equal(listByName.get('list-b.mov').musicTrackId, '');

  const restoredWebmPost = require('../src/postsMapper').postFromDoc({
    id: committed[0].ref.id,
    data: () => committed[0].data
  });
  assert.equal(restoredWebmPost.mediaUrl, webmPost.mediaUrl);
  assert.equal(restoredWebmPost.cloudinaryPublicId, webmPost.cloudinaryPublicId);

  uploadBehavior = async () => {
    const error = new Error('Cloudinary unavailable');
    error.code = 'CLOUDINARY_UPLOAD_FAILED';
    throw error;
  };
  const [fallbackPost] = await storage.addUploadedPosts('owner', [{
    path: videoPath,
    size: fs.statSync(videoPath).size,
    filename: 'fallback.mp4',
    originalname: 'fallback.mp4',
    mimetype: 'video/mp4'
  }], { ...accountDefaults, publicMediaUrl: 'https://cdn.example.com/fallback.mp4' });
  assert.equal(fallbackPost.mediaSource, 'public_url');
  assert.equal(fallbackPost.storageFallback, true);
  assert.equal(fallbackPost.mediaUrl, 'https://cdn.example.com/fallback.mp4');

  const callsBeforeUrlOnly = uploadCalls.length;
  const [urlOnlyPost] = await storage.addUploadedPosts('owner', [], {
    ...accountDefaults,
    publicMediaUrl: 'https://cdn.example.com/public-only.mp4'
  });
  assert.equal(uploadCalls.length, callsBeforeUrlOnly);
  assert.equal(urlOnlyPost.mediaSource, 'public_url');
  // 7 from the original scenarios + 2 from the prepared-media list above.
  assert.equal(committed.length, 9);

  const health = await storage.checkMediaStorageHealth({ writeTest: true });
  assert.deepEqual(health, {
    ok: true,
    provider: 'cloudinary',
    writeTest: { requested: true }
  });
  assert.deepEqual(destroyed, []);
});
