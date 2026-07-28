'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const {
  ARCHIVE_SCHEMA_VERSION,
  OperationalHistoryArchiveError,
  createFounderArchiveApproval,
  createLocalFixtureArchiveRepository,
  createOperationalHistoryArchiveService,
  projectionCounts
} = require('../src/operationalHistoryArchive');
const { auditOperationalHistory } = require('../src/operationalHistoryAudit');
const { postFromDoc, mapPatchToFirestore } = require('../src/postsMapper');
const platformStatus = require('../src/platformStatus');

const ROOT = path.join(__dirname, '..');
const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'operational-history-archive-state.json');
const NOW = '2026-07-28T12:00:00.000Z';
const APPROVAL_SECRET = 'local-fixture-founder-secret-32-bytes-minimum';

function fixture() {
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
}

function harness(options = {}) {
  const repository = createLocalFixtureArchiveRepository(
    options.state || fixture(),
    { failRecordIds: options.failRecordIds || [] }
  );
  const service = createOperationalHistoryArchiveService({
    repository,
    ownerId: options.ownerId || 'owner',
    authorityMode: options.authorityMode || 'explicit_local_fixture',
    approvalSecret: APPROVAL_SECRET,
    now: () => NOW
  });
  return { repository, service };
}

function approval(preview, overrides = {}) {
  return createFounderArchiveApproval(preview, {
    approverId: 'founder:local-fixture',
    approvedAt: NOW,
    secret: APPROVAL_SECRET,
    ...overrides
  });
}

test('preview freezes exact bounded candidates and performs zero mutation', async () => {
  const world = harness();
  const before = world.repository.snapshot();
  const first = await world.service.preview({ maxCandidates: 2 });
  const second = await world.service.preview({ maxCandidates: 2 });
  assert.equal(first.executionReady, true);
  assert.deepEqual(first.candidateIds, ['archive-cancelled', 'archive-legacy']);
  assert.deepEqual(first.remainingCandidateIds, ['archive-published']);
  assert.equal(first.operationId, second.operationId);
  assert.equal(first.candidateSetHash, second.candidateSetHash);
  assert.deepEqual(first.mutationEvidence, {
    performed: false,
    writes: 0,
    archives: 0,
    deletes: 0
  });
  assert.deepEqual(world.repository.snapshot(), before);
});

test('execution without explicit founder approval is rejected without mutation', async () => {
  const world = harness();
  const before = world.repository.snapshot();
  await assert.rejects(
    world.service.execute({ maxCandidates: 3 }),
    (error) => (
      error instanceof OperationalHistoryArchiveError
      && error.code === 'founder_approval_required'
    )
  );
  assert.deepEqual(world.repository.snapshot(), before);
});

test('tampered founder approval signature is rejected without mutation', async () => {
  const world = harness();
  const preview = await world.service.preview({ maxCandidates: 3 });
  const signed = approval(preview);
  signed.signature = `${signed.signature.slice(0, -1)}${signed.signature.endsWith('0') ? '1' : '0'}`;
  const before = world.repository.snapshot();
  await assert.rejects(
    world.service.execute({ approval: signed, maxCandidates: 3 }),
    (error) => error.code === 'founder_approval_invalid'
  );
  assert.deepEqual(world.repository.snapshot(), before);
});

test('successful bounded archive preserves records and produces deterministic evidence', async () => {
  const world = harness();
  const preview = await world.service.preview({ maxCandidates: 3 });
  const evidence = await world.service.execute({
    approval: approval(preview),
    maxCandidates: 3
  });
  assert.equal(evidence.state, 'completed');
  assert.equal(evidence.operationId, preview.operationId);
  assert.deepEqual(evidence.candidateIds, [
    'archive-cancelled',
    'archive-legacy',
    'archive-published'
  ]);
  assert.deepEqual(evidence.archivedIds, evidence.candidateIds);
  assert.deepEqual(evidence.skippedIds, []);
  assert.deepEqual(evidence.failures, []);
  assert.equal(evidence.beforeCounts.defaultVisible, 5);
  assert.equal(evidence.afterCounts.defaultVisible, 2);
  assert.equal(evidence.beforeCounts.history, 3);
  assert.equal(evidence.afterCounts.history, 3);
  assert.equal(evidence.afterCounts.archived, 3);
  assert.equal(evidence.physicalDeletes, 0);
  assert.equal(evidence.recoverable, true);
});

