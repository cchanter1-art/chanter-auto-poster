'use strict';

// Pure, read-only CHANTER mission-value contract and evaluator.
//
// This module owns no storage, clock, route, worker, approval, budget, or
// execution authority. It receives facts that an existing work projection
// already owns and returns a deterministic evaluation. Missing sources remain
// missing; no labels are converted into numbers and no scalar value score is
// calculated.

const MISSION_VALUE_SCHEMA = 'chanter.mission-value-contract.v1';

const PROVENANCE_STATE = Object.freeze({
  MEASURED: 'measured',
  DECLARED: 'declared',
  INFERRED: 'inferred',
  UNAVAILABLE: 'unavailable',
  NOT_APPLICABLE: 'not_applicable'
});

const READINESS_STATE = Object.freeze({
  NOT_DECLARED: 'not_declared',
  PARTIALLY_DECLARED: 'partially_declared',
  MEASUREMENT_INCOMPLETE: 'measurement_incomplete',
  VERIFICATION_PENDING: 'verification_pending',
  VERIFIED: 'verified',
  FAILED: 'failed'
});

const READINESS_PRESENTATION = Object.freeze({
  [READINESS_STATE.NOT_DECLARED]: { label: 'Not declared', chip: 'chip-neutral' },
  [READINESS_STATE.PARTIALLY_DECLARED]: { label: 'Partially declared', chip: 'chip-neutral' },
  [READINESS_STATE.MEASUREMENT_INCOMPLETE]: { label: 'Measurement incomplete', chip: 'chip-attention' },
  [READINESS_STATE.VERIFICATION_PENDING]: { label: 'Verification pending', chip: 'chip-attention' },
  [READINESS_STATE.VERIFIED]: { label: 'Verified', chip: 'chip-ready' },
  [READINESS_STATE.FAILED]: { label: 'Failed', chip: 'chip-failed' }
});

const DIMENSION = Object.freeze({
  OBJECTIVE_CLARITY: 'objective_clarity',
  ACCEPTANCE_COVERAGE: 'acceptance_coverage',
  TIME_TO_VERIFIED_OUTCOME: 'time_to_verified_outcome',
  TIMELINESS: 'timeliness',
  HUMAN_ATTENTION: 'human_attention',
  COST: 'cost',
  RISK: 'risk',
  EVIDENCE_COVERAGE: 'evidence_coverage',
  VERIFICATION_STATE: 'verification_state',
  LEARNING_STATE: 'learning_state',
  VERIFIED_VALUE_STATE: 'verified_value_state'
});

const DIMENSION_ORDER = Object.freeze([
  DIMENSION.OBJECTIVE_CLARITY,
  DIMENSION.ACCEPTANCE_COVERAGE,
  DIMENSION.TIME_TO_VERIFIED_OUTCOME,
  DIMENSION.TIMELINESS,
  DIMENSION.HUMAN_ATTENTION,
  DIMENSION.COST,
  DIMENSION.RISK,
  DIMENSION.EVIDENCE_COVERAGE,
  DIMENSION.VERIFICATION_STATE,
  DIMENSION.LEARNING_STATE,
  DIMENSION.VERIFIED_VALUE_STATE
]);

const DIMENSION_LABEL = Object.freeze({
  [DIMENSION.OBJECTIVE_CLARITY]: 'Objective',
  [DIMENSION.ACCEPTANCE_COVERAGE]: 'Acceptance coverage',
  [DIMENSION.TIME_TO_VERIFIED_OUTCOME]: 'Time to verified outcome',
  [DIMENSION.TIMELINESS]: 'Timeliness',
  [DIMENSION.HUMAN_ATTENTION]: 'Human attention',
  [DIMENSION.COST]: 'Cost',
  [DIMENSION.RISK]: 'Risk',
  [DIMENSION.EVIDENCE_COVERAGE]: 'Evidence coverage',
  [DIMENSION.VERIFICATION_STATE]: 'Verification state',
  [DIMENSION.LEARNING_STATE]: 'Learning state',
  [DIMENSION.VERIFIED_VALUE_STATE]: 'Verified value state'
});

