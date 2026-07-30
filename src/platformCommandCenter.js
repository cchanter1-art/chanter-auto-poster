'use strict';

const platformModules = require('./platformModules');
const platformStatus = require('./platformStatus');
const missionValue = require('./missionValue');

const SYSTEM_STATE = Object.freeze({
  HEALTHY: 'healthy',
  ATTENTION: 'attention',
  BLOCKED: 'blocked',
  UNKNOWN: 'unknown'
});

const SYSTEM_STATE_PRESENTATION = Object.freeze({
  [SYSTEM_STATE.HEALTHY]: {
    label: 'Healthy',
    chip: 'chip-ready',
    reason: 'Measured services are available and no work needs attention.'
  },
  [SYSTEM_STATE.ATTENTION]: {
    label: 'Attention',
    chip: 'chip-attention',
    reason: 'One or more measured items need a decision or configuration.'
  },
  [SYSTEM_STATE.BLOCKED]: {
    label: 'Blocked',
    chip: 'chip-failed',
    reason: 'A measured dependency or work source is unavailable.'
  },
  [SYSTEM_STATE.UNKNOWN]: {
    label: 'Unknown',
    chip: 'chip-neutral',
    reason: 'There is not enough measured data to claim platform health.'
  }
});

function loopbackHost(value) {
  const host = String(value || '').trim().split(':')[0].toLowerCase();
  return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host);
}

function environmentPresentation({ firestoreEmulatorHost = '' } = {}) {
  if (loopbackHost(firestoreEmulatorHost)) {
    return { id: 'local_controlled', label: 'Local Controlled', measured: true };
  }
  return { id: 'unknown', label: 'Environment unknown', measured: false };
}

function timestampOf(item) {
  return String(item && (item.updatedAt || item.createdAt) || '');
}

function newest(items) {
  return items.slice().sort((a, b) => timestampOf(b).localeCompare(timestampOf(a)));
}

function actionFor(item, intent = 'inspect') {
  const href = item && item.actionable && item.href ? String(item.href) : '';
  if (!href) {
    return {
      label: intent === 'evidence' ? 'View Evidence' : 'Inspect',
      href: '',
      enabled: false,
      reason: item && item.surface === platformModules.SURFACE_INTERNAL
        ? 'Internal control only.'
        : 'No customer-safe action is available.'
    };
  }
  const label = intent === 'evidence'
    ? 'View Evidence'
    : (item.state === platformStatus.WORK_STATE.WAITING_APPROVAL ? 'Open' : 'Inspect');
  return { label, href, enabled: true, reason: '' };
}

function evidenceAnchorFor(workId) {
  const encoded = Buffer.from(String(workId || ''), 'utf8').toString('base64url');
  return `mission-value-evidence-${encoded || 'unidentified'}`;
}

function decorateWork(items = []) {
  return items.map((item) => {
    const valueEvaluation = missionValue.evaluateMissionValue({
      work: item,
      contract: item.missionValueContract,
      evidence: item.missionValueEvidence
    });
    const evidenceAnchor = evidenceAnchorFor(item.workId);
    const verification = valueEvaluation.dimensions[missionValue.DIMENSION.VERIFICATION_STATE];
    return {
      ...item,
      updatedLabel: timestampOf(item) || 'Unavailable',
      evidenceState: item.evidenceUnavailable
        ? 'Unavailable'
        : (item.evidenceAvailable ? 'Available' : 'Not measured'),
      nextAction: actionFor(item),
      valueEvaluation,
      valueState: valueEvaluation.readinessPresentation.label,
      valueStateChip: valueEvaluation.readinessPresentation.chip,
      missingMeasurementsCount: valueEvaluation.missingMeasurements.length,
      valueObjective: valueEvaluation.contractDeclared
        ? missionValue.displayValue(
          missionValue.DIMENSION.OBJECTIVE_CLARITY,
          valueEvaluation.dimensions[missionValue.DIMENSION.OBJECTIVE_CLARITY]
        )
        : 'Not declared',
      valueVerification: missionValue.displayValue(
        missionValue.DIMENSION.VERIFICATION_STATE,
        verification
      ),
      valueReadinessChangeLabel: valueEvaluation.readinessChange.changed
        ? `Yes - ${missionValue.presentation(valueEvaluation.readinessChange.from).label} to ${missionValue.presentation(valueEvaluation.readinessChange.to).label}`
        : 'No',
      evidenceAnchor,
      valueEvidenceHref: item.evidenceAvailable
        ? `/platform/evidence#${evidenceAnchor}`
        : ''
    };
  });
}