test('published provider and audit evidence remain byte-for-byte preserved outside the archive envelope', async () => {
  const world = harness();
  const before = world.repository.snapshot().posts.find((post) => post.id === 'archive-published');
  const preview = await world.service.preview({ maxCandidates: 3 });
  await world.service.execute({ approval: approval(preview), maxCandidates: 3 });
  const after = world.repository.snapshot().posts.find((post) => post.id === 'archive-published');
  const { operationalArchive, ...afterSource } = after;
  assert.deepEqual(afterSource, before);
  assert.equal(operationalArchive.schemaVersion, ARCHIVE_SCHEMA_VERSION);
  assert.equal(operationalArchive.state, 'archived');
  assert.equal(operationalArchive.recoverable, true);
  assert.equal(after.publishId, 'provider-artifact-local-001');
  assert.equal(after.providerOperation.externalVideoId, 'provider-artifact-local-001');
  assert.equal(after.history.length, 1);
});

test('repeated operation ID returns stored evidence with zero duplicate mutation', async () => {
  const world = harness();
  const preview = await world.service.preview({ maxCandidates: 3 });
  const signed = approval(preview);
  const first = await world.service.execute({ approval: signed, maxCandidates: 3 });
  const afterFirst = world.repository.snapshot();
  const replay = await world.service.execute({ approval: signed, maxCandidates: 3 });
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(replay.replayMutationCount, 0);
  assert.deepEqual(replay.archivedIds, first.archivedIds);
  assert.deepEqual(world.repository.snapshot(), afterFirst);
  assert.equal(afterFirst.archiveOperations.length, 1);
});

test('partial adapter failure is evidence-backed and never reported as success', async () => {
  const world = harness({ failRecordIds: ['archive-legacy'] });
  const preview = await world.service.preview({ maxCandidates: 3 });
  const evidence = await world.service.execute({
    approval: approval(preview),
    maxCandidates: 3
  });
  assert.equal(evidence.state, 'partial');
  assert.deepEqual(evidence.archivedIds, ['archive-cancelled', 'archive-published']);
  assert.deepEqual(evidence.failures, [{
    recordId: 'archive-legacy',
    reason: 'Fixture-injected archive failure for archive-legacy.'
  }]);
  assert.equal(evidence.physicalDeletes, 0);
  assert.equal(world.repository.snapshot().archiveOperations[0].state, 'partial');
});

test('incomplete authority coverage blocks approval and execution readiness', async () => {
  const state = fixture();
  delete state.canonicalCommands;
  const world = harness({ state });
  const preview = await world.service.preview({ maxCandidates: 3 });
  assert.equal(preview.executionReady, false);
  assert.ok(preview.blockers.includes('authority_coverage_missing:canonicalCommands'));
  assert.throws(
    () => approval(preview),
    (error) => error.code === 'archive_preview_not_execution_ready'
  );
  assert.equal(world.repository.snapshot().archiveOperations.length, 0);
});

test('malformed authority collections cannot be treated as complete coverage', async () => {
  const state = fixture();
  state.evidenceRecords = null;
  const world = harness({ state });
  const preview = await world.service.preview({ maxCandidates: 3 });
  assert.equal(preview.executionReady, false);
  assert.ok(preview.blockers.includes('authority_collection_invalid:evidenceRecords'));
});

test('authority manifest owner and completeness claims are enforced', async () => {
  const state = fixture();
  state.authorityManifest.ownerId = 'another-owner';
  state.authorityManifest.complete = false;
  const world = harness({ state });
  const preview = await world.service.preview({ maxCandidates: 3 });
  assert.equal(preview.executionReady, false);
  assert.ok(preview.blockers.includes('authority_manifest_owner_mismatch'));
  assert.ok(preview.blockers.includes('authority_manifest_incomplete'));
});

test('non-local authority mode fails closed even with complete fixture coverage', async () => {
  const world = harness({ authorityMode: 'production_firestore' });
  const preview = await world.service.preview({ maxCandidates: 3 });
  assert.equal(preview.executionReady, false);
  assert.ok(preview.blockers.includes('authority_mode_not_local_or_emulator'));
});

