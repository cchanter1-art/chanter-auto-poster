'use strict';

// Pure, customer-safe mission-value projection for the existing AutoPoster
// batch work producer. The caller supplies one durable batch record and the
// exact durable child-post view already owned by batchService. This module has
// no storage, clock, provider, approval, scheduler, or execution dependency.

const { MISSION_VALUE_SCHEMA } = require('./missionValue');

const ACCEPTANCE_CRITERION = Object.freeze({
  PERSISTED: 'The requested publishing work is durably persisted.',
  SCHEDULE: 'The requested schedule and destinations are preserved.',
  APPROVAL: 'Required publication approval is preserved before dispatch.',
  PROVIDER_OUTCOME: 'A durable provider outcome is recorded after dispatch.'
});

const ACCEPTANCE_CRITERIA = Object.freeze([
  ACCEPTANCE_CRITERION.PERSISTED,
  ACCEPTANCE_CRITERION.SCHEDULE,
  ACCEPTANCE_CRITERION.APPROVAL,
  ACCEPTANCE_CRITERION.PROVIDER_OUTCOME
]);

const WORK_ID = /^[A-Za-z0-9_-]{1,128}$/;
const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/;
const CUSTOMER_QUEUE_STATES = new Set([
  'pending',
  'scheduled',
  'ready',
  'processing',
  'posted',
  'failed',
  'outcome_unknown'
]);
const PROVIDER_RESULT_MODES = new Set(['api', 'api_reconciliation']);
const PROVIDER_TERMINAL_HISTORY = new Set([
  'posted',
  'provider_reconciled',
  'failed',
  'attempt_budget_exhausted'
]);
const PROVIDER_PENDING_HISTORY = new Set([
  'retry_scheduled',
  'outcome_unknown',
  'provider_reconciliation_required',
  'provider_visibility_contradiction'
]);

function validTimestamp(value) {
  if (typeof value !== 'string') return false;
  const match = value.match(ISO_TIMESTAMP);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] == null ? 0 : Number(match[8]);
  const offsetMinute = match[9] == null ? 0 : Number(match[9]);
  return (
    month >= 1
    && month <= 12
    && day >= 1
    && day <= new Date(Date.UTC(year, month, 0)).getUTCDate()
    && hour <= 23
    && minute <= 59
    && second <= 59
    && offsetHour <= 23
    && offsetMinute <= 59
  );
}

function positiveInteger(value) {
  return Number.isInteger(Number(value)) && Number(value) > 0
    ? Number(value)
    : null;
}

function latestTimestamp(values) {
  return values
    .filter(validTimestamp)
    .sort((left, right) => Date.parse(left) - Date.parse(right))
    .at(-1) || null;
}

function earliestTimestamp(values) {
  return values
    .filter(validTimestamp)
    .sort((left, right) => Date.parse(left) - Date.parse(right))
    .at(0) || null;
}

function historyEntries(item, events) {
  const accepted = new Set(Array.isArray(events) ? events : [events]);
  return (Array.isArray(item.history) ? item.history : [])
    .filter((entry) => entry && accepted.has(String(entry.event || '')))
    .filter((entry) => validTimestamp(entry.at));
}

function historyTimestamp(item, events, edge = 'latest') {
  const timestamps = historyEntries(item, events).map((entry) => entry.at);
  return edge === 'earliest' ? earliestTimestamp(timestamps) : latestTimestamp(timestamps);
}

function isInternalItem(item) {
  const creationSource = String(item.creationSource || '').trim().toLowerCase();
  return Boolean(
    String(item.runtimeGraphId || '').trim()
    || String(item.runtimeMissionId || '').trim()
    || String(item.runtimeAction || '').trim()
    || creationSource.includes('operator')
    || creationSource.includes('runtime')
    || creationSource.includes('canonical')
  );
}

function destinationKey(item) {
  const provider = String(item.provider || '').trim().toLowerCase();
  const accountId = String(item.accountId || '').trim();
  if (!provider || !accountId || accountId === 'legacy' || item.providerSource === 'legacy_default') {
    return '';
  }
  return `${provider}:${accountId}`;
}

function mediaLabel(items) {
  const types = new Set(items.map((item) => String(item.mediaType || '').trim().toLowerCase()));
  if (types.size === 1 && types.has('video')) return 'video';
  if (types.size === 1 && types.has('photo')) return 'photo';
  if (types.size > 0 && Array.from(types).every((type) => ['photo', 'video'].includes(type))) {
    return 'media';
  }
  return '';
}

