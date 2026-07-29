'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const missionValue = require('../src/missionValue');
const {
  ACCEPTANCE_CRITERION,
  ACCEPTANCE_CRITERIA,
  projectAutoPosterMissionValue
} = require('../src/platformAutoPosterMissionValue');
const { createAutoPosterWorkProvider } = require('../src/platformAutoPosterProvider');

const CREATED_AT = '2026-07-29T08:00:00.000Z';
const UPDATED_AT = '2026-07-29T08:05:00.000Z';
const SCHEDULED_AT = '2026-07-29T09:00:00.000Z';

function batch(overrides = {}) {
  return {
    batchId: 'customer-batch-001',
    userId: 'customer-owner',
    workspaceId: 'customer-workspace',
    status: 'ready',
    itemCount: 2,
    preparedCount: 2,
    failedCount: 0,
    acceptedCount: 0,
    videoCount: 1,
    destinationCount: 2,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    ...overrides
  };
}

function item(index, overrides = {}) {
  return {
    id: `customer-post-${index + 1}`,
    userId: 'customer-owner',
    workspaceId: 'customer-workspace',
    batchId: 'customer-batch-001',
    sourceIndex: 0,
    provider: index === 0 ? 'tiktok' : 'youtube',
    providerSource: 'explicit',
    accountId: index === 0 ? 'private-tiktok-account' : 'private-youtube-channel',
    creationSource: '',
    runtimeGraphId: '',
    runtimeMissionId: '',
    runtimeAction: '',
    mediaType: 'video',
    caption: 'PRIVATE launch caption',
    mediaPath: 'C:\\private\\customer\\video.mp4',
    scheduledAt: SCHEDULED_AT,
    status: 'scheduled',
    approved: false,
    approvalState: 'unapproved',
    approvedAt: null,
    approvedBy: '',
    history: [{ event: 'validated', at: '2026-07-29T08:01:00.000Z' }],
    lastResult: null,
    postedAt: null,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    ...overrides
  };
}

function items(overridesByIndex = {}) {
  return [0, 1].map((index) => item(index, overridesByIndex[index] || {}));
}

function approvedScheduled(index) {
  const approvedAt = `2026-07-29T08:1${index}:00.000Z`;
  return item(index, {
    approved: true,
    approvalState: 'approved',
    approvedAt,
    approvedBy: 'customer-reviewer',
    history: [
      { event: 'validated', at: '2026-07-29T08:01:00.000Z' },
      { event: 'approved', at: approvedAt }
    ],
    updatedAt: approvedAt
  });
}

function providerSuccess(index) {
  const approvedAt = `2026-07-29T08:1${index}:00.000Z`;
  const dispatchAt = `2026-07-29T09:0${index}:00.000Z`;
  const completedAt = `2026-07-29T09:1${index}:00.000Z`;
  return item(index, {
    status: 'posted',
    approved: true,
    approvalState: 'approved',
    approvedAt,
    approvedBy: 'customer-reviewer',
    postedAt: completedAt,
    lastResult: {
      ok: true,
      mode: 'api',
      completedAt
    },
    ...(index === 1 ? { providerVerification: { verifiedAt: completedAt } } : {}),
    history: [
      { event: 'approved', at: approvedAt },
      { event: 'publish_attempt', at: dispatchAt },
      { event: 'posted', at: completedAt }
    ],
    updatedAt: completedAt
  });
}

function providerFailure(index) {
  const approvedAt = `2026-07-29T08:1${index}:00.000Z`;
  const dispatchAt = `2026-07-29T09:0${index}:00.000Z`;
  const completedAt = `2026-07-29T09:1${index}:00.000Z`;
  return item(index, {
    status: 'failed',
    approved: true,
    approvalState: 'approved',
    approvedAt,
    approvedBy: 'customer-reviewer',
    lastResult: {
      ok: false,
      mode: 'api',
      code: 'PROVIDER_REFUSED',
      completedAt
    },
    history: [
      { event: 'approved', at: approvedAt },
      { event: 'publish_attempt', at: dispatchAt },
      { event: 'failed', at: completedAt }
    ],
    updatedAt: completedAt
  });
}

