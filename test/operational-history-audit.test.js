'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { auditOperationalHistory } = require('../src/operationalHistoryAudit');

const NOW = '2026-07-28T12:00:00.000Z';

function audit(input) {
  return auditOperationalHistory(input, { now: NOW, source: { kind: 'test_fixture' } });
}

function byId(report, id) {
  return report.records.find((record) => record.recordId === id);
}

test('dry-run performs zero mutation and reports identical before/after counts', () => {
  const input = { posts: [{ id: 'pending', status: 'pending', approvedAt: null }] };
  const before = structuredClone(input);
  const report = audit(input);
  assert.deepEqual(input, before);
  assert.deepEqual(report.beforeCounts, report.afterCounts);
  assert.deepEqual(report.mutationEvidence, {
    operationId: null,
    performed: false,
    writes: 0,
    archives: 0,
    deletes: 0,
    note: 'Dry-run classification only; no mutation capability is present in this module.'
  });
});

test('published records are never removal candidates even when explicitly marked as tests', () => {
  const report = audit({
    posts: [{
      id: 'published-test',
      status: 'posted',
      creationSource: 'test_fixture',
      publishId: 'provider-123'
    }]
  });
  const record = byId(report, 'published-test');
  assert.equal(record.classification, 'published');
  assert.equal(record.removalEligible, false);
  assert.ok(record.removalBlockers.includes('provider_publication_evidence'));
  assert.deepEqual(report.proposals.remove, []);
});

test('scheduled and waiting-approval records stay in the operational projection', () => {
  const report = audit({
    posts: [
      {
        id: 'scheduled',
        status: 'scheduled',
        approvedAt: '2026-07-28T10:00:00.000Z',
        scheduledAt: '2026-07-29T10:00:00.000Z'
      },
      {
        id: 'approval',
        status: 'scheduled',
        scheduledAt: '2026-07-29T11:00:00.000Z'
      }
    ]
  });
  assert.equal(byId(report, 'scheduled').classification, 'scheduled');
  assert.equal(byId(report, 'approval').classification, 'waiting_approval');
  assert.deepEqual(
    report.projections.operational.map((record) => record.recordId),
    ['scheduled', 'approval']
  );
});

test('canonical evidence-linked noise is preserved and never removal eligible', () => {
  const report = audit({
    posts: [{
      id: 'evidence-test',
      status: 'cancelled',
      creationSource: 'demo_fixture',
      history: [{ event: 'created' }],
      evidenceBundleId: 'evidence-1'
    }]
  });
  const record = byId(report, 'evidence-test');
  assert.equal(record.classification, 'test_demo');
  assert.equal(record.removalEligible, false);
  assert.ok(record.removalBlockers.includes('canonical_evidence_or_linkage'));
});

test('explicit test/demo records can become dry-run removal candidates only when every gate passes', () => {
  const report = audit({
    posts: [{
      id: 'safe-demo',
      status: 'cancelled',
      creationSource: 'demo_fixture',
      customerOwned: false
    }]
  });
  const record = byId(report, 'safe-demo');
  assert.equal(record.classification, 'test_demo');
  assert.equal(record.removalEligible, true);
  assert.equal(record.recommendedAction, 'remove_only_after_explicit_approval');
  assert.deepEqual(report.proposals.remove.map((candidate) => candidate.recordId), ['safe-demo']);
});

test('exact idempotency duplicates retain one canonical row and propose only the weaker duplicate', () => {
  const shared = {
    status: 'cancelled',
    userId: 'owner',
    workspaceId: 'workspace-a',
    provider: 'tiktok',
    accountId: 'account-a',
    idempotencyKey: 'same-operation',
    creationSource: 'test_fixture',
    customerOwned: false
  };
  const report = audit({
    posts: [
      { ...shared, id: 'canonical', createdAt: '2026-07-20T00:00:00.000Z', history: [{ event: 'created' }] },
      { ...shared, id: 'duplicate', createdAt: '2026-07-21T00:00:00.000Z' }
    ]
  });
  assert.notEqual(byId(report, 'canonical').classification, 'duplicate');
  assert.equal(byId(report, 'duplicate').classification, 'duplicate');
  assert.equal(byId(report, 'duplicate').duplicateKeeperId, 'canonical');
  assert.deepEqual(report.proposals.remove.map((candidate) => candidate.recordId), ['duplicate']);
});