const RISK_TOLERANCE = new Set(['low', 'medium', 'high']);
const REVERSIBILITY = new Set([
  'reversible',
  'partially_reversible',
  'irreversible',
  'unknown'
]);
const EVIDENCE_VERIFICATION_STATE = new Set(['verified', 'pending', 'failed', 'unavailable']);
const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/;

class MissionValueContractError extends TypeError {
  constructor(path, reason) {
    super(`Invalid mission value contract at ${path}: ${reason}`);
    this.name = 'MissionValueContractError';
    this.code = 'MISSION_VALUE_CONTRACT_INVALID';
    this.path = path;
  }
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainObject(value, path) {
  if (!isPlainObject(value)) {
    throw new MissionValueContractError(path, 'must be an object');
  }
}

function assertKnownKeys(value, allowed, path) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new MissionValueContractError(`${path}.${key}`, 'is not part of this schema');
    }
  }
}

function validateString(value, path, { nullable = false } = {}) {
  if (value === null && nullable) return null;
  if (typeof value !== 'string' || !value.trim()) {
    throw new MissionValueContractError(path, nullable
      ? 'must be a non-empty string or null'
      : 'must be a non-empty string');
  }
  return value.trim();
}

function validateNumber(value, path, { nullable = false, integer = false } = {}) {
  if (value === null && nullable) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new MissionValueContractError(path, nullable
      ? 'must be a non-negative finite number or null'
      : 'must be a non-negative finite number');
  }
  if (integer && !Number.isInteger(value)) {
    throw new MissionValueContractError(path, 'must be a non-negative integer');
  }
  return value;
}

function validIsoTimestamp(value) {
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
  if (
    month < 1
    || month > 12
    || day < 1
    || day > new Date(Date.UTC(year, month, 0)).getUTCDate()
    || hour > 23
    || minute > 59
    || second > 59
    || offsetHour > 23
    || offsetMinute > 59
  ) {
    return false;
  }
  return true;
}

function validateTimestamp(value, path) {
  if (value === null) return null;
  if (!validIsoTimestamp(value)) {
    throw new MissionValueContractError(path, 'must be an ISO-8601 timestamp or null');
  }
  return value;
}

function copyObjective(value) {
  assertPlainObject(value, 'objective');
  assertKnownKeys(value, ['statement', 'acceptanceCriteria'], 'objective');
  const result = {};
  if (hasOwn(value, 'statement')) {
    result.statement = validateString(value.statement, 'objective.statement');
  }
  if (hasOwn(value, 'acceptanceCriteria')) {
    if (!Array.isArray(value.acceptanceCriteria)) {
      throw new MissionValueContractError('objective.acceptanceCriteria', 'must be an array of strings');
    }
    result.acceptanceCriteria = value.acceptanceCriteria.map((criterion, index) => (
      validateString(criterion, `objective.acceptanceCriteria[${index}]`)
    ));
    if (new Set(result.acceptanceCriteria).size !== result.acceptanceCriteria.length) {
      throw new MissionValueContractError(
        'objective.acceptanceCriteria',
        'must not contain duplicate criteria'
      );
    }
  }
  return result;
}

function copyTiming(value) {
  assertPlainObject(value, 'timing');
  assertKnownKeys(value, ['startedAt', 'targetBy', 'completedAt'], 'timing');
  const result = {};
  for (const key of ['startedAt', 'targetBy', 'completedAt']) {
    if (hasOwn(value, key)) result[key] = validateTimestamp(value[key], `timing.${key}`);
  }
  return result;
}