function evaluationFor(batchRecord, childItems) {
  const metadata = projectAutoPosterMissionValue(batchRecord, childItems);
  assert.ok(metadata);
  return {
    metadata,
    evaluation: missionValue.evaluateMissionValue({
      work: {
        state: 'completed',
        startedAt: metadata.startedAt,
        completedAt: metadata.completedAt
      },
      contract: metadata.missionValueContract,
      evidence: metadata.missionValueEvidence
    })
  };
}

test('the existing AutoPoster provider emits a valid optional value contract from its read-only batch view', async () => {
  const sourceBatch = batch();
  const childItems = items();
  const reads = [];
  const provider = createAutoPosterWorkProvider({
    listBatches: async () => ({ batches: [sourceBatch] }),
    getBatchView: async (context, batchId, options) => {
      reads.push({ context, batchId, options });
      return { batch: sourceBatch, items: childItems };
    }
  });

  const work = await provider.listWork({ userId: 'customer-owner' });
  assert.equal(work.length, 1);
  assert.deepEqual(reads, [{
    context: { userId: 'customer-owner' },
    batchId: sourceBatch.batchId,
    options: { autoResume: false }
  }]);
  assert.deepEqual(
    missionValue.validateMissionValueContract(work[0].missionValueContract),
    work[0].missionValueContract
  );
  assert.deepEqual(work[0].missionValueContract.objective.acceptanceCriteria, ACCEPTANCE_CRITERIA);
  assert.equal(work[0].missionValueContract.budgets.cost.maximum, null);
  assert.equal(work[0].missionValueContract.budgets.humanAttentionMinutes, null);
  assert.equal(work[0].missionValueContract.budgets.riskTolerance, null);
  assert.equal(work[0].missionValueContract.expected.reversibility, 'unknown');
});

test('scheduled customer work maps persistence, schedule, and approval evidence without inferring a provider result', () => {
  const { metadata, evaluation } = evaluationFor(batch(), items());
  assert.deepEqual(
    metadata.missionValueEvidence.map((entry) => entry.acceptanceCriterion),
    ACCEPTANCE_CRITERIA.slice(0, 3)
  );
  assert.equal(
    metadata.missionValueEvidence.some((entry) => (
      entry.acceptanceCriterion === ACCEPTANCE_CRITERION.PROVIDER_OUTCOME
    )),
    false
  );
  assert.equal(evaluation.readiness, missionValue.READINESS_STATE.MEASUREMENT_INCOMPLETE);
  assert.equal(
    evaluation.criterionCoverage.find((entry) => (
      entry.criterion === ACCEPTANCE_CRITERION.PROVIDER_OUTCOME
    )).state,
    'unmapped'
  );
});

test('explicit approval state verifies only the approval-gate criterion while provider outcome remains unmapped', () => {
  const { metadata, evaluation } = evaluationFor(
    batch({ status: 'completed', acceptedCount: 2 }),
    [approvedScheduled(0), approvedScheduled(1)]
  );
  const approval = metadata.missionValueEvidence.find((entry) => (
    entry.acceptanceCriterion === ACCEPTANCE_CRITERION.APPROVAL
  ));
  assert.equal(approval.verificationState, 'verified');
  assert.equal(metadata.missionValueEvidence.length, 3);
  assert.notEqual(evaluation.readiness, missionValue.READINESS_STATE.VERIFIED);
});

test('exact durable API outcomes verify the provider criterion and the whole declared value contract', () => {
  const { metadata, evaluation } = evaluationFor(
    batch({ status: 'completed', acceptedCount: 2 }),
    [providerSuccess(0), providerSuccess(1)]
  );
  const providerEvidence = metadata.missionValueEvidence.find((entry) => (
    entry.acceptanceCriterion === ACCEPTANCE_CRITERION.PROVIDER_OUTCOME
  ));
  assert.equal(providerEvidence.verificationState, 'verified');
  assert.equal(evaluation.readiness, missionValue.READINESS_STATE.VERIFIED);
  assert.ok(metadata.completedAt);
  assert.equal(evaluation.criterionCoverage.every((entry) => entry.state === 'verified'), true);
});

