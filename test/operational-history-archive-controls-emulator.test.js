'use strict';

process.env.ADMIN_PASSWORD = 'founder-control-test-password';
process.env.ADMIN_SESSION_SECRET = 'founder-control-session-secret';
process.env.APP_DEFAULT_USER_ID = 'owner-controls';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const express = require('express');
const admin = require('firebase-admin');
const {
  OperationalHistoryArchiveError,
  projectionCounts
} = require('../src/operationalHistoryArchive');
const {
  AUTHORITY_MODE,
  CANONICAL_ARCHIVE_EMULATOR_PROJECT_ID,
  assertFirestoreEmulatorSafety,
  authorityDocumentId,
  createEmulatorFirestore,
  createFirestoreEmulatorArchiveCommandService
} = require('../src/operationalHistoryArchiveFirestore');
const {
  APPROVAL_CONFIRMATION,
  CONTROL_PATH,
  createOperationalHistoryArchiveRouter
} = require('../src/operationalHistoryArchiveRoutes');
const {
  ADMIN_SESSION_COOKIE,
  attachUser,
  createAdminSessionToken,
  csrfOriginCheck
} = require('../src/auth');
const { auditOperationalHistory } = require('../src/operationalHistoryAudit');
const platformStatus = require('../src/platformStatus');

const ROOT = path.join(__dirname, '..');
const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'operational-history-archive-state.json');
const NOW = '2026-07-28T12:00:00.000Z';
const OWNER_ID = 'owner-controls';
const APPROVAL_SECRET = 'founder-control-approval-secret-32-bytes-minimum';
const SECRET_CANARY = 'FOUNDERS-ONLY-SECRET-CANARY';
const EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '';
const PROJECT_ID = process.env.GCLOUD_PROJECT || '';

function fixture() {
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
}

function candidateIds(prefix) {
  return [
    `${prefix}archive-cancelled`,
    `${prefix}archive-legacy`,
    `${prefix}archive-published`
  ];
}

function archivePosts(prefix) {
  return fixture().posts
    .filter((post) => post.id.startsWith('archive-'))
    .map((post) => ({ ...post, id: `${prefix}${post.id}`, userId: OWNER_ID }));
}

async function seedInitialWorld(db) {
  const state = fixture();
  const posts = state.posts.map((post) => ({
    ...post,
    id: `control-${post.id}`,
    userId: OWNER_ID
  }));
  for (const post of posts) {
    await db.collection('posts').doc(post.id).set(post);
  }
  await db.collection('operationalArchiveAuthority')
    .doc(authorityDocumentId(OWNER_ID))
    .set({
      ...state.authorityManifest,
      ownerId: OWNER_ID,
      mode: AUTHORITY_MODE,
      observedAt: '2026-07-28T11:55:00.000Z'
    });
  return posts;
}

