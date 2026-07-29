'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const missionValue = require('../src/missionValue');

const {
  DIMENSION,
  MISSION_VALUE_SCHEMA,
  PROVENANCE_STATE,
  READINESS_STATE
} = missionValue;

function fullContract(overrides = {}) {
  return {
    schema: MISSION_VALUE_SCHEMA,
    objective: {
      statement: 'Prepare a verified release.',
      acceptanceCriteria: [
        'The release draft is complete.',
        'The release review is verified.'
      ],
      ...(overrides.objective || {})
    },
    timing: {
      startedAt: null,
      targetBy: '2026-07-29T10:00:00.000Z',
      completedAt: null,
      ...(overrides.timing || {})
    },
    budgets: {
      cost: { currency: 'USD', maximum: 12 },
      humanAttentionMinutes: 20,
      riskTolerance: 'low',
      ...(overrides.budgets || {})
    },
    expected: {
      evidenceRequired: 2,
      reversibility: 'reversible',
      ...(overrides.expected || {})
    }
  };
}

function completedWork(overrides = {}) {
  return {
    workId: 'value-work-001',
    state: 'completed',
    createdAt: '2026-07-29T09:00:00.000Z',
    updatedAt: '2026-07-29T09:40:00.000Z',
    startedAt: '2026-07-29T09:00:00.000Z',
    completedAt: '2026-07-29T09:40:00.000Z',
    ...overrides
  };
}

function verifiedEvidence() {
  return [
    {
      evidenceId: 'evidence-draft',
      acceptanceCriterion: 'The release draft is complete.',
      verificationState: 'verified',
      source: 'existing draft evidence',
      observedAt: '2026-07-29T09:30:00.000Z'
    },
    {
      evidenceId: 'evidence-review',
      acceptanceCriterion: 'The release review is verified.',
      verificationState: 'verified',
      source: 'existing review evidence',
      observedAt: '2026-07-29T09:40:00.000Z'
    }
  ];
}

function assertNoScalarScore(value, path = 'evaluation') {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.doesNotMatch(key, /score/i, `${path}.${key} must not be a scalar score field`);
    assertNoScalarScore(child, `${path}.${key}`);
  }
}

test('fixture 1: no value contract is a normal not_declared state', () => {
  const result = missionValue.evaluateMissionValue({ work: completedWork() });

  assert.equal(result.contractDeclared, false);
  assert.equal(result.readiness, READINESS_STATE.NOT_DECLARED);
  assert.equal(
    result.dimensions[DIMENSION.OBJECTIVE_CLARITY].state,
    PROVENANCE_STATE.UNAVAILABLE
  );
  assert.equal(
    missionValue.displayValue(
      DIMENSION.TIME_TO_VERIFIED_OUTCOME,
      result.dimensions[DIMENSION.TIME_TO_VERIFIED_OUTCOME]
    ),
    'Not measured'
  );
});

test('fixture 2: a partially declared contract stays partially_declared', () => {
  const result = missionValue.evaluateMissionValue({
    work: { workId: 'partial', state: 'running' },
    contract: {
      schema: MISSION_VALUE_SCHEMA,
      objective: { statement: 'Prepare the release.' }
    }
  });

  assert.equal(result.readiness, READINESS_STATE.PARTIALLY_DECLARED);
  assert.equal(
    result.dimensions[DIMENSION.OBJECTIVE_CLARITY].state,
    PROVENANCE_STATE.DECLARED
  );
  assert.equal(
    result.dimensions[DIMENSION.ACCEPTANCE_COVERAGE].state,
    PROVENANCE_STATE.UNAVAILABLE
  );
});

test('fixture 3: completed work without verified evidence remains verification_pending', () => {
  const result = missionValue.evaluateMissionValue({
    work: completedWork(),
    contract: fullContract(),
    evidence: []
  });

  assert.equal(result.readiness, READINESS_STATE.VERIFICATION_PENDING);
  assert.notEqual(result.readiness, READINESS_STATE.VERIFIED);
  assert.equal(
    result.dimensions[DIMENSION.VERIFICATION_STATE].value,
    'Pending'
  );
});

test('fixture 4: every declared criterion needs exact linked verified evidence', () => {
  const result = missionValue.evaluateMissionValue({
    work: completedWork(),
    contract: fullContract(),
    evidence: verifiedEvidence()
  });

  assert.equal(result.readiness, READINESS_STATE.VERIFIED);
  assert.ok(result.criterionCoverage.every((entry) => entry.state === 'verified'));
  assert.equal(result.readinessChange.changed, true);
  assert.equal(result.readinessChange.from, READINESS_STATE.VERIFICATION_PENDING);
  assert.equal(result.readinessChange.to, READINESS_STATE.VERIFIED);
  assert.equal(
    result.dimensions[DIMENSION.ACCEPTANCE_COVERAGE].value,
    '2 of 2 criteria verified'
  );
  assert.equal(
    result.expectedObserved.find((entry) => entry.id === 'evidence_required').status,
    'met'
  );
  assert.equal(
    result.dimensions[DIMENSION.TIME_TO_VERIFIED_OUTCOME].state,
    PROVENANCE_STATE.MEASURED
  );
  assert.equal(
    result.dimensions[DIMENSION.TIME_TO_VERIFIED_OUTCOME].value,
    '40 min'
  );
});