function copyCost(value) {
  assertPlainObject(value, 'budgets.cost');
  assertKnownKeys(value, ['currency', 'maximum'], 'budgets.cost');
  const result = {};
  if (hasOwn(value, 'currency')) {
    result.currency = validateString(value.currency, 'budgets.cost.currency', { nullable: true });
  }
  if (hasOwn(value, 'maximum')) {
    result.maximum = validateNumber(value.maximum, 'budgets.cost.maximum', { nullable: true });
  }
  return result;
}

function copyBudgets(value) {
  assertPlainObject(value, 'budgets');
  assertKnownKeys(value, ['cost', 'humanAttentionMinutes', 'riskTolerance'], 'budgets');
  const result = {};
  if (hasOwn(value, 'cost')) result.cost = copyCost(value.cost);
  if (hasOwn(value, 'humanAttentionMinutes')) {
    result.humanAttentionMinutes = validateNumber(
      value.humanAttentionMinutes,
      'budgets.humanAttentionMinutes',
      { nullable: true }
    );
  }
  if (hasOwn(value, 'riskTolerance')) {
    if (value.riskTolerance === null) {
      result.riskTolerance = null;
    } else if (!RISK_TOLERANCE.has(value.riskTolerance)) {
      throw new MissionValueContractError(
        'budgets.riskTolerance',
        'must be low, medium, high, or null'
      );
    } else {
      result.riskTolerance = value.riskTolerance;
    }
  }
  return result;
}