test('future execution, unresolved approval, and uncertain provider operation are never archive candidates', async () => {
  const state = fixture();
  state.posts.push(
    {
      id: 'blocked-approval',
      userId: 'owner',
      workspaceId: 'workspace-local',
      provider: 'tiktok',
      accountId: 'account-local',
      status: 'cancelled',
      approvalState: 'waiting_approval'
    },
    {
      id: 'blocked-provider',
      userId: 'owner',
      workspaceId: 'workspace-local',
      provider: 'youtube',
      accountId: 'channel-local',
      status: 'cancelled',
      approvalState: 'none',
      providerOperation: { operationState: 'outcome_unknown' }
    },
    {
      id: 'blocked-future',
      userId: 'owner',
      workspaceId: 'workspace-local',
      provider: 'tiktok',
      accountId: 'account-local',
      status: 'cancelled',
      approvalState: 'none',
      scheduledAt: '2026-07-29T12:00:00.000Z'
    }
  );
  const world = harness({ state });
  const preview = await world.service.preview({ maxCandidates: 10 });
  assert.ok(!preview.candidateIds.includes('blocked-approval'));
  assert.ok(!preview.candidateIds.includes('blocked-provider'));
  assert.ok(!preview.candidateIds.includes('blocked-future'));
  assert.equal(
    preview.skipped.find((item) => item.recordId === 'blocked-approval').blockers[0],
    'unresolved_approval'
  );
  assert.equal(
    preview.skipped.find((item) => item.recordId === 'blocked-provider').blockers[0],
    'provider_operation_active_or_uncertain'
  );
  assert.equal(
    auditOperationalHistory(state, { now: NOW }).records
      .find((item) => item.recordId === 'blocked-future').classification,
    'scheduled'
  );
});

test('archive ownership must match the explicit owner scope', async () => {
  const world = harness({ ownerId: 'different-owner' });
  const preview = await world.service.preview({ maxCandidates: 3 });
  assert.equal(preview.candidateIds.length, 0);
  assert.equal(preview.executionReady, false);
  assert.ok(preview.skipped.every((candidate) =>
    candidate.blockers.includes('archive_owner_unproven')));
});

test('archived rows leave the default projection and remain in history', async () => {
  const world = harness();
  const before = projectionCounts(world.repository.snapshot(), NOW);
  const preview = await world.service.preview({ maxCandidates: 3 });
  await world.service.execute({ approval: approval(preview), maxCandidates: 3 });
  const state = world.repository.snapshot();
  const after = projectionCounts(state, NOW);
  const audit = auditOperationalHistory(state, { now: NOW });
  assert.equal(before.defaultVisible, 5);
  assert.equal(after.defaultVisible, 2);
  assert.equal(after.operational, 2);
  assert.equal(after.history, 3);
  assert.deepEqual(audit.proposals.archive, []);
  assert.deepEqual(
    audit.projections.history.map((record) => record.recordId).sort(),
    ['archive-cancelled', 'archive-legacy', 'archive-published']
  );
  assert.ok(audit.projections.history.every((record) => record.archived));
});

test('archive metadata is sanitized into post and Platform projections and cannot enter generic edits', () => {
  const source = fixture().posts[1];
  const archive = {
    schemaVersion: ARCHIVE_SCHEMA_VERSION,
    state: 'archived',
    operationId: 'operation-1',
    archivedAt: NOW,
    archivedBy: 'founder:local-fixture',
    classification: 'cancelled',
    candidateSetHash: 'a'.repeat(64),
    recoverable: true
  };
  const post = postFromDoc({
    id: source.id,
    data: () => ({ ...source, operationalArchive: archive })
  });
  assert.deepEqual(post.operationalArchive, archive);
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      mapPatchToFirestore({ operationalArchive: archive, caption: 'safe' }),
      'operationalArchive'
    ),
    false
  );
  assert.equal(platformStatus.projectAutoPosterRuntimeJob(post).archived, true);
  assert.equal(platformStatus.projectAutoPosterBatch({
    batchId: 'batch-1',
    status: 'completed',
    itemCount: 1,
    operationalArchive: { ...archive, classification: 'published' }
  }).archived, true);
});

