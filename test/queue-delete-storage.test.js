'use strict';

// storage.deletePost — the single Firestore delete path used by the admin
// queue (unscoped: any channel this user owns, including legacy jobs) and
// the client portal (channel-scoped). Covers the P0 regression set:
// missing posts, unauthorized posts, legacy ownership, channel scoping,
// and failed deletion.

const assert = require('node:assert/strict');
const test = require('node:test');

function installStorageMocks({ seededDocs = [], seededCollections = {}, failDeleteIds = [] } = {}) {
  const firestorePath = require.resolve('../src/firestore');
  const cloudinaryPath = require.resolve('../src/cloudinary');
  const storagePath = require.resolve('../src/storage');
  const mapperPath = require.resolve('../src/postsMapper');
  delete require.cache[storagePath];
  delete require.cache[mapperPath];

  const docs = new Map(seededDocs.map((docData) => [docData.id, { ...docData }]));
  const stores = new Map([['posts', docs]]);
  for (const [collectionName, entries] of Object.entries(seededCollections)) {
    stores.set(collectionName, new Map(Object.entries(entries).map(([id, data]) => [id, { ...data }])));
  }
  const store = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name);
  };
  const deletions = [];
  const destroyed = [];
  const failSet = new Set(failDeleteIds);
  const timestamp = () => ({
    toDate: () => new Date('2026-07-10T12:00:00.000Z'),
    toMillis: () => Date.parse('2026-07-10T12:00:00.000Z')
  });

  require.cache[cloudinaryPath] = {
    id: cloudinaryPath,
    filename: cloudinaryPath,
    loaded: true,
    exports: {
      uploadMediaFile: async () => ({ mediaUrl: '', publicId: '', resourceType: '' }),
      destroyMediaAsset: async (publicId, resourceType) => {
        if (publicId) destroyed.push({ publicId, resourceType });
      },
      checkCloudinaryHealth: async () => ({ ok: true })
    }
  };

  function snapshot(collectionName, id) {
    const records = store(collectionName);
    return { id, exists: records.has(id), data: () => records.get(id) };
  }

  function documentReference(collectionName, id) {
    return {
      id,
      collectionName,
      path: `${collectionName}/${id}`,
      get: async () => snapshot(collectionName, id),
      update: async (patch) => store(collectionName).set(id, { ...(store(collectionName).get(id) || {}), ...patch }),
      delete: async () => {
        if (collectionName === 'posts') deletions.push(id);
        if (collectionName === 'posts' && failSet.has(id)) throw new Error('Firestore delete unavailable');
        store(collectionName).delete(id);
      }
    };
  }

  const postsCollection = {
    where: (field, operator, value) => {
      const matchingDocs = () => [...docs.entries()]
        .filter(([, data]) => operator === '==' ? data[field] === value : true)
        .map(([id, data]) => ({ id, data: () => data }));
      const query = {
        get: async () => {
          const result = matchingDocs();
          return { docs: result, empty: result.length === 0 };
        },
        select: () => ({ get: async () => ({ docs: [] }) }),
        limit: (count) => ({
          get: async () => {
            const result = matchingDocs().slice(0, count);
            return { docs: result, empty: result.length === 0 };
          }
        })
      };
      return query;
    },
    doc: (id) => documentReference('posts', id)
  };

  const db = {
    collection: (name) => ({ doc: (id) => documentReference(name, id) }),
    batch: () => ({ set: () => {}, update: () => {}, commit: async () => {} }),
    async runTransaction(callback) {
      const pending = [];
      const result = await callback({
        get: async (ref) => snapshot(ref.collectionName, ref.id),
        create(ref, data) { pending.push({ type: 'create', ref, data }); },
        update(ref, data) { pending.push({ type: 'update', ref, data }); },
        delete(ref) { pending.push({ type: 'delete', ref }); }
      });
      for (const operation of pending) {
        const records = store(operation.ref.collectionName);
        if (operation.type === 'create' && records.has(operation.ref.id)) throw new Error('already exists');
        if (operation.type === 'update' && !records.has(operation.ref.id)) throw new Error('missing update target');
        if (
          operation.type === 'delete'
          && operation.ref.collectionName === 'posts'
          && failSet.has(operation.ref.id)
        ) throw new Error('Firestore delete unavailable');
      }
      for (const operation of pending) {
        const records = store(operation.ref.collectionName);
        if (operation.type === 'delete') {
          if (operation.ref.collectionName === 'posts') deletions.push(operation.ref.id);
          records.delete(operation.ref.id);
        } else if (operation.type === 'update') {
          records.set(operation.ref.id, { ...records.get(operation.ref.id), ...operation.data });
        } else {
          records.set(operation.ref.id, { ...operation.data });
        }
      }
      return result;
    }
  };

  require.cache[firestorePath] = {
    id: firestorePath,
    filename: firestorePath,
    loaded: true,
    exports: {
      postsCollection: () => postsCollection,
      configDoc: () => ({ get: async () => ({ exists: true, data: () => ({ dailyPostTime: '09:00' }) }) }),
      getFirestore: () => db,
      Timestamp: { now: () => timestamp(), fromDate: () => timestamp() },
      FieldValue: { serverTimestamp: () => timestamp(), increment: () => 1 }
    }
  };

  const cleanup = () => {
    for (const modulePath of [storagePath, mapperPath, firestorePath, cloudinaryPath]) {
      delete require.cache[modulePath];
    }
  };

  return {
    storage: require('../src/storage'),
    docs,
    stores,
    deletions,
    destroyed,
    cleanup
  };
}

