'use strict';

// CHANTER Platform module-agnostic work ingestion: provider registration, mixed
// module aggregation, failure isolation, canonical state mapping for a second
// module, approval/evidence filtering, and customer/internal link safety.
//
// The registry and the Operator adapter are pure of I/O by construction, so
// everything here is deterministic: providers are plain functions, and the one
// network client under test is driven by an injected fetch that records every
// request it is asked to make. No provider is contacted, no socket is opened.

process.env.ADMIN_PASSWORD = 'test-admin-password-123';
process.env.OPENAI_API_KEY = 'test-openai-key';
process.env.ENABLE_INSTAGRAM = 'false';
process.env.YOUTUBE_ENABLED = 'false';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const platformModules = require('../src/platformModules');
const platformStatus = require('../src/platformStatus');
const platformWorkProviders = require('../src/platformWorkProviders');
const platformOperatorProvider = require('../src/platformOperatorProvider');
const { createAutoPosterWorkProvider } = require('../src/platformAutoPosterProvider');
const batchService = require('../src/batchService');
batchService.listDestinations = async () => ({ destinations: [] });

const auth = require('../src/auth');
auth.requireAdminPage = (req, res, next) => next();
auth.requireAdminApi = (req, res, next) => next();
auth.resolveUserId = () => 'owner';

const firestoreModule = require('../src/firestore');
firestoreModule.validateFirebaseConfig = () => {
  throw new Error('firebase is deliberately unconfigured for this test');
};
// The AutoPoster provider reconciles each batch through batchService.getBatchView,
// which resolves the workspace scope out of storage. Without this trap that read
// reaches the real project named in .env, so the file's "no socket is opened"
// contract held only for the code under test and not for the route tests below —
// and a slow network turned them into multi-minute hangs. Failing closed here
// keeps the reconciliation on the fallback path it already took, locally.
firestoreModule.getFirestore = () => {
  throw new Error('work provider tests must not reach storage');
};

const { WORK_STATE } = platformStatus;

// ── Fixtures ───────────────────────────────────────────────────────────────

const AUTOPOSTER_BATCHES = [
  {
    batchId: 'batch-waiting-0002', userId: 'owner', status: 'ready',
    itemCount: 3, preparedCount: 3, failedCount: 0, acceptedCount: 0,
    videoCount: 3, destinationCount: 1, createdAt: '2026-07-24T10:00:00.000Z'
  },
  {
    batchId: 'batch-donee-0004', userId: 'owner', status: 'completed',
    itemCount: 2, preparedCount: 2, failedCount: 0, acceptedCount: 2,
    videoCount: 2, destinationCount: 1, createdAt: '2026-07-24T12:00:00.000Z'
  }
];

// Exactly the shape Operator's GET /api/mission-graphs read model returns
// (MissionGraphView in apps/backend/src/missions/missionGraphService.ts).
const OPERATOR_GRAPHS = [
  {
    graphId: 'graph-approval-required-01',
    objective: 'Publish the weekly platform readiness digest',
    status: 'approval_required',
    approvalRequired: true,
    approvedBy: null,
    nodeCount: 3,
    nodes: [{ status: 'blocked' }, { status: 'blocked' }, { status: 'blocked' }],
    createdAt: '2026-07-24T14:00:00.000Z',
    updatedAt: '2026-07-24T14:00:00.000Z'
  },
  {
    graphId: 'graph-running-02',
    objective: 'Reconcile scheduled AutoPoster results',
    status: 'running',
    approvalRequired: true,
    approvedBy: 'founder',
    nodeCount: 4,
    nodes: [
      { status: 'completed' }, { status: 'completed' },
      { status: 'running' }, { status: 'failed_recoverable' }
    ],
    createdAt: '2026-07-24T15:00:00.000Z',
    updatedAt: '2026-07-24T15:30:00.000Z'
  }
];

function operatorProviderReturning(graphs) {
  return {
    moduleId: 'operator',
    listWork: async () => graphs.map(platformStatus.projectOperatorMissionGraph)
  };
}

function failingProvider(moduleId, message) {
  return {
    moduleId,
    listWork: async () => {
      throw new Error(message);
    }
  };
}

// ── Provider registration ──────────────────────────────────────────────────

test('a registry accepts a well-formed provider and reports what it registered', () => {
  const registry = platformWorkProviders.createWorkRegistry();
  registry.register(createAutoPosterWorkProvider({ listBatches: async () => ({ batches: [] }) }));
  registry.register(operatorProviderReturning([]));
  assert.deepEqual(registry.list(), ['autoposter', 'operator']);
});

test('AutoPoster reads standalone Runtime jobs only when canonical projection is enabled', async () => {
  let queueReads = 0;
  const options = {
    listBatches: async () => ({ batches: [] }),
    listQueue: async () => {
      queueReads += 1;
      return {
        items: [{
          id: 'runtime-job-provider',
          status: 'scheduled',
          approved: false,
          runtimeGraphId: 'graph:runtime-provider'
        }]
      };
    }
  };

  const legacyItems = await createAutoPosterWorkProvider(options).listWork({});
  assert.deepEqual(legacyItems, []);
  assert.equal(queueReads, 0);

  const canonicalItems = await createAutoPosterWorkProvider({
    ...options,
    includeCanonicalRuntimeJobs: true
  }).listWork({});
  assert.equal(queueReads, 1);
  assert.equal(canonicalItems.length, 1);
  assert.equal(canonicalItems[0].workId, 'runtime-job-provider');
  assert.equal(canonicalItems[0].runtimeGraphId, 'graph:runtime-provider');
});