async function startControlServer({ commandFactory }) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(ROOT, 'src', 'views'));
  app.use(attachUser);
  app.use(csrfOriginCheck);
  app.use(createOperationalHistoryArchiveRouter({
    commandFactory,
    now: () => NOW
  }));
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const cookie = `${ADMIN_SESSION_COOKIE}=${createAdminSessionToken()}`;
  return {
    baseUrl,
    cookie,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

async function jsonRequest(world, route, {
  method = 'GET',
  body,
  authenticated = true
} = {}) {
  const headers = { Accept: 'application/json' };
  if (authenticated) headers.Cookie = world.cookie;
  if (method !== 'GET') {
    headers.Origin = world.baseUrl;
    headers['Content-Type'] = 'application/json';
  }
  const response = await fetch(`${world.baseUrl}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual'
  });
  return { response, payload: await response.json() };
}

if (!EMULATOR_HOST) {
  test('founder archive controls fail closed without Firestore emulator configuration', () => {
    assert.throws(
      () => assertFirestoreEmulatorSafety({
        emulatorHost: '',
        projectId: 'demo-chanter-autoposter-archive'
      }),
      (error) => error.code === 'firestore_emulator_required'
    );
  });
} else {
  test('founder control surface drives the exact emulator archive flow', async (t) => {
    assert.equal(PROJECT_ID, CANONICAL_ARCHIVE_EMULATOR_PROJECT_ID);
    assert.equal(process.env.FIREBASE_PROJECT_ID, CANONICAL_ARCHIVE_EMULATOR_PROJECT_ID);
    const { db } = createEmulatorFirestore({
      emulatorHost: EMULATOR_HOST,
      projectId: PROJECT_ID,
      appName: `archive-controls-test-${process.pid}`
    });
    const initialPosts = await seedInitialWorld(db);
    const failureIds = new Set();
    const command = createFirestoreEmulatorArchiveCommandService({
      db,
      ownerId: OWNER_ID,
      approvalSecret: APPROVAL_SECRET,
      emulatorHost: EMULATOR_HOST,
      projectId: PROJECT_ID,
      now: () => NOW,
      beforeArchiveRecord({ recordId }) {
        if (failureIds.has(recordId)) {
          throw new Error(`Control-injected archive failure for ${recordId}.`);
        }
      }
    });
    const commandFactory = async ({ ownerId }) => {
      assert.equal(ownerId, OWNER_ID);
      return command;
    };
    const world = await startControlServer({ commandFactory });
    t.after(world.close);
    let preview;
    let evidence;

    await t.test('control page and APIs reject unauthenticated requests', async () => {
      const page = await fetch(`${world.baseUrl}${CONTROL_PATH}`, { redirect: 'manual' });
      assert.equal(page.status, 302);
      assert.match(page.headers.get('location'), /^\/admin-login/);
      const { response, payload } = await jsonRequest(world, `${CONTROL_PATH}/preview`, {
        method: 'POST',
        body: {},
        authenticated: false
      });
      assert.equal(response.status, 401);
      assert.equal(payload.code, 'founder_auth_required');
    });

    await t.test('founder page renders every visible state without protected approval material', async () => {
      const response = await fetch(`${world.baseUrl}${CONTROL_PATH}`, {
        headers: { Cookie: world.cookie }
      });
      const html = await response.text();
      assert.equal(response.status, 200);
      for (const expected of [
        'Preview archive candidates',
        'Approve &amp; archive',
        'Executing bounded archive',
        'Partial archive result',
        'Rejected / blocked',
        'Physical deletes',
        'Persisted evidence ID'
      ]) {
        assert.match(html, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      }
      assert.match(html, /Additive archive only/);
      assert.doesNotMatch(html, /FOUNDERS-ONLY-SECRET-CANARY|approvalSignature|hmac_sha256/i);
      assert.equal(html.includes(APPROVAL_SECRET), false);
    });

    await t.test('preview ignores browser owner spoofing and performs zero mutations', async () => {
      const before = await command.repository.loadDataset();
      const { response, payload } = await jsonRequest(world, `${CONTROL_PATH}/preview`, {
        method: 'POST',
        body: { maxCandidates: 3, ownerId: 'spoofed-owner' }
      });
      const after = await command.repository.loadDataset();
      assert.equal(response.status, 200);
      assert.equal(payload.ok, true);
      preview = payload.preview;
      assert.equal(preview.ownerId, OWNER_ID);
      assert.deepEqual(preview.candidateIds, candidateIds('control-'));
      assert.equal(preview.candidateCount, 3);
      assert.deepEqual(preview.classificationSummary, {
        cancelled: 1,
        legacy: 1,
        published: 1
      });
      assert.deepEqual(preview.mutationEvidence, {
        performed: false,
        writes: 0,
        archives: 0,
        deletes: 0
      });
      assert.deepEqual(after, before);
      assert.doesNotMatch(JSON.stringify(payload), /signature|FOUNDERS-ONLY-SECRET-CANARY/i);
      assert.equal(JSON.stringify(payload).includes(APPROVAL_SECRET), false);
    });

    await t.test('execute without a server-issued preview or confirmation is rejected', async () => {
      const withoutPreview = await jsonRequest(world, `${CONTROL_PATH}/execute`, {
        method: 'POST',
        body: {
          operationId: 'not-issued',
          candidateSetHash: 'a'.repeat(64),
          confirmation: APPROVAL_CONFIRMATION
        }
      });
      assert.equal(withoutPreview.response.status, 409);
      assert.equal(withoutPreview.payload.code, 'archive_preview_required');
      const withoutConfirmation = await jsonRequest(world, `${CONTROL_PATH}/execute`, {
        method: 'POST',
        body: {
          operationId: preview.operationId,
          candidateSetHash: preview.candidateSetHash
        }
      });
      assert.equal(withoutConfirmation.response.status, 403);
      assert.equal(withoutConfirmation.payload.code, 'founder_confirmation_required');
    });

    await t.test('changed candidate hash is rejected without mutation', async () => {
      const before = await command.repository.loadDataset();
      const { response, payload } = await jsonRequest(world, `${CONTROL_PATH}/execute`, {
        method: 'POST',
        body: {
          operationId: preview.operationId,
          candidateSetHash: 'f'.repeat(64),
          confirmation: APPROVAL_CONFIRMATION
        }
      });
      assert.equal(response.status, 409);
      assert.equal(payload.code, 'archive_preview_mismatch');
      assert.deepEqual(await command.repository.loadDataset(), before);
    });

    await t.test('changed records invalidate a stale preview', async () => {
      const ref = db.collection('posts').doc('control-archive-cancelled');
      await ref.update({ caption: 'changed after preview' });
      const { response, payload } = await jsonRequest(world, `${CONTROL_PATH}/execute`, {
        method: 'POST',
        body: {
          operationId: preview.operationId,
          candidateSetHash: preview.candidateSetHash,
          confirmation: APPROVAL_CONFIRMATION
        }
      });
      assert.equal(response.status, 409);
      assert.equal(payload.code, 'archive_preview_changed');
      assert.equal((await ref.get()).data().operationalArchive, undefined);
      await ref.update({ caption: admin.firestore.FieldValue.delete() });
      const refreshed = await jsonRequest(world, `${CONTROL_PATH}/preview`, {
        method: 'POST',
        body: { maxCandidates: 3 }
      });
      preview = refreshed.payload.preview;
      assert.deepEqual(preview.candidateIds, candidateIds('control-'));
    });

    await t.test('explicit founder approval archives the exact frozen set', async () => {
      const { response, payload } = await jsonRequest(world, `${CONTROL_PATH}/execute`, {
        method: 'POST',
        body: {
          ownerId: 'spoofed-owner',
          operationId: preview.operationId,
          candidateSetHash: preview.candidateSetHash,
          confirmation: APPROVAL_CONFIRMATION
        }
      });
      assert.equal(response.status, 200);
      evidence = payload.evidence;
      assert.equal(evidence.state, 'completed');
      assert.equal(evidence.ownerId, OWNER_ID);
      assert.deepEqual(evidence.candidateIds, preview.candidateIds);
      assert.deepEqual(evidence.archivedIds, preview.candidateIds);
      assert.deepEqual(evidence.skippedIds, []);
      assert.deepEqual(evidence.failures, []);
      assert.equal(evidence.physicalDeletes, 0);
      assert.doesNotMatch(JSON.stringify(payload), /signature|FOUNDERS-ONLY-SECRET-CANARY/i);
      assert.equal(JSON.stringify(payload).includes(APPROVAL_SECRET), false);
      console.log('[ARCHIVE_CONTROL_EMULATOR_EVIDENCE]', JSON.stringify({
        evidenceId: evidence.evidenceId,
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
    });

    await t.test('persisted evidence retrieval and repeated execute are mutation-free', async () => {
      const stored = await jsonRequest(
        world,
        `${CONTROL_PATH}/operations/${encodeURIComponent(preview.operationId)}`
      );
      assert.equal(stored.response.status, 200);
      assert.equal(stored.payload.evidence.evidenceId, preview.operationId);
      assert.doesNotMatch(JSON.stringify(stored.payload), /signature|FOUNDERS-ONLY-SECRET-CANARY/i);
      const before = await command.repository.loadDataset();
      const replay = await jsonRequest(world, `${CONTROL_PATH}/execute`, {
        method: 'POST',
        body: {
          operationId: preview.operationId,
          candidateSetHash: preview.candidateSetHash,
          confirmation: APPROVAL_CONFIRMATION
        }
      });
      assert.equal(replay.response.status, 200);
      assert.equal(replay.payload.evidence.replayed, true);
      assert.equal(replay.payload.evidence.replayMutationCount, 0);
      assert.deepEqual(await command.repository.loadDataset(), before);
    });

    await t.test('Default and Queue exclude archives while History and Activity retain them', async () => {
      const dataset = await command.repository.loadDataset();
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
      assert.ok(queue.every((item) => !preview.candidateIds.includes(item.workId)));
      assert.deepEqual(
        audit.projections.history.map((item) => item.recordId).sort(),
        [...preview.candidateIds].sort()
      );
      assert.ok(activity.some((item) => item.workId === 'control-archive-published'));
    });

    await t.test('partial failures are persisted and returned with exact reasons', async () => {
      for (const post of archivePosts('partial-control-')) {
        await db.collection('posts').doc(post.id).set(post);
      }
      failureIds.add('partial-control-archive-legacy');
      const partialPreviewResponse = await jsonRequest(world, `${CONTROL_PATH}/preview`, {
        method: 'POST',
        body: { maxCandidates: 3 }
      });
      const partialPreview = partialPreviewResponse.payload.preview;
      assert.deepEqual(partialPreview.candidateIds, candidateIds('partial-control-'));
      const partial = await jsonRequest(world, `${CONTROL_PATH}/execute`, {
        method: 'POST',
        body: {
          operationId: partialPreview.operationId,
          candidateSetHash: partialPreview.candidateSetHash,
          confirmation: APPROVAL_CONFIRMATION
        }
      });
      assert.equal(partial.response.status, 200);
      assert.equal(partial.payload.evidence.state, 'partial');
      assert.deepEqual(partial.payload.evidence.archivedIds, [
        'partial-control-archive-cancelled',
        'partial-control-archive-published'
      ]);
      assert.deepEqual(partial.payload.evidence.failures, [{
        recordId: 'partial-control-archive-legacy',
        reason: 'Control-injected archive failure for partial-control-archive-legacy.'
      }]);
      assert.equal(partial.payload.evidence.physicalDeletes, 0);
      assert.doesNotMatch(JSON.stringify(partial.payload), /signature|FOUNDERS-ONLY-SECRET-CANARY/i);
    });

    await t.test('non-emulator route configuration fails closed', async (subtest) => {
      const blocked = await startControlServer({
        commandFactory: async () => {
          throw new OperationalHistoryArchiveError(
            'Operational history archive requires FIRESTORE_EMULATOR_HOST.',
            { code: 'firestore_emulator_required', status: 503 }
          );
        }
      });
      subtest.after(blocked.close);
      const { response, payload } = await jsonRequest(blocked, `${CONTROL_PATH}/preview`, {
        method: 'POST',
        body: {}
      });
      assert.equal(response.status, 503);
      assert.equal(payload.code, 'firestore_emulator_required');
    });

    await t.test('control path reaches no provider, production Firebase, secret, or delete client', () => {
      const source = fs.readFileSync(
        path.join(ROOT, 'src', 'operationalHistoryArchiveRoutes.js'),
        'utf8'
      );
      for (const forbidden of [
        "require('./storage')",
        "require('./providers')",
        "require('./tiktok')",
        "require('./youtube')",
        "require('./firestore')",
        "require('./config')",
        'FIREBASE_PRIVATE_KEY',
        'FIREBASE_CLIENT_EMAIL',
        'transaction.delete(',
        'tx.delete(',
        'deletePost('
      ]) {
        assert.doesNotMatch(source, new RegExp(
          forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        ));
      }
      assert.equal(initialPosts.length, 5);
    });
  });
}