// `emptyLabel` is the copy a group shows when it holds nothing while other work
// exists. It names the missing stage rather than repeating one generic line, so
// an empty group reads as a fact about that stage instead of as missing data.
// The whole-surface empty state is a different fact and is owned by the view.
function groupWork(items = []) {
  const groups = [
    {
      id: 'running',
      label: 'Running',
      emptyLabel: 'Nothing is being prepared right now.',
      items: items.filter((item) => item.state === platformStatus.WORK_STATE.RUNNING)
    },
    {
      id: 'waiting',
      label: 'Waiting',
      emptyLabel: 'Nothing is waiting for review or approval.',
      items: items.filter((item) => [
        platformStatus.WORK_STATE.WAITING_APPROVAL,
        platformStatus.WORK_STATE.PAUSED,
        platformStatus.WORK_STATE.IDLE
      ].includes(item.state))
    },
    {
      id: 'attention',
      label: 'Needs attention',
      emptyLabel: 'Nothing needs attention.',
      items: items.filter((item) => item.state === platformStatus.WORK_STATE.FAILED)
    },
    {
      id: 'complete',
      label: 'Complete',
      emptyLabel: 'Nothing has completed yet.',
      items: items.filter((item) => item.state === platformStatus.WORK_STATE.COMPLETED)
    }
  ];
  return groups;
}

function attentionItems({ work, health, connections, providerStatuses }) {
  const attention = [];
  if (work.error) {
    attention.push({
      id: 'work-unavailable',
      severity: 'blocked',
      title: 'Work unavailable',
      detail: work.error,
      href: '/platform/health',
      action: 'Inspect'
    });
  }
  for (const entry of work.degraded || []) {
    attention.push({
      id: `degraded-${entry.moduleId}`,
      severity: 'attention',
      title: `${entry.moduleName} is unavailable`,
      detail: entry.reason,
      href: '/platform/health',
      action: 'Inspect'
    });
  }
  for (const item of work.items || []) {
    if (item.state === platformStatus.WORK_STATE.FAILED) {
      attention.push({
        id: `failed-${item.workId}`,
        severity: 'blocked',
        title: item.title,
        detail: item.stateReason,
        href: item.actionable ? item.href : '/platform/work',
        action: 'Inspect'
      });
    } else if (item.needsApproval) {
      attention.push({
        id: `approval-${item.workId}`,
        severity: 'attention',
        title: item.title,
        detail: item.actionable ? 'A customer decision is waiting.' : 'An internal decision is waiting.',
        href: item.actionable ? item.href : '/platform/approvals',
        action: item.actionable ? 'Open' : 'Inspect'
      });
    }
  }
  if (health.storage.reachable === false) {
    attention.push({
      id: 'storage-unreachable',
      severity: 'blocked',
      title: 'Storage is unreachable',
      detail: 'The measured Firestore health probe failed.',
      href: '/platform/health',
      action: 'Inspect'
    });
  } else if (health.storage.reachable == null) {
    attention.push({
      id: 'storage-unknown',
      severity: 'unknown',
      title: 'Storage is not measured',
      detail: 'No storage health claim is available.',
      href: '/platform/health',
      action: 'Inspect'
    });
  }
  if (connections.error) {
    attention.push({
      id: 'connections-unavailable',
      severity: 'unknown',
      title: 'Connected channels unavailable',
      detail: connections.error,
      href: '/platform/health',
      action: 'Inspect'
    });
  } else if (connections.publishingReadyCount === 0) {
    attention.push({
      id: 'connections-empty',
      severity: 'attention',
      title: 'No publishing-ready channel',
      detail: 'Connect a supported channel before preparing work.',
      href: '/platform/autoposter/accounts',
      action: 'Open'
    });
  }
  if (!providerStatuses.some((status) => status.available)) {
    attention.push({
      id: 'providers-unconfigured',
      severity: 'attention',
      title: 'Publishing providers are not configured',
      detail: 'Provider configuration is absent on this environment.',
      href: '/platform/health',
      action: 'Inspect'
    });
  }
  return attention;
}