test('duplicate module registration is rejected rather than double-counted', () => {
  const registry = platformWorkProviders.createWorkRegistry();
  registry.register(operatorProviderReturning([]));
  assert.throws(
    () => registry.register(operatorProviderReturning([])),
    /already registered/
  );
});

test('a provider must be an object, declare a moduleId and implement listWork', () => {
  const registry = platformWorkProviders.createWorkRegistry();
  assert.throws(() => registry.register(null), TypeError);
  assert.throws(() => registry.register({ listWork: async () => [] }), /moduleId/);
  assert.throws(() => registry.register({ moduleId: 'operator' }), /listWork/);
});

test('a provider for a module the platform does not declare is refused', () => {
  const registry = platformWorkProviders.createWorkRegistry();
  assert.throws(
    () => registry.register({ moduleId: 'not-a-module', listWork: async () => [] }),
    /not a declared platform module/
  );
});

// ── The aggregation layer owns no module ───────────────────────────────────

test('the aggregation layer has no direct dependency on any module service', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'platformWorkProviders.js'), 'utf8');
  assert.equal(/batchService/.test(source), false, 'the registry must not know batchService exists');
  assert.equal(/listBatches/.test(source), false, 'the registry must not know how AutoPoster stores work');
  // The only shared platform modules it may know are ownership, state, and
  // the pure mission-value contract validator.
  const required = Array.from(source.matchAll(/require\('\.\/([a-zA-Z]+)'\)/g)).map((match) => match[1]);
  assert.deepEqual(required.sort(), ['missionValue', 'platformModules', 'platformStatus']);
});

// ── Canonical state mapping for the second module ──────────────────────────

test('Operator mission graph statuses project onto the canonical platform states', () => {
  const stateOf = (status) => platformStatus.projectOperatorMissionGraph({ graphId: 'g', status }).state;
  assert.equal(stateOf('approval_required'), WORK_STATE.WAITING_APPROVAL);
  assert.equal(stateOf('approved'), WORK_STATE.RUNNING);
  assert.equal(stateOf('running'), WORK_STATE.RUNNING);
  assert.equal(stateOf('completed'), WORK_STATE.COMPLETED);
  assert.equal(stateOf('failed_recoverable'), WORK_STATE.FAILED);
  assert.equal(stateOf('failed_terminal'), WORK_STATE.FAILED);
  assert.equal(stateOf('cancelled'), WORK_STATE.PAUSED);
});

test('an unrecognised Operator status never claims work is running', () => {
  const unknown = platformStatus.projectOperatorMissionGraph({ graphId: 'g', status: 'teleported' });
  assert.equal(unknown.state, WORK_STATE.IDLE);
  assert.match(unknown.stateReason, /teleported/);
});

test('Operator node tallies fill the same counts column AutoPoster fills', () => {
  const running = platformStatus.projectOperatorMissionGraph(OPERATOR_GRAPHS[1]);
  assert.equal(running.counts.total, 4);
  assert.equal(running.counts.prepared, 2);
  assert.equal(running.counts.failed, 1);
  // Graph approval is granted once for the whole graph, so it clears every step.
  assert.equal(running.counts.accepted, 4);
  assert.equal(running.counts.awaiting, 0);
  assert.equal(running.needsApproval, false);
});

test('an unapproved Operator graph waits on an approver and proposes no link', () => {
  const waiting = platformStatus.projectOperatorMissionGraph(OPERATOR_GRAPHS[0]);
  assert.equal(waiting.state, WORK_STATE.WAITING_APPROVAL);
  assert.equal(waiting.counts.awaiting, 3);
  assert.equal(waiting.needsApproval, true);
  assert.equal(waiting.href, '');
  assert.equal(waiting.title, 'Publish the weekly platform readiness digest');
});

// ── Mixed-module aggregation ───────────────────────────────────────────────

test('an unavailable evidence bundle does not turn completed product work into a product failure', () => {
  const projected = platformStatus.projectOperatorAutoPosterCommand({
    commandId: `platform-autoposter-${'e'.repeat(40)}`,
    graphId: 'graph:evidence-unavailable',
    lifecycleState: 'completed',
    productState: 'draft_created',
    publicationApprovalState: 'human_required',
    campaignId: 'campaign-evidence-unavailable',
    jobIds: ['job-evidence-unavailable'],
    approvalId: 'autoposter-approval:mission-evidence-unavailable',
    evidenceBundleId: 'autoposter-evidence:graph:evidence-unavailable',
    evidenceAvailable: false,
    error: {
      code: 'PLATFORM_EVIDENCE_UNAVAILABLE',
      message: 'Evidence could not be read after the product result became durable.'
    }
  });

  assert.equal(projected.state, WORK_STATE.WAITING_APPROVAL);
  assert.equal(projected.needsApproval, true);
  assert.equal(projected.counts.failed, 0);
  assert.equal(projected.evidenceAvailable, false);
  assert.equal(projected.evidenceUnavailable, true);
});

async function collectMixed() {
  const registry = platformWorkProviders.createWorkRegistry();
  registry.register(createAutoPosterWorkProvider({ listBatches: async () => ({ batches: AUTOPOSTER_BATCHES }) }));
  registry.register(operatorProviderReturning(OPERATOR_GRAPHS));
  return registry.collect({});
}