test('YouTube API acceptance without durable provider verification cannot verify the outcome', () => {
  const youtubeWithoutVerification = providerSuccess(1);
  delete youtubeWithoutVerification.providerVerification;
  const { metadata, evaluation } = evaluationFor(
    batch({ status: 'completed', acceptedCount: 2 }),
    [providerSuccess(0), youtubeWithoutVerification]
  );
  const providerEvidence = metadata.missionValueEvidence.find((entry) => (
    entry.acceptanceCriterion === ACCEPTANCE_CRITERION.PROVIDER_OUTCOME
  ));
  assert.equal(providerEvidence.verificationState, 'pending');
  assert.notEqual(evaluation.readiness, missionValue.READINESS_STATE.VERIFIED);
});

test('an in-flight dispatch maps pending provider evidence and produces verification pending', () => {
  const processing = approvedScheduled(0);
  processing.status = 'processing';
  processing.history.push({ event: 'publish_attempt', at: '2026-07-29T09:00:00.000Z' });
  processing.updatedAt = '2026-07-29T09:00:00.000Z';
  const { metadata, evaluation } = evaluationFor(
    batch({ status: 'completed', acceptedCount: 2 }),
    [processing, approvedScheduled(1)]
  );
  const providerEvidence = metadata.missionValueEvidence.find((entry) => (
    entry.acceptanceCriterion === ACCEPTANCE_CRITERION.PROVIDER_OUTCOME
  ));
  assert.equal(providerEvidence.verificationState, 'pending');
  assert.equal(evaluation.readiness, missionValue.READINESS_STATE.VERIFICATION_PENDING);
});

test('a durable provider terminal failure stays failed and cannot become verified by other evidence', () => {
  const { metadata, evaluation } = evaluationFor(
    batch({ status: 'completed', acceptedCount: 2 }),
    [providerFailure(0), providerSuccess(1)]
  );
  const providerEvidence = metadata.missionValueEvidence.find((entry) => (
    entry.acceptanceCriterion === ACCEPTANCE_CRITERION.PROVIDER_OUTCOME
  ));
  assert.equal(providerEvidence.verificationState, 'failed');
  assert.equal(evaluation.readiness, missionValue.READINESS_STATE.FAILED);
  assert.equal(metadata.completedAt, undefined);
});

test('manual posted state is not accepted as a durable provider outcome', () => {
  const manuallyPosted = [0, 1].map((index) => {
    const approved = approvedScheduled(index);
    return {
      ...approved,
      status: 'posted',
      postedAt: '2026-07-29T09:10:00.000Z',
      lastResult: {
        ok: true,
        mode: 'manual',
        completedAt: '2026-07-29T09:10:00.000Z'
      },
      history: [
        ...approved.history,
        { event: 'marked_posted', at: '2026-07-29T09:10:00.000Z' }
      ]
    };
  });
  const { metadata, evaluation } = evaluationFor(
    batch({ status: 'completed', acceptedCount: 2 }),
    manuallyPosted
  );
  assert.equal(metadata.missionValueEvidence.length, 3);
  assert.notEqual(evaluation.readiness, missionValue.READINESS_STATE.VERIFIED);
});

test('insufficient or contradictory schedule/destination facts leave the contract absent', () => {
  const missingSchedule = items({ 0: { scheduledAt: null } });
  assert.equal(projectAutoPosterMissionValue(batch(), missingSchedule), null);

  const duplicateDestination = items({
    1: {
      provider: 'tiktok',
      accountId: 'private-tiktok-account'
    }
  });
  assert.equal(projectAutoPosterMissionValue(batch(), duplicateDestination), null);
});