function systemStateOf({ attention, work, health }) {
  if (
    work.error ||
    health.storage.reachable === false ||
    attention.some((item) => item.severity === 'blocked')
  ) {
    return SYSTEM_STATE.BLOCKED;
  }
  if (attention.some((item) => item.severity === 'attention')) return SYSTEM_STATE.ATTENTION;
  if (health.storage.reachable == null || attention.some((item) => item.severity === 'unknown')) {
    return SYSTEM_STATE.UNKNOWN;
  }
  return SYSTEM_STATE.HEALTHY;
}

function moduleCards(modules, work) {
  return modules.map((module) => {
    const moduleItems = work.items.filter((item) => item.moduleId === module.id);
    const degraded = work.degraded.find((entry) => entry.moduleId === module.id);
    let status = module.surface === platformModules.SURFACE_INTERNAL ? 'Internal' : 'Available';
    let chip = module.surface === platformModules.SURFACE_INTERNAL ? 'chip-neutral' : 'chip-ready';
    if (degraded || work.error) {
      status = 'Unavailable';
      chip = 'chip-failed';
    } else if (moduleItems.some((item) => item.state === platformStatus.WORK_STATE.FAILED)) {
      status = 'Attention';
      chip = 'chip-attention';
    }
    return {
      ...module,
      status,
      chip,
      capability: module.surface === platformModules.SURFACE_CUSTOMER
        ? 'Compose, review, and inspect publishing work.'
        : 'Visible for ownership only. Controls remain internal.',
      action: module.href
        ? { label: 'Open', href: module.href, enabled: true, reason: '' }
        : { label: 'Inspect', href: '', enabled: false, reason: 'Internal control only.' }
    };
  });
}

function buildValueRibbon({ work, activeWork }) {
  const focus = activeWork.find((item) => item.valueEvaluation.contractDeclared)
    || work.items.find((item) => item.valueEvaluation.contractDeclared)
    || activeWork[0]
    || work.items[0]
    || null;
  const evaluation = focus
    ? focus.valueEvaluation
    : missionValue.evaluateMissionValue();
  function field(id, dimensionId, href) {
    const value = evaluation.dimensions[dimensionId];
    return {
      id,
      label: missionValue.DIMENSION_LABEL[dimensionId],
      value: missionValue.displayValue(dimensionId, value),
      provenance: missionValue.provenanceLabel(value),
      provenanceState: value.state,
      href
    };
  }
  return {
    fields: [
      field('objective', missionValue.DIMENSION.OBJECTIVE_CLARITY, '/platform/work'),
      field('acceptance', missionValue.DIMENSION.ACCEPTANCE_COVERAGE, '/platform/evidence'),
      field('time', missionValue.DIMENSION.TIME_TO_VERIFIED_OUTCOME, '/platform/evidence'),
      field('timeliness', missionValue.DIMENSION.TIMELINESS, '/platform/evidence'),
      field('attention', missionValue.DIMENSION.HUMAN_ATTENTION, '/platform/approvals'),
      field('cost', missionValue.DIMENSION.COST, '/platform/evidence'),
      field('risk', missionValue.DIMENSION.RISK, '/platform/work'),
      field('evidence', missionValue.DIMENSION.EVIDENCE_COVERAGE, '/platform/evidence'),
      field('verification', missionValue.DIMENSION.VERIFICATION_STATE, '/platform/evidence'),
      field('verified-value', missionValue.DIMENSION.VERIFIED_VALUE_STATE, '/platform/evidence')
    ],
    focusWorkId: focus ? focus.workId : '',
    focusTitle: focus ? focus.title : 'No mission selected',
    equation: 'No scalar score',
    canonicalEquation: 'Real AI Value = (Correct Objective x Capability x Controlled Execution x Verification x Learning x Timeliness) / (Cost x Risk x Friction x Time to Verified Outcome x Human Attention)',
    equationNote: 'Verified value requires every declared acceptance criterion to have exact linked verified evidence. Missing sources remain Not measured or Unavailable.',
    provenanceStates: [
      ['Measured', 'An actual existing source provides the fact.'],
      ['Declared', 'The mission value contract provides the fact.'],
      ['Inferred', 'Existing named facts deterministically produce the state.'],
      ['Unavailable', 'No source exists.'],
      ['Not applicable', 'A precise condition makes the dimension inapplicable.']
    ]
  };
}