test('work from two modules aggregates into one correctly counted projection', async () => {
  const collected = await collectMixed();
  assert.equal(collected.error, '');
  assert.deepEqual(collected.degraded, []);
  assert.equal(collected.items.length, 4);
  assert.deepEqual(
    [...new Set(collected.items.map((item) => item.moduleId))].sort(),
    ['autoposter', 'operator']
  );
  // 1 AutoPoster batch waiting + 1 Operator graph waiting; 1 Operator running.
  assert.equal(collected.summary.total, 4);
  assert.equal(collected.summary.awaitingApproval, 2);
  assert.equal(collected.summary.running, 1);
  assert.equal(collected.summary.failed, 0);
});

test('approval-first ordering holds across modules, not just within one', async () => {
  const collected = await collectMixed();
  assert.equal(collected.items[0].state, WORK_STATE.WAITING_APPROVAL);
  assert.equal(collected.items[1].state, WORK_STATE.WAITING_APPROVAL);
  // Both modules are represented in the approval-first block.
  assert.deepEqual(
    collected.items.slice(0, 2).map((item) => item.moduleId).sort(),
    ['autoposter', 'operator']
  );
});

test('every canonical item carries its owning module identity from the registry', async () => {
  const collected = await collectMixed();
  const operatorItem = collected.items.find((item) => item.moduleId === 'operator');
  const autoPosterItem = collected.items.find((item) => item.moduleId === 'autoposter');
  assert.equal(operatorItem.moduleName, 'Operator');
  assert.equal(operatorItem.owner, 'CHANTER Internal');
  assert.equal(operatorItem.surface, platformModules.SURFACE_INTERNAL);
  assert.equal(autoPosterItem.moduleName, 'AutoPoster');
  assert.equal(autoPosterItem.owner, 'CHANTER Platform');
  assert.equal(autoPosterItem.surface, platformModules.SURFACE_CUSTOMER);
});

// ── Customer / internal link safety ────────────────────────────────────────

test('a provider cannot link work into a surface its module does not own', async () => {
  const registry = platformWorkProviders.createWorkRegistry();
  // A hostile-or-buggy AutoPoster provider trying to link at an internal
  // console, another module's route, and an external origin.
  registry.register({
    moduleId: 'autoposter',
    listWork: async () => [
      { ...platformStatus.projectAutoPosterBatch(AUTOPOSTER_BATCHES[0]), href: '/private/runtime/console' },
      { ...platformStatus.projectAutoPosterBatch(AUTOPOSTER_BATCHES[1]), href: 'https://example.com/steal' }
    ]
  });
  const collected = await registry.collect({});
  for (const item of collected.items) {
    assert.equal(item.href, '', 'a link outside the owning module route must be stripped');
  }
});

test('a customer module keeps links that stay inside its own declared route', async () => {
  const registry = platformWorkProviders.createWorkRegistry();
  registry.register(createAutoPosterWorkProvider({ listBatches: async () => ({ batches: AUTOPOSTER_BATCHES }) }));
  const collected = await registry.collect({});
  for (const item of collected.items) {
    assert.equal(item.href, `/platform/autoposter/compose/${item.workId}`);
    assert.equal(item.actionable, true);
  }
});

test('internal module work is never linkable, whatever route it claims', async () => {
  const registry = platformWorkProviders.createWorkRegistry();
  // An internal provider claiming another module's customer route.
  registry.register({
    moduleId: 'operator',
    listWork: async () => [{
      ...platformStatus.projectOperatorMissionGraph(OPERATOR_GRAPHS[0]),
      href: '/platform/compose/not-yours'
    }]
  });
  const collected = await registry.collect({});
  const item = collected.items[0];
  assert.equal(item.href, '', 'internal work must carry no link');
  assert.equal(item.actionable, false, 'internal work must not be actionable here');
});

// Internal work still counts honestly. Hiding it from the approval tally would
// make the platform understate what CHANTER is waiting on; what it must withhold
// is the control, not the fact.
test('internal work waiting on an approver is counted but offers no control', async () => {
  const registry = platformWorkProviders.createWorkRegistry();
  registry.register(operatorProviderReturning([OPERATOR_GRAPHS[0]]));
  const collected = await registry.collect({});
  const item = collected.items[0];
  assert.equal(item.needsApproval, true, 'the platform must not understate what is waiting');
  assert.equal(collected.summary.awaitingApproval, 1);
  assert.equal(item.actionable, false);
  assert.equal(item.href, '', 'counted, but with nothing to click');
});

// ── Provider failure isolation ─────────────────────────────────────────────

test('one failed provider degrades alone and the others still report', async () => {
  const registry = platformWorkProviders.createWorkRegistry();
  registry.register(createAutoPosterWorkProvider({ listBatches: async () => ({ batches: AUTOPOSTER_BATCHES }) }));
  registry.register(failingProvider('operator', 'operator is offline for test'));

  const collected = await registry.collect({});
  // AutoPoster's work survives intact.
  assert.equal(collected.items.length, 2);
  assert.equal(collected.summary.total, 2);
  assert.ok(collected.items.every((item) => item.moduleId === 'autoposter'));
  // The failure is named, and it is NOT reported as a total outage.
  assert.equal(collected.error, '', 'a partial read must not be reported as unavailable');
  assert.equal(collected.degraded.length, 1);
  assert.equal(collected.degraded[0].moduleId, 'operator');
  assert.equal(collected.degraded[0].moduleName, 'Operator');
  assert.match(collected.degraded[0].reason, /operator is offline for test/);
});

