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
  assert.equal(values.evidence, '1 of 1 work items');
  assert.equal(result.valueRibbon.equation, 'V = (O * E) / (T * H * R)');
  assert.match(result.valueRibbon.equationNote, /No value score is calculated/);
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

test('unknown storage and environment remain explicitly unavailable', () => {
  const values = input([]);
  values.work.summary = platformStatus.summarizeWork([]);
  values.health.storage.reachable = null;
  values.firestoreEmulatorHost = '';
  const result = platformCommandCenter.buildCommandCenter(values);

  assert.equal(result.environment.label, 'Environment unknown');
  assert.equal(result.systemState.label, 'Attention');
  assert.ok(result.attention.items.some((item) => item.title === 'Storage is not measured'));
  assert.equal(result.valueRibbon.fields.find((field) => field.id === 'objective').value, 'Unavailable');
  assert.equal(result.valueRibbon.fields.find((field) => field.id === 'evidence').value, 'Unavailable');
});