function copyExpected(value) {
  assertPlainObject(value, 'expected');
  assertKnownKeys(value, ['evidenceRequired', 'reversibility'], 'expected');
  const result = {};
  if (hasOwn(value, 'evidenceRequired')) {
    result.evidenceRequired = validateNumber(
      value.evidenceRequired,
      'expected.evidenceRequired',
      { nullable: true, integer: true }
    );
  }
  if (hasOwn(value, 'reversibility')) {
    if (!REVERSIBILITY.has(value.reversibility)) {
      throw new MissionValueContractError(
        'expected.reversibility',
        'must be reversible, partially_reversible, irreversible, or unknown'
      );
    }
    result.reversibility = value.reversibility;
  }
  return result;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function validateMissionValueContract(value) {
  if (value == null) return null;
  assertPlainObject(value, 'contract');
  assertKnownKeys(value, ['schema', 'objective', 'timing', 'budgets', 'expected'], 'contract');
  if (!hasOwn(value, 'schema')) {
    throw new MissionValueContractError('schema', 'is required');
  }
  if (value.schema !== MISSION_VALUE_SCHEMA) {
    throw new MissionValueContractError('schema', `must equal ${MISSION_VALUE_SCHEMA}`);
  }
  const result = { schema: MISSION_VALUE_SCHEMA };
  if (hasOwn(value, 'objective')) result.objective = copyObjective(value.objective);
  if (hasOwn(value, 'timing')) result.timing = copyTiming(value.timing);
  if (hasOwn(value, 'budgets')) result.budgets = copyBudgets(value.budgets);
  if (hasOwn(value, 'expected')) result.expected = copyExpected(value.expected);
  return deepFreeze(result);
}

function assessment(state, value, source, observedAt = null, confidence = null) {
  return {
    state,
    value: value == null ? null : value,
    source: String(source || ''),
    observedAt: validIsoTimestamp(observedAt) ? observedAt : null,
    confidence: typeof confidence === 'number' && Number.isFinite(confidence)
      ? confidence
      : null
  };
}

function unavailable(source) {
  return assessment(PROVENANCE_STATE.UNAVAILABLE, null, source);
}

function normalizeEvidence(evidence) {
  if (!Array.isArray(evidence)) return { sourceAvailable: false, items: [] };
  const items = evidence.map((entry, index) => {
    const record = isPlainObject(entry) ? entry : {};
    const evidenceId = typeof record.evidenceId === 'string' ? record.evidenceId.trim() : '';
    const acceptanceCriterion = typeof record.acceptanceCriterion === 'string'
      ? record.acceptanceCriterion.trim()
      : '';
    const verificationState = EVIDENCE_VERIFICATION_STATE.has(record.verificationState)
      ? record.verificationState
      : 'unavailable';
    return {
      evidenceId,
      acceptanceCriterion,
      verificationState,
      source: typeof record.source === 'string' && record.source.trim()
        ? record.source.trim()
        : `missionValueEvidence[${index}]`,
      observedAt: validIsoTimestamp(record.observedAt) ? record.observedAt : null,
      confidence: typeof record.confidence === 'number' && Number.isFinite(record.confidence)
        ? record.confidence
        : null,
      validIdentity: Boolean(evidenceId)
    };
  });
  return { sourceAvailable: true, items };
}

function criteriaOf(contract) {
  return contract
    && contract.objective
    && Array.isArray(contract.objective.acceptanceCriteria)
    ? contract.objective.acceptanceCriteria
    : [];
}

function statementOf(contract) {
  return String(
    contract
    && contract.objective
    && contract.objective.statement
    || ''
  ).trim();
}

function latestObservedAt(items) {
  return items
    .map((item) => item.observedAt)
    .filter(Boolean)
    .sort((left, right) => Date.parse(left) - Date.parse(right))
    .at(-1) || null;
}

function criterionCoverageOf(criteria, evidenceItems) {
  return criteria.map((criterion) => {
    const linked = evidenceItems.filter((item) => (
      item.validIdentity && item.acceptanceCriterion === criterion
    ));
    const verified = linked.filter((item) => item.verificationState === 'verified');
    const failed = linked.filter((item) => item.verificationState === 'failed');
    return {
      criterion,
      state: verified.length > 0
        ? 'verified'
        : (failed.length > 0 ? 'failed' : (linked.length > 0 ? 'verification_pending' : 'unmapped')),
      evidenceIds: linked.map((item) => item.evidenceId),
      verifiedEvidenceIds: verified.map((item) => item.evidenceId)
    };
  });
}

function readinessOf({
  work,
  contract,
  evidenceSourceAvailable,
  evidenceItemCount,
  criterionCoverage
}) {
  if (String(work && work.state || '') === 'failed') return READINESS_STATE.FAILED;
  if (!contract) return READINESS_STATE.NOT_DECLARED;
  if (!statementOf(contract) || criteriaOf(contract).length === 0) {
    return READINESS_STATE.PARTIALLY_DECLARED;
  }
  if (!evidenceSourceAvailable || evidenceItemCount === 0) {
    return READINESS_STATE.VERIFICATION_PENDING;
  }
  if (criterionCoverage.every((entry) => entry.evidenceIds.length === 0)) {
    return READINESS_STATE.MEASUREMENT_INCOMPLETE;
  }
  if (criterionCoverage.some((entry) => entry.state === 'failed')) {
    return READINESS_STATE.FAILED;
  }
  if (criterionCoverage.some((entry) => entry.state === 'unmapped')) {
    return READINESS_STATE.MEASUREMENT_INCOMPLETE;
  }
  if (criterionCoverage.every((entry) => entry.state === 'verified')) {
    return READINESS_STATE.VERIFIED;
  }
  return READINESS_STATE.VERIFICATION_PENDING;
}

function durationLabel(milliseconds) {
  const totalMinutes = Math.max(0, Math.round(milliseconds / 60000));
  if (totalMinutes < 60) return `${totalMinutes} min`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes ? `${hours} hr ${minutes} min` : `${hours} hr`;
}

function actualTimestamp(work, key) {
  const value = work && work[key];
  return validIsoTimestamp(value) ? value : null;
}

function expectedTimestamp(contract, key) {
  const value = contract && contract.timing && contract.timing[key];
  return validIsoTimestamp(value) ? value : null;
}

function buildAssessments({ work, contract, evidence, criterionCoverage, readiness }) {
  const criteria = criteriaOf(contract);
  const statement = statementOf(contract);
  const linkedEvidence = evidence.items.filter((item) => (
    item.validIdentity && criteria.includes(item.acceptanceCriterion)
  ));
  const verifiedCriteria = criterionCoverage.filter((entry) => entry.state === 'verified');
  const verifiedEvidence = linkedEvidence.filter((item) => item.verificationState === 'verified');
  const startedAt = actualTimestamp(work, 'startedAt');
  const completedAt = actualTimestamp(work, 'completedAt');
  const targetBy = expectedTimestamp(contract, 'targetBy');
  const declaredCompletedAt = expectedTimestamp(contract, 'completedAt');
  const observedCompletion = completedAt || declaredCompletedAt;
  const failed = String(work && work.state || '') === 'failed';

  const dimensions = {};
  dimensions[DIMENSION.OBJECTIVE_CLARITY] = statement
    ? assessment(
      PROVENANCE_STATE.DECLARED,
      statement,
      'missionValueContract.objective.statement'
    )
    : unavailable('No objective statement is declared in the mission value contract.');

  dimensions[DIMENSION.ACCEPTANCE_COVERAGE] = criteria.length === 0
    ? unavailable('No acceptance criteria are declared in the mission value contract.')
    : (!evidence.sourceAvailable
      ? unavailable('No criterion-linked evidence projection exists for this work item.')
      : assessment(
        PROVENANCE_STATE.INFERRED,
        `${verifiedCriteria.length} of ${criteria.length} criteria verified`,
        'missionValueContract.objective.acceptanceCriteria + missionValueEvidence.acceptanceCriterion + missionValueEvidence.verificationState',
        latestObservedAt(linkedEvidence)
      ));

  if (
    readiness === READINESS_STATE.VERIFIED
    && startedAt
    && completedAt
    && Date.parse(completedAt) >= Date.parse(startedAt)
  ) {
    dimensions[DIMENSION.TIME_TO_VERIFIED_OUTCOME] = assessment(
      PROVENANCE_STATE.MEASURED,
      durationLabel(Date.parse(completedAt) - Date.parse(startedAt)),
      'work.startedAt + work.completedAt + criterion-linked verified evidence',
      completedAt
    );
  } else if (failed) {
    dimensions[DIMENSION.TIME_TO_VERIFIED_OUTCOME] = assessment(
      PROVENANCE_STATE.NOT_APPLICABLE,
      null,
      'Work failed without a verified outcome, so time to verified outcome does not apply.'
    );
  } else {
    dimensions[DIMENSION.TIME_TO_VERIFIED_OUTCOME] = unavailable(
      readiness === READINESS_STATE.VERIFIED
        ? 'Valid actual work.startedAt and work.completedAt sources do not both exist.'
        : 'Criterion-linked verified value has not been reached, so no time to verified outcome is measured.'
    );
  }

  if (targetBy && observedCompletion) {
    dimensions[DIMENSION.TIMELINESS] = assessment(
      PROVENANCE_STATE.INFERRED,
      Date.parse(observedCompletion) <= Date.parse(targetBy) ? 'On time' : 'Late',
      completedAt
        ? 'missionValueContract.timing.targetBy + work.completedAt'
        : 'missionValueContract.timing.targetBy + missionValueContract.timing.completedAt',
      observedCompletion
    );
  } else if (failed && targetBy) {
    dimensions[DIMENSION.TIMELINESS] = assessment(
      PROVENANCE_STATE.NOT_APPLICABLE,
      null,
      'Work failed without a completion timestamp, so completion timeliness does not apply.'
    );
  } else {
    dimensions[DIMENSION.TIMELINESS] = unavailable(
      'Valid targetBy and completedAt sources do not both exist.'
    );
  }

  dimensions[DIMENSION.HUMAN_ATTENTION] = unavailable(
    'No actual human-attention measurement source exists on the work or evidence projection.'
  );
  dimensions[DIMENSION.COST] = unavailable(
    'No actual cost measurement source exists on the work or evidence projection.'
  );

  const riskTolerance = contract
    && contract.budgets
    && contract.budgets.riskTolerance;
  dimensions[DIMENSION.RISK] = riskTolerance
    ? assessment(
      PROVENANCE_STATE.DECLARED,
      `${riskTolerance} tolerance`,
      'missionValueContract.budgets.riskTolerance'
    )
    : unavailable('No risk tolerance is declared and no actual risk measurement source exists.');

  if (!evidence.sourceAvailable) {
    dimensions[DIMENSION.EVIDENCE_COVERAGE] = unavailable(
      'No criterion-linked evidence projection exists for this work item.'
    );
  } else {
    const expectedCount = contract
      && contract.expected
      && contract.expected.evidenceRequired;
    dimensions[DIMENSION.EVIDENCE_COVERAGE] = assessment(
      PROVENANCE_STATE.INFERRED,
      typeof expectedCount === 'number'
        ? `${linkedEvidence.length} of ${expectedCount} required records linked`
        : `${linkedEvidence.length} criterion-linked record${linkedEvidence.length === 1 ? '' : 's'}`,
      'missionValueEvidence.evidenceId + missionValueEvidence.acceptanceCriterion',
      latestObservedAt(linkedEvidence)
    );
  }

  if (!evidence.sourceAvailable || criteria.length === 0) {
    dimensions[DIMENSION.VERIFICATION_STATE] = unavailable(
      criteria.length === 0
        ? 'Acceptance criteria are not declared, so verification cannot be evaluated.'
        : 'No linked evidence verification source exists for this work item.'
    );
  } else {
    let value = 'Pending';
    if (evidence.items.length === 0) value = 'Pending';
    else if (criterionCoverage.every((entry) => entry.state === 'verified')) value = 'Verified';
    else if (criterionCoverage.some((entry) => entry.state === 'failed')) value = 'Failed';
    else if (criterionCoverage.some((entry) => entry.state === 'unmapped')) value = 'Incomplete';
    dimensions[DIMENSION.VERIFICATION_STATE] = assessment(
      PROVENANCE_STATE.INFERRED,
      value,
      'missionValueEvidence.verificationState for exact declared criterion links',
      latestObservedAt(linkedEvidence)
    );
  }

  if (Array.isArray(work && work.retainedLessons)) {
    dimensions[DIMENSION.LEARNING_STATE] = assessment(
      PROVENANCE_STATE.MEASURED,
      `${work.retainedLessons.length} retained lesson${work.retainedLessons.length === 1 ? '' : 's'}`,
      'work.retainedLessons',
      actualTimestamp(work, 'updatedAt')
    );
  } else {
    dimensions[DIMENSION.LEARNING_STATE] = unavailable(
      'No retained lesson source exists on the work projection.'
    );
  }

  dimensions[DIMENSION.VERIFIED_VALUE_STATE] = contract
    ? assessment(
      PROVENANCE_STATE.INFERRED,
      READINESS_PRESENTATION[readiness].label,
      readiness === READINESS_STATE.FAILED && failed
        ? 'work.state'
        : 'mission value contract completeness + exact criterion-linked evidence verification',
      latestObservedAt(verifiedEvidence)
    )
    : unavailable('No mission value contract is declared for this work item.');

  return {
    dimensions,
    linkedEvidence,
    verifiedEvidence
  };
}

function expectedValue(state, value, source) {
  return assessment(state, value, source);
}

function expectedObservedComparisons({ contract, dimensions, verifiedEvidenceCount }) {
  const expected = (contract && contract.expected) || {};
  const budgets = (contract && contract.budgets) || {};
  const cost = budgets.cost || {};
  const timing = (contract && contract.timing) || {};

  function comparison(id, label, expectedAssessment, observedAssessment, status) {
    return { id, label, expected: expectedAssessment, observed: observedAssessment, status };
  }

  const expectedEvidence = typeof expected.evidenceRequired === 'number'
    ? expectedValue(
      PROVENANCE_STATE.DECLARED,
      expected.evidenceRequired,
      'missionValueContract.expected.evidenceRequired'
    )
    : unavailable('No expected evidence count is declared.');
  const observedEvidence = dimensions[DIMENSION.EVIDENCE_COVERAGE].state === PROVENANCE_STATE.UNAVAILABLE
    ? dimensions[DIMENSION.EVIDENCE_COVERAGE]
    : assessment(
      PROVENANCE_STATE.INFERRED,
      verifiedEvidenceCount,
      'criterion-linked evidence records with verificationState=verified',
      dimensions[DIMENSION.EVIDENCE_COVERAGE].observedAt
    );
  const evidenceStatus = typeof expected.evidenceRequired !== 'number'
    ? 'not_declared'
    : (observedEvidence.state === PROVENANCE_STATE.UNAVAILABLE
      ? 'unavailable'
      : (verifiedEvidenceCount >= expected.evidenceRequired ? 'met' : 'not_met'));

  const costExpected = typeof cost.maximum === 'number'
    ? expectedValue(
      PROVENANCE_STATE.DECLARED,
      `${cost.currency || 'currency unavailable'} ${cost.maximum}`,
      'missionValueContract.budgets.cost'
    )
    : unavailable('No maximum cost is declared.');
  const attentionExpected = typeof budgets.humanAttentionMinutes === 'number'
    ? expectedValue(
      PROVENANCE_STATE.DECLARED,
      `${budgets.humanAttentionMinutes} min`,
      'missionValueContract.budgets.humanAttentionMinutes'
    )
    : unavailable('No human-attention budget is declared.');
  const riskExpected = budgets.riskTolerance
    ? expectedValue(
      PROVENANCE_STATE.DECLARED,
      budgets.riskTolerance,
      'missionValueContract.budgets.riskTolerance'
    )
    : unavailable('No risk tolerance is declared.');
  const targetExpected = timing.targetBy
    ? expectedValue(
      PROVENANCE_STATE.DECLARED,
      timing.targetBy,
      'missionValueContract.timing.targetBy'
    )
    : unavailable('No target date is declared.');
  const reversibilityExpected = expected.reversibility
    ? expectedValue(
      PROVENANCE_STATE.DECLARED,
      expected.reversibility,
      'missionValueContract.expected.reversibility'
    )
    : unavailable('No reversibility expectation is declared.');

  return [
    comparison('evidence_required', 'Required verified evidence', expectedEvidence, observedEvidence, evidenceStatus),
    comparison(
      'target_by',
      'Target date',
      targetExpected,
      dimensions[DIMENSION.TIMELINESS],
      targetExpected.state === PROVENANCE_STATE.UNAVAILABLE
        ? 'not_declared'
        : (dimensions[DIMENSION.TIMELINESS].state === PROVENANCE_STATE.UNAVAILABLE ? 'unavailable' : 'observed')
    ),
    comparison(
      'cost',
      'Cost',
      costExpected,
      dimensions[DIMENSION.COST],
      costExpected.state === PROVENANCE_STATE.UNAVAILABLE ? 'not_declared' : 'unavailable'
    ),
    comparison(
      'human_attention',
      'Human attention',
      attentionExpected,
      dimensions[DIMENSION.HUMAN_ATTENTION],
      attentionExpected.state === PROVENANCE_STATE.UNAVAILABLE ? 'not_declared' : 'unavailable'
    ),
    comparison(
      'risk',
      'Risk',
      riskExpected,
      unavailable('No actual risk measurement source exists.'),
      riskExpected.state === PROVENANCE_STATE.UNAVAILABLE ? 'not_declared' : 'unavailable'
    ),
    comparison(
      'reversibility',
      'Reversibility',
      reversibilityExpected,
      unavailable('No observed reversibility source exists.'),
      reversibilityExpected.state === PROVENANCE_STATE.UNAVAILABLE ? 'not_declared' : 'unavailable'
    )
  ];
}

function evaluateMissionValue({ work = {}, contract = null, evidence } = {}) {
  const validatedContract = validateMissionValueContract(contract);
  const normalizedEvidence = normalizeEvidence(evidence);
  const criteria = criteriaOf(validatedContract);
  const criterionCoverage = criterionCoverageOf(criteria, normalizedEvidence.items);
  const readiness = readinessOf({
    work,
    contract: validatedContract,
    evidenceSourceAvailable: normalizedEvidence.sourceAvailable,
    evidenceItemCount: normalizedEvidence.items.length,
    criterionCoverage
  });
  const built = buildAssessments({
    work,
    contract: validatedContract,
    evidence: normalizedEvidence,
    criterionCoverage,
    readiness
  });
  const missingMeasurements = DIMENSION_ORDER.filter((id) => (
    built.dimensions[id].state === PROVENANCE_STATE.UNAVAILABLE
    || (id === DIMENSION.RISK && built.dimensions[id].state === PROVENANCE_STATE.DECLARED)
  ));
  const readinessWithoutEvidence = readinessOf({
    work,
    contract: validatedContract,
    evidenceSourceAvailable: normalizedEvidence.sourceAvailable,
    evidenceItemCount: 0,
    criterionCoverage: criterionCoverageOf(criteria, [])
  });
  const criterionLinkedEvidenceExists = built.linkedEvidence.length > 0;
  const changed = criterionLinkedEvidenceExists && readinessWithoutEvidence !== readiness;

  return {
    schema: MISSION_VALUE_SCHEMA,
    contractDeclared: Boolean(validatedContract),
    readiness,
    readinessPresentation: READINESS_PRESENTATION[readiness],
    dimensions: built.dimensions,
    expectedObserved: expectedObservedComparisons({
      contract: validatedContract,
      dimensions: built.dimensions,
      verifiedEvidenceCount: built.verifiedEvidence.length
    }),
    criterionCoverage,
    missingMeasurements,
    readinessChange: {
      changed,
      from: changed ? readinessWithoutEvidence : readiness,
      to: readiness,
      reason: changed
        ? 'Criterion-linked evidence changed the deterministic readiness result.'
        : 'No criterion-linked evidence changed the deterministic readiness result.'
    }
  };
}

function presentation(readiness) {
  return READINESS_PRESENTATION[readiness] || READINESS_PRESENTATION[READINESS_STATE.NOT_DECLARED];
}

function displayValue(dimensionId, value) {
  if (!value) return '';
  if (value.state === PROVENANCE_STATE.NOT_APPLICABLE) return 'Not applicable';
  if (value.state !== PROVENANCE_STATE.UNAVAILABLE) return String(value.value);
  if (dimensionId === DIMENSION.OBJECTIVE_CLARITY) return 'Not declared';
  if ([DIMENSION.HUMAN_ATTENTION, DIMENSION.COST].includes(dimensionId)) return 'Unavailable';
  return 'Not measured';
}

function provenanceLabel(value) {
  if (!value) return 'Unavailable';
  const labels = {
    [PROVENANCE_STATE.MEASURED]: 'Measured',
    [PROVENANCE_STATE.DECLARED]: 'Declared',
    [PROVENANCE_STATE.INFERRED]: 'Inferred',
    [PROVENANCE_STATE.UNAVAILABLE]: 'Unavailable',
    [PROVENANCE_STATE.NOT_APPLICABLE]: 'Not applicable'
  };
  return labels[value.state] || 'Unavailable';
}

module.exports = {
  MISSION_VALUE_SCHEMA,
  PROVENANCE_STATE,
  READINESS_STATE,
  READINESS_PRESENTATION,
  DIMENSION,
  DIMENSION_ORDER,
  DIMENSION_LABEL,
  MissionValueContractError,
  validateMissionValueContract,
  evaluateMissionValue,
  presentation,
  displayValue,
  provenanceLabel
};