test('linked Operator command, graph, and AutoPoster runtime job project as one AutoPoster row', async () => {
  const graphId = 'graph:canonical:one';
  const commandId = `platform-autoposter-${'a'.repeat(40)}`;
  const runtimeJob = platformStatus.projectAutoPosterRuntimeJob({
    id: 'runtime-job-1',
    status: 'scheduled',
    approved: false,
    runtimeGraphId: graphId,
    runtimeMissionId: 'graph:canonical:one:node:schedule',
    campaignId: 'campaign-1',
    approvalId: 'autoposter-approval:graph:canonical:one:node:schedule',
    evidenceBundleId: 'autoposter-evidence:graph:canonical:one',
    scheduledAt: '2026-07-27T09:00:00.000Z',
    createdAt: '2026-07-26T09:00:02.000Z',
    history: [{ event: 'runtime_scheduled' }]
  });
  const graph = {
    ...platformStatus.projectOperatorMissionGraph({
      graphId,
      objective: 'Canonical AutoPoster work',
      status: 'completed',
      approvedBy: 'admin:owner',
      nodeCount: 1,
      nodes: [{ status: 'completed' }],
      createdAt: '2026-07-26T09:00:00.000Z'
    }),
    stateReason: 'Operator recovery is an internal control action.'
  };
  const command = platformStatus.projectOperatorAutoPosterCommand({
    commandId,
    graphId,
    missionId: 'graph:canonical:one:node:schedule',
    lifecycleState: 'completed',
    productState: 'scheduled_unapproved',
    publicationApprovalState: 'human_required',
    campaignId: 'campaign-1',
    jobIds: ['runtime-job-1'],
    approvalId: 'autoposter-approval:graph:canonical:one:node:schedule',
    evidenceBundleId: 'autoposter-evidence:graph:canonical:one',
    createdAt: '2026-07-26T09:00:00.000Z',
    updatedAt: '2026-07-26T09:00:03.000Z'
  });

  const registry = platformWorkProviders.createWorkRegistry();
  registry.register({ moduleId: 'autoposter', listWork: async () => [runtimeJob] });
  registry.register({ moduleId: 'operator', listWork: async () => [graph, command] });
  const collected = await registry.collect({});

  assert.equal(collected.items.length, 1, 'Work contains one coherent row');
  assert.equal(collected.items.filter((item) => item.needsApproval).length, 1, 'Approvals contains it once');
  assert.equal(collected.items.filter((item) => item.evidenceAvailable).length, 1, 'Evidence contains it once');
  const item = collected.items[0];
  assert.equal(item.moduleId, 'autoposter');
  assert.equal(item.workId, commandId);
  assert.equal(item.runtimeGraphId, graphId);
  assert.equal(item.productJobId, 'runtime-job-1');
  assert.equal(item.href, `/platform/autoposter/compose/commands/${commandId}`);
  assert.equal(item.actionable, true);
  assert.equal(item.stateReason, 'Draft scheduled; waiting for human publication approval.');
  assert.doesNotMatch(item.stateReason, /Operator|internal control|recovery/i);
  assert.deepEqual(item.linkage, {
    commandAvailable: true,
    operatorGraphAvailable: true,
    productAvailable: true
  });
  assert.equal(collected.summary.total, 1);
  assert.equal(collected.summary.awaitingApproval, 1);
});

test('a graphless accepted command remains visible as AutoPoster work with a safe detail link', async () => {
  const commandId = `platform-autoposter-${'f'.repeat(40)}`;
  const command = platformStatus.projectOperatorAutoPosterCommand({
    commandId,
    lifecycleState: 'failed_recoverable',
    productState: 'failed',
    error: {
      code: 'PLATFORM_COMMAND_EXECUTION_FAILED',
      message: 'Canonical execution did not bind a graph.'
    },
    createdAt: '2026-07-26T09:30:00.000Z'
  });
  const registry = platformWorkProviders.createWorkRegistry();
  registry.register({ moduleId: 'operator', listWork: async () => [command] });
  const collected = await registry.collect({});

  assert.equal(collected.items.length, 1);
  const item = collected.items[0];
  assert.equal(item.moduleId, 'autoposter');
  assert.equal(item.workId, commandId);
  assert.equal(item.state, WORK_STATE.FAILED);
  assert.equal(item.stateReason, 'Accepted AutoPoster work failed before a product draft was created.');
  assert.doesNotMatch(item.stateReason, /Operator|graph|mission|internal/i);
  assert.equal(item.href, `/platform/autoposter/compose/commands/${commandId}`);
  assert.equal(item.actionable, true);
});

test('linked product remains visible without falsely advertising unavailable evidence', async () => {
  const graphId = 'graph:evidence-degraded-linked';
  const commandId = `platform-autoposter-${'b'.repeat(40)}`;
  const product = platformStatus.projectAutoPosterRuntimeJob({
    id: 'runtime-job-evidence-degraded',
    status: 'scheduled',
    approved: false,
    runtimeGraphId: graphId,
    evidenceBundleId: `autoposter-evidence:${graphId}`
  });
  const graph = platformStatus.projectOperatorMissionGraph({
    graphId,
    status: 'completed',
    nodeCount: 1,
    nodes: [{ status: 'completed' }]
  });
  const command = platformStatus.projectOperatorAutoPosterCommand({
    commandId,
    graphId,
    lifecycleState: 'completed',
    productState: 'draft_created',
    publicationApprovalState: 'human_required',
    jobIds: ['runtime-job-evidence-degraded'],
    evidenceBundleId: `autoposter-evidence:${graphId}`,
    evidenceAvailable: false,
    error: {
      code: 'PLATFORM_EVIDENCE_UNAVAILABLE',
      message: 'Internal evidence read failed.'
    }
  });
  const registry = platformWorkProviders.createWorkRegistry();
  registry.register({ moduleId: 'autoposter', listWork: async () => [product] });
  registry.register({ moduleId: 'operator', listWork: async () => [graph, command] });
  const collected = await registry.collect({});

  assert.equal(collected.items.length, 1);
  assert.equal(collected.items[0].state, WORK_STATE.WAITING_APPROVAL);
  assert.equal(collected.items[0].evidenceAvailable, false);
  assert.equal(collected.items[0].evidenceUnavailable, true);
});