function approvalEvidenceOf(item) {
  const status = String(item.status || '').trim();
  const approved = item.approved === true;
  const approvedAt = validTimestamp(item.approvedAt) ? item.approvedAt : null;
  const approvalAt = historyTimestamp(item, 'approved', 'earliest');
  const dispatchAt = historyTimestamp(item, 'publish_attempt', 'earliest');
  const result = item.lastResult && typeof item.lastResult === 'object'
    ? item.lastResult
    : null;
  const providerMode = result && PROVIDER_RESULT_MODES.has(String(result.mode || ''));
  const dispatchState = status === 'processing'
    || status === 'outcome_unknown'
    || providerMode;

  if (!approved) {
    if (approvedAt || approvalAt || dispatchAt || dispatchState || status === 'posted') return null;
    return {
      observedAt: latestTimestamp([item.updatedAt, item.createdAt])
    };
  }

  if (!approvedAt || !approvalAt) return null;
  if (Math.abs(Date.parse(approvalAt) - Date.parse(approvedAt)) > 60_000) return null;
  if (dispatchAt && Date.parse(approvalAt) > Date.parse(dispatchAt)) return null;
  if (dispatchState && !dispatchAt) return null;
  return {
    observedAt: dispatchAt || approvalAt
  };
}

function providerOutcomeOf(item) {
  const status = String(item.status || '').trim();
  const provider = String(item.provider || '').trim().toLowerCase();
  const result = item.lastResult && typeof item.lastResult === 'object'
    ? item.lastResult
    : null;
  const mode = String(result && result.mode || '');
  const completedAt = result && validTimestamp(result.completedAt) ? result.completedAt : null;
  const dispatchAt = historyTimestamp(item, 'publish_attempt', 'earliest');
  const terminalAt = historyTimestamp(item, Array.from(PROVIDER_TERMINAL_HISTORY));
  const pendingAt = historyTimestamp(item, Array.from(PROVIDER_PENDING_HISTORY));
  const providerSuccessVerified = provider !== 'youtube'
    || Boolean(
      item.providerVerification
      && validTimestamp(item.providerVerification.verifiedAt)
    );

  if (
    status === 'posted'
    && result
    && result.ok === true
    && PROVIDER_RESULT_MODES.has(mode)
    && validTimestamp(item.postedAt)
    && completedAt
    && providerSuccessVerified
    && dispatchAt
    && terminalAt
    && Date.parse(dispatchAt) <= Date.parse(terminalAt)
  ) {
    return {
      state: 'verified',
      observedAt: latestTimestamp([
        item.postedAt,
        completedAt,
        terminalAt,
        item.providerVerification && item.providerVerification.verifiedAt
      ])
    };
  }

  if (
    status === 'failed'
    && result
    && result.ok === false
    && result.willRetry !== true
    && PROVIDER_RESULT_MODES.has(mode)
    && completedAt
    && dispatchAt
    && terminalAt
    && Date.parse(dispatchAt) <= Date.parse(terminalAt)
  ) {
    return {
      state: 'failed',
      observedAt: latestTimestamp([completedAt, terminalAt])
    };
  }

  if (
    status === 'outcome_unknown'
    && result
    && result.outcomeUnknown === true
    && PROVIDER_RESULT_MODES.has(mode)
    && completedAt
    && dispatchAt
    && pendingAt
  ) {
    return {
      state: 'pending',
      observedAt: latestTimestamp([completedAt, pendingAt])
    };
  }

  if (
    status === 'scheduled'
    && result
    && result.ok === false
    && result.willRetry === true
    && PROVIDER_RESULT_MODES.has(mode)
    && completedAt
    && dispatchAt
    && pendingAt
  ) {
    return {
      state: 'pending',
      observedAt: latestTimestamp([completedAt, pendingAt])
    };
  }

  if (status === 'processing' && dispatchAt) {
    return { state: 'pending', observedAt: dispatchAt };
  }

  return null;
}

function reconcileEligibleBatch(batch, items) {
  const batchId = String(batch && batch.batchId || '').trim();
  const itemCount = positiveInteger(batch && batch.itemCount);
  const sourceCount = positiveInteger(batch && batch.videoCount);
  const destinationCount = positiveInteger(batch && batch.destinationCount);
  const media = Array.isArray(items) ? mediaLabel(items) : '';

  if (
    !WORK_ID.test(batchId)
    || !validTimestamp(batch && batch.createdAt)
    || !itemCount
    || !sourceCount
    || !destinationCount
    || !Array.isArray(items)
    || items.length !== itemCount
    || itemCount !== sourceCount * destinationCount
    || !media
  ) {
    return null;
  }

  const identities = new Set();
  const destinations = new Set();
  const approvalEvidence = [];
  for (const item of items) {
    const itemId = String(item && item.id || '').trim();
    const key = destinationKey(item || {});
    const approval = item && approvalEvidenceOf(item);
    if (
      !itemId
      || identities.has(itemId)
      || String(item.batchId || '').trim() !== batchId
      || isInternalItem(item)
      || !CUSTOMER_QUEUE_STATES.has(String(item.status || '').trim())
      || !validTimestamp(item.createdAt)
      || !validTimestamp(item.scheduledAt)
      || !key
      || !approval
      || (batch.userId && item.userId && String(batch.userId) !== String(item.userId))
      || (batch.workspaceId && item.workspaceId && String(batch.workspaceId) !== String(item.workspaceId))
    ) {
      return null;
    }
    identities.add(itemId);
    destinations.add(key);
    approvalEvidence.push(approval);
  }

  if (destinations.size !== destinationCount) return null;

  return {
    batchId,
    itemCount,
    sourceCount,
    destinationCount,
    media,
    targetBy: latestTimestamp(items.map((item) => item.scheduledAt)),
    persistenceObservedAt: latestTimestamp([
      batch.createdAt,
      batch.updatedAt,
      ...items.map((item) => item.createdAt)
    ]),
    scheduleObservedAt: latestTimestamp(items.map((item) => item.updatedAt || item.createdAt)),
    approvalObservedAt: latestTimestamp(approvalEvidence.map((entry) => entry.observedAt))
  };
}