test('live Queue filters archived work while Activity and legacy History retain it', () => {
  const platformRoutes = fs.readFileSync(path.join(ROOT, 'src', 'platformRoutes.js'), 'utf8');
  const legacyView = fs.readFileSync(path.join(ROOT, 'src', 'views', 'index.ejs'), 'utf8');
  assert.match(platformRoutes, /!item\.archived && item\.state !== platformStatus\.WORK_STATE\.COMPLETED/);
  assert.match(platformRoutes, /owned\.filter\(\(item\) => item\.evidenceAvailable\)/);
  assert.match(legacyView, /statusOf\(post\) !== 'posted' && !isArchived\(post\)/);
  assert.match(legacyView, /statusOf\(post\) === 'posted' \|\| isArchived\(post\)/);
  assert.match(legacyView, /Physical deletion disabled/);
  const historySection = legacyView.slice(
    legacyView.indexOf('Operational History'),
    legacyView.indexOf('id="creative-tools"')
  );
  assert.doesNotMatch(historySection, /data-delete-form/);
});

test('archive implementation has no physical-delete or Firestore dependency', () => {
  const moduleSource = fs.readFileSync(path.join(ROOT, 'src', 'operationalHistoryArchive.js'), 'utf8');
  const cliSource = fs.readFileSync(path.join(ROOT, 'scripts', 'operational-history-archive.js'), 'utf8');
  for (const forbidden of [
    "require('./storage')",
    "require('../src/storage')",
    "require('./firestore')",
    "require('../src/firestore')",
    'deletePost(',
    'deleteBatchRecord(',
    'tx.delete(',
    'postsCollection(',
    'postBatchesCollection('
  ]) {
    const pattern = new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    assert.doesNotMatch(moduleSource, pattern);
    assert.doesNotMatch(cliSource, pattern);
  }
});

test('founder CLI performs preview, signed approval, archive, and replay using local files only', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chanter-archive-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const previewPath = path.join(directory, 'preview.json');
  const approvalPath = path.join(directory, 'approval.json');
  const archivedPath = path.join(directory, 'archived.json');
  const replayPath = path.join(directory, 'replay.json');
  const cli = path.join(ROOT, 'scripts', 'operational-history-archive.js');
  const environment = {
    ...process.env,
    AUTOPOSTER_ARCHIVE_APPROVAL_SECRET: APPROVAL_SECRET
  };
  const run = (args) => spawnSync(process.execPath, [cli, ...args], {
    cwd: ROOT,
    env: environment,
    encoding: 'utf8'
  });

  const preview = run([
    '--mode', 'preview',
    '--input', FIXTURE_PATH,
    '--owner', 'owner',
    '--max-candidates', '3',
    '--now', NOW,
    '--output', previewPath
  ]);
  assert.equal(preview.status, 0, preview.stderr);

  const approve = run([
    '--mode', 'approve',
    '--preview', previewPath,
    '--approver', 'founder:local-fixture',
    '--approved-at', NOW,
    '--output', approvalPath
  ]);
  assert.equal(approve.status, 0, approve.stderr);

  const execute = run([
    '--mode', 'execute',
    '--input', FIXTURE_PATH,
    '--owner', 'owner',
    '--approval', approvalPath,
    '--max-candidates', '3',
    '--now', NOW,
    '--output', archivedPath
  ]);
  assert.equal(execute.status, 0, execute.stderr);
  const execution = JSON.parse(execute.stdout);
  assert.equal(execution.ok, true);
  assert.equal(execution.evidence.physicalDeletes, 0);

  const replay = run([
    '--mode', 'execute',
    '--input', archivedPath,
    '--owner', 'owner',
    '--approval', approvalPath,
    '--max-candidates', '3',
    '--now', NOW,
    '--output', replayPath
  ]);
  assert.equal(replay.status, 0, replay.stderr);
  const repeated = JSON.parse(replay.stdout);
  assert.equal(repeated.evidence.replayed, true);
  assert.equal(repeated.evidence.replayMutationCount, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(replayPath, 'utf8')), JSON.parse(fs.readFileSync(archivedPath, 'utf8')));
});