test('multiple product jobs on one graph surface one explicit non-actionable linkage conflict', async () => {
  const graphId = 'graph:product-conflict';
  const commandId = `platform-autoposter-${'d'.repeat(40)}`;
  const product = (id) => platformStatus.projectAutoPosterRuntimeJob({
    id,
    status: 'scheduled',
    approved: false,
    runtimeGraphId: graphId,
    createdAt: '2026-07-26T09:45:00.000Z'
  });
  const command = platformStatus.projectOperatorAutoPosterCommand({
    commandId,
    graphId,
    lifecycleState: 'completed',
    productState: 'draft_created',
    publicationApprovalState: 'human_required',
    jobIds: ['runtime-job-conflict-a', 'runtime-job-conflict-b']
  });
  const registry = platformWorkProviders.createWorkRegistry();
  registry.register({
    moduleId: 'autoposter',
    listWork: async () => [product('runtime-job-conflict-a'), product('runtime-job-conflict-b')]
  });
  registry.register({ moduleId: 'operator', listWork: async () => [command] });
  const collected = await registry.collect({});

  assert.equal(collected.items.length, 1);
  const item = collected.items[0];
  assert.equal(item.moduleId, 'autoposter');
  assert.equal(item.workId, commandId);
  assert.equal(item.state, WORK_STATE.FAILED);
  assert.equal(item.counts.total, 2);
  assert.equal(item.counts.failed, 1);
  assert.match(item.stateReason, /multiple AutoPoster product jobs/i);
  assert.equal(item.href, '');
  assert.equal(item.actionable, false);
  assert.equal(item.productJobId, '');
  assert.equal(item.linkage.productConflict, true);
});

test('linked product truth remains visible and Operator failure remains honestly degraded', async () => {
  const runtimeJob = platformStatus.projectAutoPosterRuntimeJob({
    id: 'runtime-job-degraded',
    status: 'scheduled',
    approved: false,
    runtimeGraphId: 'graph:degraded',
    campaignId: 'campaign-degraded',
    evidenceBundleId: 'autoposter-evidence:graph:degraded',
    createdAt: '2026-07-26T10:00:00.000Z'
  });
  const registry = platformWorkProviders.createWorkRegistry();
  registry.register({ moduleId: 'autoposter', listWork: async () => [runtimeJob] });
  registry.register(failingProvider('operator', 'operator command read is unavailable'));
  const collected = await registry.collect({});

  assert.equal(collected.items.length, 1);
  assert.equal(collected.items[0].workId, 'runtime-job-degraded');
  assert.notEqual(collected.items[0].workId, 'graph:degraded');
  assert.equal(collected.items[0].productJobId, 'runtime-job-degraded');
  assert.equal(collected.degraded.length, 1);
  assert.equal(collected.degraded[0].moduleId, 'operator');
  assert.match(collected.degraded[0].reason, /unavailable/);
  assert.equal(collected.error, '', 'one readable product source is not a total outage');
});

test('a failed provider is never rendered as an empty one', async () => {
  const registry = platformWorkProviders.createWorkRegistry();
  registry.register(failingProvider('operator', 'unreachable'));
  const collected = await registry.collect({});
  assert.equal(collected.items.length, 0);
  // Every provider failed, so this IS a total outage and says so.
  assert.match(collected.error, /unreachable/);
  assert.equal(collected.degraded.length, 1);
});

test('a provider that answers with the wrong shape is degraded, not trusted', async () => {
  const registry = platformWorkProviders.createWorkRegistry();
  registry.register({ moduleId: 'operator', listWork: async () => ({ nope: true }) });
  const collected = await registry.collect({});
  assert.equal(collected.items.length, 0);
  assert.match(collected.error, /array of work items/);
});

test('unreadable rows inside an otherwise healthy provider are counted, not silently dropped', async () => {
  const registry = platformWorkProviders.createWorkRegistry();
  registry.register({
    moduleId: 'autoposter',
    listWork: async () => [
      platformStatus.projectAutoPosterBatch(AUTOPOSTER_BATCHES[0]),
      { title: 'no work id at all' },
      null
    ]
  });
  const collected = await registry.collect({});
  assert.equal(collected.items.length, 1);
  assert.equal(collected.error, '');
  assert.match(collected.degraded[0].reason, /2 unreadable work record\(s\)/);
});

test('a hanging provider cannot hold back the modules that answered', async () => {
  const registry = platformWorkProviders.createWorkRegistry();
  registry.register(createAutoPosterWorkProvider({ listBatches: async () => ({ batches: AUTOPOSTER_BATCHES }) }));
  registry.register({
    moduleId: 'operator',
    listWork: async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      throw new Error('slow then broken');
    }
  });
  const collected = await registry.collect({});
  assert.equal(collected.items.length, 2);
  assert.equal(collected.degraded.length, 1);
});

// ── The Operator adapter is read-only by construction ──────────────────────

test('the Operator provider is not registered at all when it is not configured', () => {
  assert.equal(platformOperatorProvider.createOperatorWorkProvider({ baseUrl: '' }), null);
  assert.equal(platformOperatorProvider.createOperatorWorkProvider({}), null);
  assert.equal(platformOperatorProvider.createOperatorWorkProvider({ baseUrl: '   ' }), null);
});