test('internal Runtime-linked work is ineligible for customer mission-value metadata', async () => {
  const internalItems = items({ 0: { runtimeGraphId: 'internal-graph-secret' } });
  assert.equal(projectAutoPosterMissionValue(batch(), internalItems), null);

  const provider = createAutoPosterWorkProvider({
    listBatches: async () => ({
      batches: [{
        ...batch(),
        missionValueContract: {
          schema: missionValue.MISSION_VALUE_SCHEMA,
          objective: { statement: 'Forged customer action.' }
        }
      }]
    }),
    getBatchView: async () => ({ batch: batch(), items: internalItems })
  });
  const [work] = await provider.listWork({});
  assert.equal('missionValueContract' in work, false);
  assert.equal('missionValueEvidence' in work, false);
});

test('wrong-criterion evidence remains unmapped and cannot verify provider outcome', () => {
  const metadata = projectAutoPosterMissionValue(
    batch({ status: 'completed', acceptedCount: 2 }),
    [providerSuccess(0), providerSuccess(1)]
  );
  const evidence = metadata.missionValueEvidence.map((entry) => (
    entry.acceptanceCriterion === ACCEPTANCE_CRITERION.PROVIDER_OUTCOME
      ? { ...entry, acceptanceCriterion: 'A different criterion.' }
      : entry
  ));
  const evaluation = missionValue.evaluateMissionValue({
    work: { state: 'completed' },
    contract: metadata.missionValueContract,
    evidence
  });
  assert.equal(evaluation.readiness, missionValue.READINESS_STATE.MEASUREMENT_INCOMPLETE);
  assert.equal(
    evaluation.criterionCoverage.find((entry) => (
      entry.criterion === ACCEPTANCE_CRITERION.PROVIDER_OUTCOME
    )).state,
    'unmapped'
  );
});

test('unsupported cost, attention, risk, and learning remain unavailable with no scalar score', () => {
  const { evaluation } = evaluationFor(batch(), items());
  for (const dimension of [
    missionValue.DIMENSION.COST,
    missionValue.DIMENSION.HUMAN_ATTENTION,
    missionValue.DIMENSION.RISK,
    missionValue.DIMENSION.LEARNING_STATE
  ]) {
    assert.equal(evaluation.dimensions[dimension].state, missionValue.PROVENANCE_STATE.UNAVAILABLE);
  }
  assert.equal('score' in evaluation, false);
  assert.equal('scalarScore' in evaluation, false);
});

test('the objective uses only customer-safe aggregate facts', () => {
  const metadata = projectAutoPosterMissionValue(batch(), items());
  const statement = metadata.missionValueContract.objective.statement;
  assert.match(statement, /2 video releases/);
  assert.match(statement, /2 destinations/);
  assert.match(statement, new RegExp(SCHEDULED_AT.replaceAll('.', '\\.')));
  for (const privateValue of [
    'PRIVATE launch caption',
    'private-tiktok-account',
    'private-youtube-channel',
    'customer-batch-001',
    'C:\\private\\customer\\video.mp4'
  ]) {
    assert.equal(statement.includes(privateValue), false);
  }
});

test('the producer projection owns no persistence or execution subsystem', () => {
  const root = path.join(__dirname, '..');
  const projection = fs.readFileSync(
    path.join(root, 'src', 'platformAutoPosterMissionValue.js'),
    'utf8'
  );
  const provider = fs.readFileSync(
    path.join(root, 'src', 'platformAutoPosterProvider.js'),
    'utf8'
  );
  assert.equal(/require\(['"]\.\/(?:storage|firestore|scheduler)/.test(projection), false);
  assert.equal(/\b(?:create|update|delete|approve|publish|dispatch|retry)\w*\s*\(/.test(projection), false);
  assert.match(provider, /getBatchView\(context, batchId, \{ autoResume: false \}\)/);
  assert.equal(/scalar.?score|weighted.?score/i.test(`${projection}\n${provider}`), false);
});