test('orphan detection requires supplied authority coverage and reports before any action', () => {
  const withoutBatchExport = audit({
    posts: [{ id: 'job', status: 'cancelled', batchId: 'missing-batch', workspaceId: 'w', provider: 'tiktok', accountId: 'a' }]
  });
  assert.notEqual(byId(withoutBatchExport, 'job').classification, 'orphaned');

  const withBatchExport = audit({
    posts: [{
      id: 'job',
      status: 'cancelled',
      batchId: 'missing-batch',
      workspaceId: 'w',
      provider: 'tiktok',
      accountId: 'a'
    }],
    postBatches: []
  });
  assert.equal(byId(withBatchExport, 'job').classification, 'orphaned');
  assert.equal(byId(withBatchExport, 'job').removalEligible, false);
  assert.deepEqual(withBatchExport.proposals.remove, []);
  assert.equal(withBatchExport.proposals.skippedRemoval[0].recordId, 'job');
});

test('batch records with declared but absent children are reported as orphaned', () => {
  const report = audit({
    posts: [],
    postBatches: [{
      batchId: 'batch-orphan',
      itemCount: 2,
      status: 'completed',
      workspaceId: 'workspace-a',
      provider: 'tiktok'
    }]
  });
  assert.equal(byId(report, 'batch-orphan').classification, 'orphaned');
  assert.equal(byId(report, 'batch-orphan').removalEligible, false);
});

test('missing child-post coverage never turns a batch into an orphan or removal candidate', () => {
  const report = audit({
    postBatches: [{
      batchId: 'batch-uncovered',
      itemCount: 2,
      status: 'completed',
      workspaceId: 'workspace-a',
      provider: 'tiktok',
      creationSource: 'test_fixture',
      customerOwned: false
    }]
  });
  assert.equal(report.coverage.posts, false);
  assert.equal(byId(report, 'batch-uncovered').classification, 'test_demo');
  assert.equal(byId(report, 'batch-uncovered').removalEligible, false);
  assert.ok(byId(report, 'batch-uncovered').removalBlockers.includes('post_coverage_unavailable'));
  assert.notEqual(byId(report, 'batch-uncovered').classification, 'orphaned');
});

test('active lifecycle wins over legacy identity gaps and remains operational', () => {
  const report = audit({
    posts: [{
      id: 'approved-pending-legacy-shape',
      status: 'pending',
      approvedAt: '2026-07-28T10:00:00.000Z'
    }]
  });
  assert.equal(byId(report, 'approved-pending-legacy-shape').classification, 'active');
  assert.deepEqual(
    report.projections.operational.map((record) => record.recordId),
    ['approved-pending-legacy-shape']
  );
});

test('explicit duplicate linkage requires the keeper to exist in the supplied post export', () => {
  const report = audit({
    posts: [{
      id: 'broken-duplicate',
      status: 'cancelled',
      duplicateOf: 'missing-keeper',
      workspaceId: 'workspace-a',
      provider: 'tiktok',
      accountId: 'account-a',
      customerOwned: false
    }]
  });
  const record = byId(report, 'broken-duplicate');
  assert.equal(record.classification, 'orphaned');
  assert.equal(record.removalEligible, false);
  assert.ok(record.removalBlockers.includes('canonical_evidence_or_linkage'));
});