function buildCommandCenter({
  work,
  health,
  connections = {},
  providerStatuses = [],
  modules = platformModules.listModules(),
  canonicalExecutionEnabled = false,
  runtimeControlConfigured = false,
  schedulerState = {},
  firestoreEmulatorHost = ''
}) {
  const normalizedWork = {
    items: decorateWork(work.items || []),
    summary: work.summary || platformStatus.summarizeWork([]),
    degraded: work.degraded || [],
    error: String(work.error || '')
  };
  const normalizedConnections = {
    publishingReadyCount: Number(connections.publishingReadyCount || 0),
    connectedCount: Number(connections.connectedCount || 0),
    providers: Array.isArray(connections.providers) ? connections.providers : [],
    error: String(connections.error || '')
  };
  const safeHealth = {
    ...health,
    storage: health && health.storage
      ? health.storage
      : { provider: 'firestore', mode: 'unknown', reachable: null }
  };
  const attention = attentionItems({
    work: normalizedWork,
    health: safeHealth,
    connections: normalizedConnections,
    providerStatuses
  });
  const systemState = systemStateOf({ attention, work: normalizedWork, health: safeHealth });
  const evidenceItems = newest(normalizedWork.items.filter((item) => (
    item.evidenceAvailable || item.valueEvaluation.contractDeclared
  )));
  const durableEvidenceItems = evidenceItems.filter((item) => item.evidenceAvailable);
  const activeWork = normalizedWork.items.filter((item) => ![
    platformStatus.WORK_STATE.COMPLETED,
    platformStatus.WORK_STATE.IDLE
  ].includes(item.state));
  const environment = environmentPresentation({ firestoreEmulatorHost });

  return {
    environment,
    systemState: {
      id: systemState,
      ...SYSTEM_STATE_PRESENTATION[systemState]
    },
    attention: {
      count: attention.length,
      items: attention
    },
    work: normalizedWork,
    workGroups: groupWork(normalizedWork.items),
    activeWork: activeWork.slice(0, 5),
    modules: moduleCards(modules, normalizedWork),
    evidenceItems,
    recentEvidence: durableEvidenceItems.slice(0, 4),
    valueRibbon: buildValueRibbon({ work: normalizedWork, activeWork }),
    health: {
      application: { status: 'Available', measured: true },
      storage: safeHealth.storage,
      runtimeControl: {
        status: runtimeControlConfigured ? 'Configured' : 'Unavailable',
        configured: Boolean(runtimeControlConfigured)
      },
      scheduler: {
        mode: String(schedulerState.mode || 'unknown'),
        inMemoryTimer: Boolean(schedulerState.inMemoryTimer),
        lastTickAt: schedulerState.lastTickAt || null
      },
      canonicalExecution: {
        enabled: Boolean(canonicalExecutionEnabled),
        status: canonicalExecutionEnabled ? 'Enabled' : 'Disabled',
        defaultComposerPath: !canonicalExecutionEnabled
      },
      providers: providerStatuses.map((status) => ({
        id: status.id,
        name: status.displayName,
        configured: Boolean(status.configured),
        available: Boolean(status.available),
        status: status.available ? 'Available' : (status.configured ? 'Unavailable' : 'Not configured')
      })),
      connections: normalizedConnections,
      observedAt: safeHealth.observedAt || ''
    }
  };
}

module.exports = {
  SYSTEM_STATE,
  SYSTEM_STATE_PRESENTATION,
  environmentPresentation,
  actionFor,
  decorateWork,
  groupWork,
  buildCommandCenter
};