test('the Operator provider issues one bounded GET against the read model', async () => {
  const requests = [];
  const provider = platformOperatorProvider.createOperatorWorkProvider({
    baseUrl: 'http://127.0.0.1:3001/',
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, status: 200, text: async () => JSON.stringify({ graphs: OPERATOR_GRAPHS }) };
    }
  });

  const items = await provider.listWork();
  assert.equal(requests.length, 1, 'exactly one request per read');
  assert.equal(requests[0].options.method, 'GET');
  assert.equal(requests[0].url, 'http://127.0.0.1:3001/api/mission-graphs?limit=25');
  assert.ok(requests[0].options.signal, 'the read must be abortable');
  assert.equal(items.length, 2);
  assert.equal(items[0].moduleId, 'operator');
});

test('the canonical feature adds one bounded command GET without adding a mutation', async () => {
  const commandId = `platform-autoposter-${'c'.repeat(40)}`;
  const requests = [];
  const provider = platformOperatorProvider.createOperatorWorkProvider({
    baseUrl: 'http://127.0.0.1:3001/',
    includeAutoPosterCommands: true,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (url.includes('/api/platform/autoposter-commands')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            commands: [{
              commandId,
              graphId: 'graph:canonical-provider',
              lifecycleState: 'completed',
              productState: 'draft_created',
              publicationApprovalState: 'human_required',
              jobIds: ['job-canonical-provider']
            }]
          })
        };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ graphs: [] }) };
    }
  });

  const items = await provider.listWork();
  assert.deepEqual(
    requests.map((request) => request.url).sort(),
    [
      'http://127.0.0.1:3001/api/mission-graphs?limit=25',
      'http://127.0.0.1:3001/api/platform/autoposter-commands?limit=25'
    ]
  );
  assert.ok(requests.every((request) => request.options.method === 'GET'));
  assert.ok(requests.every((request) => request.options.signal));
  assert.equal(items.length, 1);
  assert.equal(items[0].workId, commandId);
  assert.equal(items[0].workKind, 'autoposter_command');
});

test('the Operator adapter contains no code path that can mutate Operator state', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'platformOperatorProvider.js'), 'utf8');
  assert.equal(platformOperatorProvider.READ_ONLY_METHOD, 'GET');
  // No verb other than GET appears as a request method anywhere in the adapter.
  for (const verb of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.equal(source.includes(`'${verb}'`), false, `${verb} must not exist in the adapter`);
    assert.equal(source.includes(`"${verb}"`), false, `${verb} must not exist in the adapter`);
  }
  // And it only ever addresses the read model.
  assert.equal(/\/api\/mission-graphs/.test(source), true);
  assert.equal(/approve|resume|cancel|refresh/.test(source), false);
});

test('a non-http Operator base URL is refused instead of being requested', () => {
  assert.throws(() => platformOperatorProvider.missionGraphsUrl('file:///etc/passwd'), /http\(s\) origin/);
});

test('an Operator error status, non-JSON body or wrong shape surfaces as a failure', async () => {
  const build = (fetchImpl) => platformOperatorProvider.createOperatorWorkProvider({
    baseUrl: 'http://127.0.0.1:3001',
    fetchImpl
  });

  await assert.rejects(
    build(async () => ({ ok: false, status: 503, text: async () => '' })).listWork(),
    /answered 503/
  );
  await assert.rejects(
    build(async () => ({ ok: true, status: 200, text: async () => '<html>nope</html>' })).listWork(),
    /was not JSON/
  );
  await assert.rejects(
    build(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ missions: [] }) })).listWork(),
    /graphs array/
  );
});

// ── Live shell evidence over mixed-module work ─────────────────────────────

function startServer(platformRoutes) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'src', 'views'));
  app.use('/', platformRoutes);
  return new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
}

// The router registers its providers at require time from config, so the second
// provider is introduced the way production would: by configuring it before the
// module is loaded. Nothing about the shell surfaces is touched to make the
// Operator's work appear.
function loadRouterWithOperator(fetchImpl) {
  const configPath = require.resolve('../src/config');
  const routesPath = require.resolve('../src/platformRoutes');
  const operatorPath = require.resolve('../src/platformOperatorProvider');
  const previousBaseUrl = process.env.OPERATOR_BASE_URL;
  process.env.OPERATOR_BASE_URL = 'http://127.0.0.1:3001';
  delete require.cache[configPath];
  delete require.cache[routesPath];
  delete require.cache[operatorPath];

  const operatorModule = require('../src/platformOperatorProvider');
  const originalCreate = operatorModule.createOperatorWorkProvider;
  operatorModule.createOperatorWorkProvider = (options) => originalCreate({ ...options, fetchImpl });
  const router = require('../src/platformRoutes');
  operatorModule.createOperatorWorkProvider = originalCreate;

  return {
    router,
    restore() {
      if (previousBaseUrl === undefined) delete process.env.OPERATOR_BASE_URL;
      else process.env.OPERATOR_BASE_URL = previousBaseUrl;
      delete require.cache[configPath];
      delete require.cache[routesPath];
      delete require.cache[operatorPath];
      require('../src/config');
      require('../src/platformRoutes');
    }
  };
}

function okFetch(graphs) {
  return async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ graphs }) });
}