function providerEvidenceFor(items) {
  const outcomes = items.map(providerOutcomeOf);
  const recognized = outcomes.filter(Boolean);
  if (recognized.length === 0) return null;

  const failed = recognized.filter((outcome) => outcome.state === 'failed');
  const allVerified = recognized.length === items.length
    && recognized.every((outcome) => outcome.state === 'verified');
  return {
    verificationState: failed.length > 0
      ? 'failed'
      : (allVerified ? 'verified' : 'pending'),
    observedAt: latestTimestamp(recognized.map((outcome) => outcome.observedAt)),
    completedAt: allVerified
      ? latestTimestamp(recognized.map((outcome) => outcome.observedAt))
      : null
  };
}

function plural(count, singular, pluralForm = `${singular}s`) {
  return Number(count) === 1 ? singular : pluralForm;
}

function projectAutoPosterMissionValue(batch, items) {
  const reconciled = reconcileEligibleBatch(batch, items);
  if (!reconciled) return null;

  const providerEvidence = providerEvidenceFor(items);
  const statement = [
    `Schedule ${reconciled.itemCount} ${reconciled.media} ${plural(reconciled.itemCount, 'release')}`,
    `from ${reconciled.sourceCount} source ${plural(reconciled.sourceCount, 'item')}`,
    `across ${reconciled.destinationCount} ${plural(reconciled.destinationCount, 'destination')}`,
    `by ${reconciled.targetBy}, preserving required publication approval before dispatch.`
  ].join(' ');

  const evidence = [
    {
      evidenceId: `autoposter:${reconciled.batchId}:persistence`,
      acceptanceCriterion: ACCEPTANCE_CRITERION.PERSISTED,
      verificationState: 'verified',
      source: 'AutoPoster durable batch record + exact child-post identity/count reconciliation',
      observedAt: reconciled.persistenceObservedAt
    },
    {
      evidenceId: `autoposter:${reconciled.batchId}:schedule-destinations`,
      acceptanceCriterion: ACCEPTANCE_CRITERION.SCHEDULE,
      verificationState: 'verified',
      source: 'AutoPoster child-post scheduledAt + explicit provider/account destination identity',
      observedAt: reconciled.scheduleObservedAt
    },
    {
      evidenceId: `autoposter:${reconciled.batchId}:approval-gate`,
      acceptanceCriterion: ACCEPTANCE_CRITERION.APPROVAL,
      verificationState: 'verified',
      source: 'AutoPoster approvalState/approvedAt + approved/publish_attempt history ordering',
      observedAt: reconciled.approvalObservedAt
    }
  ];

  if (providerEvidence) {
    evidence.push({
      evidenceId: `autoposter:${reconciled.batchId}:provider-outcome`,
      acceptanceCriterion: ACCEPTANCE_CRITERION.PROVIDER_OUTCOME,
      verificationState: providerEvidence.verificationState,
      source: 'AutoPoster durable status + sanitized lastResult + publish_attempt/terminal history',
      observedAt: providerEvidence.observedAt
    });
  }

  const timing = {
    startedAt: batch.createdAt,
    targetBy: reconciled.targetBy,
    completedAt: providerEvidence && providerEvidence.completedAt
      ? providerEvidence.completedAt
      : null
  };

  return {
    missionValueContract: {
      schema: MISSION_VALUE_SCHEMA,
      objective: {
        statement,
        acceptanceCriteria: ACCEPTANCE_CRITERIA.slice()
      },
      timing,
      budgets: {
        cost: { currency: null, maximum: null },
        humanAttentionMinutes: null,
        riskTolerance: null
      },
      expected: {
        evidenceRequired: ACCEPTANCE_CRITERIA.length,
        reversibility: 'unknown'
      }
    },
    missionValueEvidence: evidence,
    startedAt: batch.createdAt,
    ...(providerEvidence && providerEvidence.completedAt
      ? { completedAt: providerEvidence.completedAt }
      : {})
  };
}

module.exports = {
  ACCEPTANCE_CRITERION,
  ACCEPTANCE_CRITERIA,
  projectAutoPosterMissionValue
};