test('fixture 5: a missed target date is inferred only from targetBy and completedAt', () => {
  const result = missionValue.evaluateMissionValue({
    work: completedWork({ completedAt: '2026-07-29T10:15:00.000Z' }),
    contract: fullContract(),
    evidence: verifiedEvidence()
  });

  const timeliness = result.dimensions[DIMENSION.TIMELINESS];
  assert.equal(timeliness.state, PROVENANCE_STATE.INFERRED);
  assert.equal(timeliness.value, 'Late');
  assert.match(timeliness.source, /targetBy \+ work\.completedAt/);
});

test('fixture 6: malformed contracts are rejected at validation', () => {
  assert.throws(
    () => missionValue.validateMissionValueContract({ schema: 'wrong-schema' }),
    /schema/
  );
  assert.throws(
    () => missionValue.validateMissionValueContract(fullContract({
      budgets: { humanAttentionMinutes: -1 }
    })),
    /humanAttentionMinutes/
  );
  assert.throws(
    () => missionValue.validateMissionValueContract(fullContract({
      timing: { targetBy: 'tomorrow' }
    })),
    /targetBy/
  );
  assert.throws(
    () => missionValue.validateMissionValueContract(fullContract({
      timing: { targetBy: '2026-02-30T10:00:00.000Z' }
    })),
    /targetBy/
  );
  assert.throws(
    () => missionValue.validateMissionValueContract(fullContract({
      objective: {
        acceptanceCriteria: [
          'The release draft is complete.',
          'The release draft is complete.'
        ]
      }
    })),
    /duplicate/
  );
});

test('fixture 7: cost and human attention stay unavailable while risk is only declared', () => {
  const result = missionValue.evaluateMissionValue({
    work: completedWork(),
    contract: fullContract(),
    evidence: verifiedEvidence()
  });

  assert.equal(
    result.dimensions[DIMENSION.COST].state,
    PROVENANCE_STATE.UNAVAILABLE
  );
  assert.equal(
    result.dimensions[DIMENSION.HUMAN_ATTENTION].state,
    PROVENANCE_STATE.UNAVAILABLE
  );
  assert.equal(
    result.dimensions[DIMENSION.RISK].state,
    PROVENANCE_STATE.DECLARED
  );
  assert.equal(
    missionValue.displayValue(DIMENSION.COST, result.dimensions[DIMENSION.COST]),
    'Unavailable'
  );
  assert.ok(result.missingMeasurements.includes(DIMENSION.COST));
  assert.ok(result.missingMeasurements.includes(DIMENSION.HUMAN_ATTENTION));
  assert.ok(result.missingMeasurements.includes(DIMENSION.RISK));
});

test('fixture 8: evidence count without an exact criterion mapping is incomplete', () => {
  const result = missionValue.evaluateMissionValue({
    work: completedWork(),
    contract: fullContract(),
    evidence: [
      {
        evidenceId: 'unmapped-evidence',
        acceptanceCriterion: 'A criterion that was never declared.',
        verificationState: 'verified',
        source: 'existing unrelated evidence',
        observedAt: '2026-07-29T09:40:00.000Z'
      }
    ]
  });

  assert.equal(result.readiness, READINESS_STATE.MEASUREMENT_INCOMPLETE);
  assert.ok(result.criterionCoverage.every((entry) => entry.state === 'unmapped'));
  assert.equal(result.readinessChange.changed, false);
  assert.notEqual(result.readiness, READINESS_STATE.VERIFIED);
});

test('fixture 9: partially mapped evidence is measurement_incomplete', () => {
  const result = missionValue.evaluateMissionValue({
    work: completedWork(),
    contract: fullContract(),
    evidence: [verifiedEvidence()[0]]
  });

  assert.equal(result.readiness, READINESS_STATE.MEASUREMENT_INCOMPLETE);
  assert.equal(result.criterionCoverage[0].state, 'verified');
  assert.equal(result.criterionCoverage[1].state, 'unmapped');
});

test('criterion-linked failed evidence cannot be masked by an unmapped criterion', () => {
  const result = missionValue.evaluateMissionValue({
    work: completedWork(),
    contract: fullContract(),
    evidence: [{
      evidenceId: 'failed-review-evidence',
      acceptanceCriterion: 'The release draft is complete.',
      verificationState: 'failed',
      source: 'existing failed review evidence',
      observedAt: '2026-07-29T09:40:00.000Z'
    }]
  });

  assert.equal(result.readiness, READINESS_STATE.FAILED);
  assert.equal(
    result.dimensions[DIMENSION.VERIFICATION_STATE].value,
    'Failed'
  );
});

test('fixture 10: failed work cannot be presented as verified value', () => {
  const result = missionValue.evaluateMissionValue({
    work: completedWork({ state: 'failed', completedAt: '' }),
    contract: fullContract(),
    evidence: verifiedEvidence()
  });

  assert.equal(result.readiness, READINESS_STATE.FAILED);
  assert.equal(
    result.dimensions[DIMENSION.TIME_TO_VERIFIED_OUTCOME].state,
    PROVENANCE_STATE.NOT_APPLICABLE
  );
  assert.notEqual(
    result.dimensions[DIMENSION.VERIFIED_VALUE_STATE].value,
    'Verified'
  );
});

test('the evaluator returns the complete provenance shape and no scalar score', () => {
  const result = missionValue.evaluateMissionValue({
    work: completedWork(),
    contract: fullContract(),
    evidence: verifiedEvidence()
  });

  for (const dimensionId of missionValue.DIMENSION_ORDER) {
    assert.deepEqual(
      Object.keys(result.dimensions[dimensionId]),
      ['state', 'value', 'source', 'observedAt', 'confidence']
    );
  }
  assertNoScalarScore(result);
});