test('batch evidence and approval linkage fail closed for removal proposals', () => {
  const report = audit({
    posts: [],
    postBatches: [{
      batchId: 'batch-evidence',
      itemCount: 2,
      status: 'completed',
      workspaceId: 'workspace-a',
      provider: 'tiktok',
      creationSource: 'test_fixture',
      customerOwned: false,
      approvalId: 'approval-1',
      evidenceBundleId: 'evidence-1'
    }]
  });
  const record = byId(report, 'batch-evidence');
  assert.equal(record.classification, 'orphaned');
  assert.equal(record.removalEligible, false);
  assert.ok(record.removalBlockers.includes('canonical_evidence_or_linkage'));
  assert.ok(record.removalBlockers.includes('active_approval'));
});

test('published batch lifecycle wins over missing-child orphan analysis', () => {
  const report = audit({
    posts: [],
    postBatches: [{
      batchId: 'batch-published',
      itemCount: 2,
      status: 'posted',
      workspaceId: 'workspace-a',
      provider: 'tiktok',
      creationSource: 'test_fixture',
      customerOwned: false
    }]
  });
  const record = byId(report, 'batch-published');
  assert.equal(record.classification, 'published');
  assert.equal(record.removalEligible, false);
  assert.deepEqual(report.proposals.remove, []);
  assert.deepEqual(report.proposals.archive.map((candidate) => candidate.recordId), ['batch-published']);
});

test('unknown records are preserved and never proposed for removal', () => {
  const report = audit({
    posts: [{
      id: 'unknown',
      status: 'new_state',
      workspaceId: 'workspace-a',
      provider: 'tiktok',
      accountId: 'account-a'
    }]
  });
  const record = byId(report, 'unknown');
  assert.equal(record.classification, 'unknown');
  assert.equal(record.recommendedAction, 'preserve_unknown');
  assert.deepEqual(report.proposals.remove, []);
  assert.deepEqual(report.projections.preservedUnknown.map((entry) => entry.recordId), ['unknown']);
});

test('rerunning the classifier with the same timestamp is idempotent', () => {
  const input = {
    posts: [
      { id: 'legacy', status: 'failed' },
      { id: 'published', status: 'posted', publishId: 'provider-1' }
    ]
  };
  assert.deepEqual(audit(input), audit(input));
});

test('default dry-run operational projection excludes archive and cleanup-review noise', () => {
  const report = audit({
    posts: [
      { id: 'active', status: 'processing', workspaceId: 'w', provider: 'tiktok', accountId: 'a' },
      { id: 'failed', status: 'failed', workspaceId: 'w', provider: 'tiktok', accountId: 'a' },
      { id: 'published', status: 'posted' },
      { id: 'demo', status: 'cancelled', creationSource: 'test_fixture', customerOwned: false }
    ]
  });
  assert.deepEqual(
    report.projections.operational.map((record) => record.recordId),
    ['active', 'failed']
  );
  assert.deepEqual(report.projections.history.map((record) => record.recordId), ['published']);
  assert.deepEqual(report.projections.cleanupReview.map((record) => record.recordId), ['demo']);
});

test('all required classification counters are always present', () => {
  const report = audit([]);
  assert.deepEqual(Object.keys(report.counts), [
    'total',
    'active',
    'scheduled',
    'waiting_approval',
    'published',
    'failed',
    'cancelled',
    'test_demo',
    'legacy',
    'duplicate',
    'orphaned',
    'unknown'
  ]);
  assert.equal(report.counts.total, 0);
});

test('dry-run code has no storage, Firestore, provider, or mutation dependency', () => {
  const root = path.join(__dirname, '..');
  const moduleSource = fs.readFileSync(path.join(root, 'src', 'operationalHistoryAudit.js'), 'utf8');
  const cliSource = fs.readFileSync(path.join(root, 'scripts', 'operational-history-audit.js'), 'utf8');
  for (const forbidden of [
    "require('./storage')",
    "require('../src/storage')",
    "require('./firestore')",
    "require('../src/firestore')",
    'getFirestore(',
    'postsCollection(',
    'postBatchesCollection(',
    'deletePost(',
    'deleteBatchRecord(',
    'tx.delete(',
    'storage.'
  ]) {
    assert.doesNotMatch(moduleSource, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(cliSource, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(cliSource, /An explicit local JSON input is required/);
});
