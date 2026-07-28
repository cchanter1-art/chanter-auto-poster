'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const admin = require('firebase-admin');
const {
  OperationalHistoryArchiveError,
  projectionCounts
} = require('../src/operationalHistoryArchive');
const {
  AUTHORITY_MODE,
  assertFirestoreEmulatorSafety,
  authorityDocumentId,
  createEmulatorFirestore,
  createFirestoreEmulatorArchiveCommandService
} = require('../src/operationalHistoryArchiveFirestore');
const { auditOperationalHistory } = require('../src/operationalHistoryAudit');
const platformStatus = require('../src/platformStatus');

const ROOT = path.join(__dirname, '..');
const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'operational-history-archive-state.json');
const NOW = '2026-07-28T12:00:00.000Z';
const APPROVAL_SECRET = 'emulator-founder-approval-secret-32-bytes-minimum';
const EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '';
const PROJECT_ID = process.env.GCLOUD_PROJECT || 'demo-chanter-autoposter-archive';

function fixture() {
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
}

function archiveIds(prefix) {
  return [
    `${prefix}archive-cancelled`,
    `${prefix}archive-legacy`,
    `${prefix}archive-published`
  ];
}

async function seedWorld(db, {
  ownerId,
  prefix,
  beforeArchiveRecord
}) {
  const state = fixture();
  state.authorityManifest = {
    ...state.authorityManifest,
    ownerId,
    mode: AUTHORITY_MODE,
    observedAt: '2026-07-28T11:55:00.000Z'
  };
  state.posts = state.posts.map((post) => ({
    ...post,
    id: `${prefix}${post.id}`,
    userId: ownerId
  }));
  for (const post of state.posts) {
    await db.collection('posts').doc(post.id).set(post);
  }
  await db.collection('operationalArchiveAuthority')
    .doc(authorityDocumentId(ownerId))
    .set(state.authorityManifest);
  const command = createFirestoreEmulatorArchiveCommandService({
    db,
    ownerId,
    approvalSecret: APPROVAL_SECRET,
    emulatorHost: EMULATOR_HOST,
    projectId: PROJECT_ID,
    now: () => NOW,
    beforeArchiveRecord
  });
  return { command, ownerId, prefix, state };
}

function sign(command, preview, approverId = 'founder:emulator') {
  return command.approve(preview, { approverId, approvedAt: NOW });
}

function withoutArchive(record) {
  const { operationalArchive, ...source } = record;
  return source;
}

function installStorageAgainstEmulator(db) {
  const firestorePath = require.resolve('../src/firestore');
  const cloudinaryPath = require.resolve('../src/cloudinary');
  const storagePath = require.resolve('../src/storage');
  const previousFirestore = require.cache[firestorePath];
  const previousCloudinary = require.cache[cloudinaryPath];
  const destroyed = [];
  delete require.cache[storagePath];
  require.cache[firestorePath] = {
    id: firestorePath,
    filename: firestorePath,
    loaded: true,
    exports: {
      postsCollection: () => db.collection('posts'),
      tiktokAccountsCollection: () => db.collection('tiktokAccounts'),
      youtubeAccountsCollection: () => db.collection('youtubeAccounts'),
      connectedAccountCapacityCollection: () => db.collection('connectedAccountCapacity'),
      postBatchesCollection: () => db.collection('postBatches'),
      configDoc: (name) => db.collection('config').doc(name),
      getFirestore: () => db,
      Timestamp: admin.firestore.Timestamp,
      FieldValue: admin.firestore.FieldValue
    }
  };
  require.cache[cloudinaryPath] = {
    id: cloudinaryPath,
    filename: cloudinaryPath,
    loaded: true,
    exports: {
      uploadMediaFile: async () => ({ mediaUrl: '', publicId: '', resourceType: '' }),
      destroyMediaAsset: async (publicId, resourceType) => {
        destroyed.push({ publicId, resourceType });
      },
      checkCloudinaryHealth: async () => ({ ok: true })
    }
  };
  return {
    storage: require('../src/storage'),
    destroyed,
    cleanup() {
      delete require.cache[storagePath];
      if (previousFirestore) require.cache[firestorePath] = previousFirestore;
      else delete require.cache[firestorePath];
      if (previousCloudinary) require.cache[cloudinaryPath] = previousCloudinary;
      else delete require.cache[cloudinaryPath];
    }
  };
}