test('deletePost removes an owned post on any channel and destroys its own media', async (t) => {
  const { storage, docs, deletions, destroyed, cleanup } = installStorageMocks({
    seededDocs: [
      {
        id: 'job-other-channel', userId: 'owner', accountId: 'account-b',
        cloudinaryPublicId: 'uploads/asset-b', cloudinaryResourceType: 'video', fileName: 'asset-b.mp4'
      }
    ]
  });
  t.after(cleanup);

  // Unscoped (admin) delete: the post lives on a channel other than the
  // "active" one — it must still be deleted because the same user owns it.
  assert.equal(await storage.deletePost('owner', 'job-other-channel'), true);
  assert.deepEqual(deletions, ['job-other-channel']);
  assert.equal(docs.has('job-other-channel'), false);
  assert.deepEqual(destroyed, [{ publicId: 'uploads/asset-b', resourceType: 'video' }]);
});

test('deletePost deletes legacy jobs that predate channel assignment', async (t) => {
  const { storage, docs, cleanup } = installStorageMocks({
    seededDocs: [
      // No accountId at all — postFromDoc maps this to accountId "legacy".
      { id: 'job-legacy', userId: 'owner', fileName: 'legacy.jpg', mediaType: 'photo' }
    ]
  });
  t.after(cleanup);

  // Historical image posts stay deletable: mediaType is irrelevant to delete.
  assert.equal(await storage.deletePost('owner', 'job-legacy'), true);
  assert.equal(docs.has('job-legacy'), false);
});

test('deletePost fails closed for missing and unauthorized posts', async (t) => {
  const { storage, docs, deletions, destroyed, cleanup } = installStorageMocks({
    seededDocs: [
      { id: 'job-foreign', userId: 'someone-else', accountId: 'account-a', cloudinaryPublicId: 'uploads/foreign' }
    ]
  });
  t.after(cleanup);

  assert.equal(await storage.deletePost('owner', 'job-missing'), false);
  assert.equal(await storage.deletePost('owner', 'job-foreign'), false);
  assert.equal(await storage.deletePost('owner', ''), false);
  assert.deepEqual(deletions, [], 'no Firestore delete was attempted');
  assert.deepEqual(destroyed, [], 'no media was destroyed');
  assert.equal(docs.has('job-foreign'), true, 'the other user\'s post is untouched');
});

