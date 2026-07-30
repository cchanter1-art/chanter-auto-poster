'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const platformCommandCenter = require('../src/platformCommandCenter');
const platformModules = require('../src/platformModules');
const platformStatus = require('../src/platformStatus');

function customerWork(overrides = {}) {
  return {
    workId: 'batch-review-01',
    workKind: 'autoposter_batch',
    moduleId: 'autoposter',
    moduleName: 'AutoPoster',
    surface: platformModules.SURFACE_CUSTOMER,
    title: 'Batch batch-review-01',
    state: platformStatus.WORK_STATE.WAITING_APPROVAL,
    stateReason: 'Prepared work is waiting for review.',
    counts: { total: 3, prepared: 3, awaiting: 3, accepted: 0, failed: 0 },
    needsApproval: true,
    evidenceAvailable: true,
    actionable: true,
    href: '/platform/autoposter/compose/batch-review-01',
    createdAt: '2026-07-29T09:00:00.000Z',
    updatedAt: '2026-07-29T09:05:00.000Z',
    ...overrides
  };
}

function input(items = [customerWork()]) {
  return {
    work: {
      items,
      summary: platformStatus.summarizeWork(items),
      degraded: [],
      error: ''
    },
    health: {
      ok: true,
      storage: { provider: 'firestore', mode: 'emulator', reachable: true },
      observedAt: '2026-07-29T09:06:00.000Z'
    },
    connections: {
      connectedCount: 0,
      publishingReadyCount: 0,
      providers: [],
      error: ''
    },
    providerStatuses: [
      { id: 'tiktok', displayName: 'TikTok', configured: false, available: false }
    ],
    canonicalExecutionEnabled: false,
    runtimeControlConfigured: true,
    schedulerState: { mode: 'external_cron', inMemoryTimer: false, lastTickAt: null },
    firestoreEmulatorHost: '127.0.0.1:8088'
  };
}

test('command center preserves controlled-local and default Composer truth', () => {
  const result = platformCommandCenter.buildCommandCenter(input());

  assert.equal(result.environment.label, 'Local Controlled');
  assert.equal(result.health.canonicalExecution.enabled, false);
  assert.equal(result.health.canonicalExecution.defaultComposerPath, true);
  assert.equal(result.health.scheduler.inMemoryTimer, false);
  assert.equal(result.health.runtimeControl.configured, true);
});

test('value ribbon refuses to invent an unmeasured score', () => {
  const result = platformCommandCenter.buildCommandCenter(input());
  const values = Object.fromEntries(result.valueRibbon.fields.map((field) => [field.id, field.value]));

  assert.equal(values.time, 'Not measured');
  assert.equal(values.risk, 'Not measured');
  assert.equal(values['verified-value'], 'Not measured');
  assert.equal(values.evidence, 'Not measured');
  assert.equal(values.cost, 'Unavailable');
  assert.equal(result.valueRibbon.equation, 'No scalar score');
  assert.match(result.valueRibbon.equationNote, /exact linked verified evidence/);
  assert.equal(Object.prototype.hasOwnProperty.call(result.valueRibbon, 'score'), false);
});

test('criterion-linked verified evidence advances the shared read-only value projection', () => {
  const item = customerWork({
    missionValueContract: {
      schema: 'chanter.mission-value-contract.v1',
      objective: {
        statement: 'Prepare the founder review batch.',
        acceptanceCriteria: ['Every draft is prepared.']
      },
      budgets: {
        cost: { currency: 'USD', maximum: 5 },
        humanAttentionMinutes: 10,
        riskTolerance: 'low'
      },
      expected: {
        evidenceRequired: 1,
        reversibility: 'reversible'
      }
    },
    missionValueEvidence: [{
      evidenceId: 'evidence-prepared',
      acceptanceCriterion: 'Every draft is prepared.',
      verificationState: 'verified',
      source: 'existing batch evidence',
      observedAt: '2026-07-29T09:05:00.000Z'
    }]
  });
  const result = platformCommandCenter.buildCommandCenter(input([item]));
  const values = Object.fromEntries(result.valueRibbon.fields.map((field) => [field.id, field.value]));
  const projected = result.work.items[0];

  assert.equal(values.objective, 'Prepare the founder review batch.');
  assert.equal(values.acceptance, '1 of 1 criteria verified');
  assert.equal(values.cost, 'Unavailable');
  assert.equal(values.attention, 'Unavailable');
  assert.equal(values.risk, 'low tolerance');
  assert.equal(values['verified-value'], 'Verified');
  assert.equal(projected.valueState, 'Verified');
  assert.equal(projected.valueReadinessChangeLabel, 'Yes - Verification pending to Verified');
  assert.match(projected.valueEvidenceHref, /^\/platform\/evidence#/);
});

test('work groups and actions reuse canonical state and module authority', () => {
  const internal = customerWork({
    workId: 'graph-internal-01',
    moduleId: 'operator',
    moduleName: 'Operator',
    surface: platformModules.SURFACE_INTERNAL,
    actionable: false,
    href: '',
    evidenceAvailable: false
  });
  const result = platformCommandCenter.buildCommandCenter(input([customerWork(), internal]));
  const waiting = result.workGroups.find((group) => group.id === 'waiting');
  const internalItem = result.work.items.find((item) => item.workId === internal.workId);
  const operatorModule = result.modules.find((module) => module.id === 'operator');

  assert.equal(waiting.items.length, 2);
  assert.equal(internalItem.nextAction.enabled, false);
  assert.equal(internalItem.nextAction.label, 'Inspect');
  assert.equal(operatorModule.action.enabled, false);
  assert.equal(operatorModule.action.href, '');
  assert.deepEqual(
    [...new Set(result.attention.items.map((item) => item.action))].sort(),
    ['Inspect', 'Open']
  );
});

test('every work group carries its own stage-specific empty copy', () => {
  const result = platformCommandCenter.buildCommandCenter(input());
  const byId = Object.fromEntries(result.workGroups.map((group) => [group.id, group]));

  assert.deepEqual(Object.keys(byId), ['running', 'waiting', 'attention', 'complete']);
  assert.equal(byId.running.emptyLabel, 'Nothing is being prepared right now.');
  assert.equal(byId.waiting.emptyLabel, 'Nothing is waiting for review or approval.');
  assert.equal(byId.attention.emptyLabel, 'Nothing needs attention.');
  assert.equal(byId.complete.emptyLabel, 'Nothing has completed yet.');
  // The copy is per stage, never one line repeated four times.
  const labels = result.workGroups.map((group) => group.emptyLabel);
  assert.equal(new Set(labels).size, labels.length);
});

test('unknown storage and environment remain explicitly unavailable', () => {
  const values = input([]);
  values.work.summary = platformStatus.summarizeWork([]);
  values.health.storage.reachable = null;
  values.firestoreEmulatorHost = '';
  const result = platformCommandCenter.buildCommandCenter(values);

  assert.equal(result.environment.label, 'Environment unknown');
  assert.equal(result.systemState.label, 'Attention');
  assert.ok(result.attention.items.some((item) => item.title === 'Storage is not measured'));
  assert.equal(result.valueRibbon.fields.find((field) => field.id === 'objective').value, 'Not declared');
  assert.equal(result.valueRibbon.fields.find((field) => field.id === 'evidence').value, 'Not measured');
});