test('the shell renders mixed-module work with no module-specific branching', async (t) => {
  const originalListBatches = batchService.listBatches;
  const originalListSeries = batchService.listSeries;
  batchService.listBatches = async () => ({ batches: AUTOPOSTER_BATCHES });
  // Recurring series are a second registered producer. This file fakes the
  // durable reads, so it fakes this one too rather than reaching storage.
  batchService.listSeries = async () => ({ series: [] });
  const loaded = loadRouterWithOperator(okFetch(OPERATOR_GRAPHS));
  const server = await startServer(loaded.router);
  t.after(() => {
    batchService.listBatches = originalListBatches;
    batchService.listSeries = originalListSeries;
    server.close();
    loaded.restore();
  });

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const workPage = await (await fetch(`${baseUrl}/platform/work`)).text();

  // 1. Both modules appear on the Work surface, each labelled from the registry.
  assert.ok(workPage.includes('data-module="autoposter"'));
  assert.ok(workPage.includes('data-module="operator"'));
  assert.ok(workPage.includes('data-work="batch-waiting-0002"'));
  assert.ok(workPage.includes('data-work="graph-approval-required-01"'));
  assert.ok(workPage.includes('Operator'), 'the module label comes from the registry');

  // 2. AutoPoster rows stay openable; Operator rows are inert.
  assert.match(workPage, /data-work="batch-waiting-0002"[^>]*data-actionable="true"/);
  assert.match(workPage, /data-work="graph-approval-required-01"[^>]*data-actionable="false"/);

  // 3. No link on any shell surface leaves the customer platform.
  const hrefs = Array.from(workPage.matchAll(/href="([^"]+)"/g))
    .map((match) => match[1])
    .filter((href) => !href.endsWith('.css'));
  for (const href of hrefs) {
    assert.ok(
      href.startsWith('/platform') || href.startsWith('/private/autoposter'),
      `work surface links outside the customer surface: ${href}`
    );
  }
  // Specifically: nothing anywhere points into an Operator route.
  assert.equal(/href="[^"]*operator/i.test(workPage), false);

  // 4. Approvals carries both modules' waiting work, and offers to open only
  //    the one this customer can actually approve.
  const approvals = await (await fetch(`${baseUrl}/platform/approvals`)).text();
  assert.ok(approvals.includes('data-work="batch-waiting-0002"'));
  assert.ok(approvals.includes('data-work="graph-approval-required-01"'));
  assert.ok(approvals.includes('Customer decision'));
  assert.ok(approvals.includes('Internal decision'));
  assert.match(approvals, /href="\/platform\/autoposter\/compose\/batch-waiting-0002"[^>]*>Open<\/a>/);
  assert.equal(approvals.includes('data-work="batch-donee-0004"'), false);

  // 5. Evidence indexes both modules.
  const evidence = await (await fetch(`${baseUrl}/platform/evidence`)).text();
  assert.ok(evidence.includes('data-work="batch-donee-0004"'));
  assert.ok(evidence.includes('data-work="graph-running-02"'));

  // 6. The API reports both providers and mixed-module counts.
  const api = await (await fetch(`${baseUrl}/api/platform/work`)).json();
  assert.equal(api.ok, true);
  // Three producers now: AutoPoster batches, recurring series (owned by the
  // publishing-queue module), and Operator.
  assert.deepEqual(api.providers, ['autoposter', 'publishing-queue', 'operator']);
  assert.deepEqual(api.degraded, []);
  assert.equal(api.summary.total, 4);
  assert.equal(api.summary.awaitingApproval, 2);

  // 7. Overview and System health count the same mixed total.
  const health = await (await fetch(`${baseUrl}/platform/health`)).text();
  assert.ok(health.includes('data-health="providers"'));
  assert.ok(health.includes('3 of 3 registered work sources answered.'));
});

test('a dead Operator degrades only itself while AutoPoster work still renders', async (t) => {
  const originalListBatches = batchService.listBatches;
  const originalListSeries = batchService.listSeries;
  batchService.listBatches = async () => ({ batches: AUTOPOSTER_BATCHES });
  // Recurring series are a second registered producer. This file fakes the
  // durable reads, so it fakes this one too rather than reaching storage.
  batchService.listSeries = async () => ({ series: [] });
  const loaded = loadRouterWithOperator(async () => {
    throw new Error('connect ECONNREFUSED 127.0.0.1:3001');
  });
  const server = await startServer(loaded.router);
  t.after(() => {
    batchService.listBatches = originalListBatches;
    batchService.listSeries = originalListSeries;
    server.close();
    loaded.restore();
  });

  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  for (const path of ['/platform', '/platform/work', '/platform/approvals', '/platform/evidence', '/platform/health']) {
    const response = await fetch(`${baseUrl}${path}`);
    assert.equal(response.status, 200, `${path} must degrade, not 500`);
  }

  const workPage = await (await fetch(`${baseUrl}/platform/work`)).text();
  // AutoPoster work is untouched by the Operator outage.
  assert.ok(workPage.includes('data-work="batch-waiting-0002"'));
  // The outage is named, and is NOT reported as the whole platform failing.
  assert.ok(workPage.includes('data-testid="work-degraded"'));
  assert.ok(workPage.includes('data-degraded="operator"'));
  assert.ok(workPage.includes('ECONNREFUSED'));
  assert.equal(workPage.includes('data-testid="work-error"'), false);

  const health = await (await fetch(`${baseUrl}/platform/health`)).text();
  assert.ok(health.includes('data-testid="health-work-degraded"'));
  assert.ok(health.includes('2 of 3 registered work sources answered.'));

  const api = await (await fetch(`${baseUrl}/api/platform/work`)).json();
  assert.equal(api.ok, true, 'a partial read is still a successful read');
  assert.equal(api.summary.total, 2);
  assert.equal(api.degraded.length, 1);
  assert.equal(api.degraded[0].moduleId, 'operator');
});