test('deletePost never physically deletes published or logically archived history', async (t) => {
  const archive = {
    schemaVersion: 'chanter.autoposter.operational-archive.v1',
    state: 'archived',
    operationId: 'operation-local',
    archivedAt: '2026-07-28T12:00:00.000Z',
    archivedBy: 'founder:local-fixture',
    classification: 'cancelled',
    candidateSetHash: 'a'.repeat(64),
    recoverable: true
  };
  const { storage, docs, deletions, cleanup } = installStorageMocks({
    seededDocs: [
      { id: 'job-published', userId: 'owner', accountId: 'account-a', status: 'posted' },
      {
        id: 'job-archived',
        userId: 'owner',
        accountId: 'account-a',
        status: 'cancelled',
        operationalArchive: archive
      }
    ]
  });
  t.after(cleanup);

  await assert.rejects(
    storage.deletePost('owner', 'job-published'),
    (error) => error.code === 'published_history_protected' && error.status === 409
  );
  await assert.rejects(
    storage.deletePost('owner', 'job-archived'),
    (error) => error.code === 'published_history_protected' && error.status === 409
  );
  assert.equal(docs.has('job-published'), true);
  assert.equal(docs.has('job-archived'), true);
  assert.deepEqual(deletions, []);
});

test('deletePost keeps the channel-scoped contract used by the client portal', async (t) => {
  const { storage, docs, cleanup } = installStorageMocks({
    seededDocs: [
      { id: 'job-a', userId: 'owner', accountId: 'account-a' },
      { id: 'job-b', userId: 'owner', accountId: 'account-b' }
    ]
  });
  t.after(cleanup);

  // A session scoped to account-a can never delete account-b's post…
  assert.equal(await storage.deletePost('owner', 'job-b', 'account-a'), false);
  assert.equal(docs.has('job-b'), true);
  // …but deletes its own.
  assert.equal(await storage.deletePost('owner', 'job-a', 'account-a'), true);
  assert.equal(docs.has('job-a'), false);
});

test('deletePost propagates a failed Firestore delete instead of claiming success', async (t) => {
  const { storage, docs, destroyed, cleanup } = installStorageMocks({
    seededDocs: [
      { id: 'job-flaky', userId: 'owner', accountId: 'account-a', cloudinaryPublicId: 'uploads/flaky' }
    ],
    failDeleteIds: ['job-flaky']
  });
  t.after(cleanup);

  await assert.rejects(storage.deletePost('owner', 'job-flaky'), /Firestore delete unavailable/);
  assert.equal(docs.has('job-flaky'), true, 'the post is still there after the failure');
  assert.deepEqual(destroyed, [], 'media is not destroyed when the document delete failed');
});

test('deletePost preserves a shared recurring media asset until the final reference is removed', async (t) => {
  const { storage, destroyed, cleanup } = installStorageMocks({
    seededDocs: [
      {
        id: 'series-job-1', userId: 'owner', accountId: 'account-a', status: 'scheduled',
        cloudinaryPublicId: 'uploads/shared-series', cloudinaryResourceType: 'video',
        fileName: 'shared-series.mp4', sharedMediaAsset: true
      },
      {
        id: 'series-job-2', userId: 'owner', accountId: 'account-a', status: 'scheduled',
        cloudinaryPublicId: 'uploads/shared-series', cloudinaryResourceType: 'video',
        fileName: 'shared-series.mp4', sharedMediaAsset: true
      }
    ]
  });
  t.after(cleanup);

  assert.equal(await storage.deletePost('owner', 'series-job-1'), true);
  assert.deepEqual(destroyed, [], 'the first delete must keep the shared asset alive');

  assert.equal(await storage.deletePost('owner', 'series-job-2'), true);
  assert.deepEqual(destroyed, [
    { publicId: 'uploads/shared-series', resourceType: 'video' }
  ]);
});