if (!EMULATOR_HOST) {
  test('Firestore archive integration fails closed when the emulator host is absent', () => {
    assert.throws(
      () => assertFirestoreEmulatorSafety({
        emulatorHost: '',
        projectId: 'demo-chanter-autoposter-archive'
      }),
      (error) => (
        error instanceof OperationalHistoryArchiveError
        && error.code === 'firestore_emulator_required'
      )
    );
  });
} else {
  test('Firestore emulator backs the complete founder-approved archive flow', async (t) => {
    const { db, app, safety } = createEmulatorFirestore({
      emulatorHost: EMULATOR_HOST,
      projectId: PROJECT_ID,
      appName: `archive-emulator-test-${process.pid}`
    });
    const success = await seedWorld(db, {
      ownerId: 'owner-emulator',
      prefix: 'emulator-'
    });
    let preview;
    let signedApproval;
    let evidence;

    await t.test('emulator and demo-project configuration are mandatory', () => {
      assert.equal(safety.authorityMode, AUTHORITY_MODE);
      assert.equal(safety.emulatorHost, EMULATOR_HOST);
      assert.equal(safety.projectId, PROJECT_ID);
      assert.equal(app.options.projectId, PROJECT_ID);
      assert.throws(
        () => assertFirestoreEmulatorSafety({ emulatorHost: '', projectId: PROJECT_ID }),
        (error) => error.code === 'firestore_emulator_required'
      );
      assert.throws(
        () => assertFirestoreEmulatorSafety({
          emulatorHost: 'firestore.googleapis.com:443',
          projectId: PROJECT_ID
        }),
        (error) => error.code === 'firestore_emulator_host_invalid'
      );
      assert.throws(
        () => assertFirestoreEmulatorSafety({
          emulatorHost: EMULATOR_HOST,
          projectId: 'chanter-site'
        }),
        (error) => error.code === 'firestore_demo_project_required'
      );
    });

    await t.test('preview is stable, bounded, exact, and performs zero mutation', async () => {
      const before = await success.command.repository.loadDataset();
      preview = await success.command.preview({ maxCandidates: 3 });
      const repeated = await success.command.preview({ maxCandidates: 3 });
      const after = await success.command.repository.loadDataset();
      assert.equal(preview.executionReady, true);
      assert.deepEqual(preview.candidateIds, archiveIds('emulator-'));
      assert.equal(preview.operationId, repeated.operationId);
      assert.equal(preview.candidateSetHash, repeated.candidateSetHash);
      assert.deepEqual(preview.mutationEvidence, {
        performed: false,
        writes: 0,
        archives: 0,
        deletes: 0
      });
      assert.deepEqual(after, before);
      assert.equal(
        (await db.collection('operationalArchiveOperations').get()).size,
        0
      );
    });

    await t.test('execution without founder approval is rejected', async () => {
      await assert.rejects(
        success.command.execute({ maxCandidates: 3 }),
        (error) => error.code === 'founder_approval_required'
      );
    });

    await t.test('mismatched owner approval is rejected without mutation', async () => {
      signedApproval = sign(success.command, preview);
      const mismatched = { ...signedApproval, ownerId: 'different-owner' };
      await assert.rejects(
        success.command.execute({ approval: mismatched, maxCandidates: 3 }),
        (error) => error.code === 'founder_approval_invalid'
      );
      assert.equal(
        (await db.collection('posts').doc('emulator-archive-published').get())
          .data().operationalArchive,
        undefined
      );
    });

    await t.test('mismatched operation ID or candidate hash is rejected', async () => {
      await assert.rejects(
        success.command.execute({
          approval: { ...signedApproval, operationId: `${signedApproval.operationId}-other` },
          maxCandidates: 3
        }),
        (error) => error.code === 'founder_approval_invalid'
      );
      await assert.rejects(
        success.command.execute({
          approval: { ...signedApproval, candidateSetHash: 'f'.repeat(64) },
          maxCandidates: 3
        }),
        (error) => error.code === 'founder_approval_invalid'
      );
    });

    await t.test('approved execution archives only the frozen candidate set', async () => {
      evidence = await success.command.execute({
        approval: signedApproval,
        maxCandidates: 3
      });
      assert.equal(evidence.state, 'completed');
      assert.equal(evidence.operationId, preview.operationId);
      assert.equal(evidence.candidateSetHash, preview.candidateSetHash);
      assert.deepEqual(evidence.archivedIds, preview.candidateIds);
      assert.deepEqual(evidence.skippedIds, []);
      assert.deepEqual(evidence.failures, []);
      assert.equal(evidence.physicalDeletes, 0);
      console.log('[ARCHIVE_EMULATOR_EVIDENCE]', JSON.stringify({
        operationId: evidence.operationId,
        candidateSetHash: evidence.candidateSetHash,
        candidateIds: evidence.candidateIds,
        archivedIds: evidence.archivedIds,
        skippedIds: evidence.skippedIds,
        failures: evidence.failures,
        beforeCounts: evidence.beforeCounts,
        afterCounts: evidence.afterCounts,
        physicalDeletes: evidence.physicalDeletes
      }));
      const active = (await db.collection('posts').doc('emulator-preserve-active').get()).data();
      const scheduled = (await db.collection('posts').doc('emulator-preserve-scheduled').get()).data();
      assert.equal(active.operationalArchive, undefined);
      assert.equal(scheduled.operationalArchive, undefined);
    });

    await t.test('default and Queue exclude archives while History and Activity retain them', async () => {
      const dataset = await success.command.repository.loadDataset();
      const counts = projectionCounts(dataset, NOW);
      const audit = auditOperationalHistory(dataset, { now: NOW });
      const projected = dataset.posts.map(platformStatus.projectAutoPosterRuntimeJob);
      const queue = projected.filter((item) =>
        !item.archived && item.state !== platformStatus.WORK_STATE.COMPLETED);
      const activity = projected.filter((item) => item.evidenceAvailable);
      assert.equal(evidence.beforeCounts.defaultVisible, 5);
      assert.equal(evidence.afterCounts.defaultVisible, 2);
      assert.equal(counts.defaultVisible, 2);
      assert.equal(counts.history, 3);
      assert.equal(counts.archived, 3);
      assert.ok(queue.every((item) => !preview.candidateIds.includes(item.workId)));
      assert.deepEqual(
        audit.projections.history.map((item) => item.recordId).sort(),
        [...preview.candidateIds].sort()
      );
      assert.ok(activity.some((item) => item.workId === 'emulator-archive-published'));
    });

    await t.test('published provider artifacts and evidence remain unchanged outside the envelope', async () => {
      const seeded = success.state.posts.find((post) => post.id === 'emulator-archive-published');
      const stored = firestoreRecord(
        await db.collection('posts').doc('emulator-archive-published').get()
      );
      assert.deepEqual(withoutArchive(stored), seeded);
      assert.equal(stored.publishId, 'provider-artifact-local-001');
      assert.equal(stored.providerOperation.externalVideoId, 'provider-artifact-local-001');
      assert.equal(stored.history.length, 1);
    });

    await t.test('operation evidence is persisted and retrievable', async () => {
      const persisted = await success.command.getResult(preview.operationId);
      assert.deepEqual(persisted.candidateIds, preview.candidateIds);
      assert.deepEqual(persisted.archivedIds, preview.candidateIds);
      assert.equal(persisted.state, 'completed');
      assert.equal(persisted.physicalDeletes, 0);
      assert.equal(
        (await db.collection('operationalArchiveOperations').doc(preview.operationId).get()).exists,
        true
      );
    });

    await t.test('replay performs zero duplicate mutations', async () => {
      const before = await success.command.repository.loadDataset();
      const replay = await success.command.execute({
        approval: signedApproval,
        maxCandidates: 3
      });
      const after = await success.command.repository.loadDataset();
      assert.equal(replay.replayed, true);
      assert.equal(replay.replayMutationCount, 0);
      assert.deepEqual(after, before);
      assert.equal(
        (await db.collection('operationalArchiveOperations')
          .where('ownerId', '==', success.ownerId).get()).size,
        1
      );
    });

    await t.test('forced per-record failure persists exact partial evidence', async () => {
      const partial = await seedWorld(db, {
        ownerId: 'owner-emulator-partial',
        prefix: 'partial-',
        beforeArchiveRecord({ recordId }) {
          if (recordId === 'partial-archive-legacy') {
            throw new Error('Emulator-injected archive failure for partial-archive-legacy.');
          }
        }
      });
      const partialPreview = await partial.command.preview({ maxCandidates: 3 });
      const partialApproval = sign(partial.command, partialPreview);
      const partialEvidence = await partial.command.execute({
        approval: partialApproval,
        maxCandidates: 3
      });
      assert.equal(partialEvidence.state, 'partial');
      assert.deepEqual(partialEvidence.archivedIds, [
        'partial-archive-cancelled',
        'partial-archive-published'
      ]);
      assert.deepEqual(partialEvidence.skippedIds, []);
      assert.deepEqual(partialEvidence.failures, [{
        recordId: 'partial-archive-legacy',
        reason: 'Emulator-injected archive failure for partial-archive-legacy.'
      }]);
      assert.equal(partialEvidence.physicalDeletes, 0);
      assert.deepEqual(
        await partial.command.getResult(partialPreview.operationId),
        partialEvidence
      );
    });

    await t.test('generic physical-delete path rejects published and archived emulator records', async (subtest) => {
      const installed = installStorageAgainstEmulator(db);
      subtest.after(installed.cleanup);
      await assert.rejects(
        installed.storage.deletePost(success.ownerId, 'emulator-archive-published'),
        (error) => error.code === 'published_history_protected'
      );
      await assert.rejects(
        installed.storage.deletePost(success.ownerId, 'emulator-archive-cancelled'),
        (error) => error.code === 'published_history_protected'
      );
      assert.equal(
        (await db.collection('posts').doc('emulator-archive-published').get()).exists,
        true
      );
      assert.equal(
        (await db.collection('posts').doc('emulator-archive-cancelled').get()).exists,
        true
      );
      assert.deepEqual(installed.destroyed, []);
    });

    await t.test('archive execution path imports no provider, storage, credential, or delete client', () => {
      const source = [
        fs.readFileSync(path.join(ROOT, 'src', 'operationalHistoryArchiveFirestore.js'), 'utf8'),
        fs.readFileSync(path.join(ROOT, 'scripts', 'operational-history-archive-emulator.js'), 'utf8')
      ].join('\n');
      for (const forbidden of [
        "require('./storage')",
        "require('../src/storage')",
        "require('./providers')",
        "require('../src/providers')",
        "require('./tiktok')",
        "require('./youtube')",
        'FIREBASE_PRIVATE_KEY',
        'FIREBASE_CLIENT_EMAIL',
        '.delete(',
        'deletePost('
      ]) {
        assert.doesNotMatch(source, new RegExp(
          forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        ));
      }
    });
  });
}

function firestoreRecord(snapshot) {
  return { ...(snapshot.data() || {}), id: snapshot.id };
}