// ── Evidence capability filtering ──────────────────────────────────────────

test('evidence lists only work that carries a durable record', async (t) => {
  const originalListBatches = batchService.listBatches;
  const originalListSeries = batchService.listSeries;
  batchService.listBatches = async () => ({ batches: AUTOPOSTER_BATCHES });
  // Recurring series are a second registered producer. This file fakes the
  // durable reads, so it fakes this one too rather than reaching storage.
  batchService.listSeries = async () => ({ series: [] });
  // A graph with no compiled nodes has nothing to evidence yet.
  const loaded = loadRouterWithOperator(okFetch([
    ...OPERATOR_GRAPHS,
    {
      graphId: 'graph-no-evidence-03',
      objective: 'Compiled but empty',
      status: 'approval_required',
      approvedBy: null,
      nodeCount: 0,
      nodes: [],
      createdAt: '2026-07-24T16:00:00.000Z'
    }
  ]));
  const server = await startServer(loaded.router);
  t.after(() => {
    batchService.listBatches = originalListBatches;
    batchService.listSeries = originalListSeries;
    server.close();
    loaded.restore();
  });

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const workPage = await (await fetch(`${baseUrl}/platform/work`)).text();
  const evidence = await (await fetch(`${baseUrl}/platform/evidence`)).text();

  // The empty graph is real work and appears on Work...
  assert.ok(workPage.includes('data-work="graph-no-evidence-03"'));
  // ...but has no evidence to index, so it is not claimed on Evidence.
  assert.equal(evidence.includes('data-work="graph-no-evidence-03"'), false);
  assert.ok(evidence.includes('data-work="graph-running-02"'));

  // And it never reaches Approvals either: nothing is awaiting a step count of
  // zero, so no approval is invented for it.
  const approvals = await (await fetch(`${baseUrl}/platform/approvals`)).text();
  assert.equal(approvals.includes('data-work="graph-no-evidence-03"'), false);
});

// ── The default platform is unchanged ──────────────────────────────────────

test('with no Operator configured the platform registers AutoPoster alone', async (t) => {
  const originalListBatches = batchService.listBatches;
  const originalListSeries = batchService.listSeries;
  batchService.listBatches = async () => ({ batches: AUTOPOSTER_BATCHES });
  // Recurring series are a second registered producer. This file fakes the
  // durable reads, so it fakes this one too rather than reaching storage.
  batchService.listSeries = async () => ({ series: [] });
  const platformRoutes = require('../src/platformRoutes');
  const server = await startServer(platformRoutes);
  t.after(() => {
    batchService.listBatches = originalListBatches;
    batchService.listSeries = originalListSeries;
    server.close();
  });

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const api = await (await fetch(`${baseUrl}/api/platform/work`)).json();
  // AutoPoster batches and recurring series are two producers of the same
  // module registry; Operator stays absent because it is unconfigured, which
  // is the point of this assertion.
  assert.deepEqual(
    api.providers,
    ['autoposter', 'publishing-queue'],
    'an unconfigured integration registers nothing'
  );
  assert.deepEqual(api.degraded, [], 'unconfigured is not an outage');
  assert.equal(api.ok, true);
  assert.equal(api.summary.total, 2);
});

test('the work projection boundary rejects a malformed mission value contract', async () => {
  const registry = platformWorkProviders.createWorkRegistry();
  registry.register({
    moduleId: 'autoposter',
    listWork: async () => [{
      workId: 'malformed-value-contract',
      state: WORK_STATE.RUNNING,
      missionValueContract: {
        schema: 'chanter.mission-value-contract.v1',
        budgets: { humanAttentionMinutes: -5 }
      }
    }]
  });

  const collected = await registry.collect({});
  assert.equal(collected.items.length, 0);
  assert.equal(collected.degraded.length, 1);
  assert.match(collected.error, /Invalid mission value contract/);
  assert.match(collected.error, /humanAttentionMinutes/);
});

test('value metadata preserves source ownership and cannot create customer-safe internal actions', async () => {
  const contract = {
    schema: 'chanter.mission-value-contract.v1',
    objective: {
      statement: 'Verify the same declared objective.',
      acceptanceCriteria: ['Criterion is verified.']
    }
  };
  const registry = platformWorkProviders.createWorkRegistry();
  registry.register({
    moduleId: 'autoposter',
    listWork: async () => [{
      workId: 'customer-value-work',
      state: WORK_STATE.RUNNING,
      href: '/platform/autoposter/compose/customer-value-work',
      missionValueContract: contract
    }]
  });
  registry.register({
    moduleId: 'operator',
    listWork: async () => [{
      workId: 'internal-value-work',
      state: WORK_STATE.RUNNING,
      href: '/platform/autoposter/compose/forged-internal-action',
      missionValueContract: contract
    }]
  });

  const collected = await registry.collect({});
  const customer = collected.items.find((item) => item.workId === 'customer-value-work');
  const internal = collected.items.find((item) => item.workId === 'internal-value-work');

  assert.equal(customer.actionable, true);
  assert.equal(customer.href, '/platform/autoposter/compose/customer-value-work');
  assert.equal(internal.actionable, false);
  assert.equal(internal.href, '');
  assert.equal(internal.surface, platformModules.SURFACE_INTERNAL);
  assert.equal(internal.missionValueContract.objective.statement, contract.objective.statement);
});
