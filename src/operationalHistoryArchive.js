'use strict';

const crypto = require('node:crypto');
const { auditOperationalHistory } = require('./operationalHistoryAudit');

const ARCHIVE_SCHEMA_VERSION = 'chanter.autoposter.operational-archive.v1';
const ARCHIVE_OPERATION_SCHEMA_VERSION = 'chanter.autoposter.operational-archive-operation.v1';
const FOUNDER_APPROVAL_SCHEMA_VERSION = 'chanter.autoposter.operational-archive-approval.v1';
const AUTHORITY_MANIFEST_SCHEMA_VERSION = 'chanter.autoposter.archive-authority-manifest.v1';
const MAX_ARCHIVE_BATCH_SIZE = 100;
const ELIGIBLE_CLASSIFICATIONS = new Set(['published', 'cancelled', 'legacy']);
const REQUIRED_COVERAGE = Object.freeze([
  'posts',
  'postBatches',
  'canonicalCommands',
  'missionGraphs',
  'evidenceRecords'
]);
const TERMINAL_PROVIDER_OPERATION_STATES = new Set([
  'completed_private',
  'contradictory_public',
  'provider_missing',
  'terminal_failure'
]);
const ACTIVE_OR_UNCERTAIN_STATUSES = new Set([
  'processing',
  'publishing',
  'outcome_unknown'
]);
const UNRESOLVED_APPROVAL_STATES = new Set([
  'pending',
  'requested',
  'waiting',
  'waiting_approval',
  'unresolved'
]);
const RESOLVED_APPROVAL_STATES = new Set([
  'approved',
  'completed',
  'cancelled',
  'canceled',
  'revoked',
  'not_applicable',
  'none'
]);
const ALLOWED_AUTHORITY_MODES = new Set(['explicit_local_fixture', 'firestore_emulator']);

class OperationalHistoryArchiveError extends Error {
  constructor(message, { code = 'archive_validation_failed', status = 409, details = {} } = {}) {
    super(message);
    this.name = 'OperationalHistoryArchiveError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function text(value) {
  return String(value === null || value === undefined ? '' : value).trim();
}

function lower(value) {
  return text(value).toLowerCase();
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function clone(value) {
  return structuredClone(value);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value instanceof Date) return value.toISOString();
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalize(value[key])])
  );
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256(value) {
  return crypto.createHash('sha256').update(
    Buffer.isBuffer(value) ? value : Buffer.from(canonicalJson(value), 'utf8')
  ).digest('hex');
}

function validIso(value) {
  const exact = text(value);
  if (!exact) return '';
  const parsed = new Date(exact);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : '';
}

function recordId(record) {
  return text(record && (record.id || record.recordId || record.postId || record.batchId));
}

function recordTypeCollection(recordType) {
  if (recordType === 'post') return 'posts';
  if (recordType === 'postBatch') return 'postBatches';
  return '';
}

function rawRecords(dataset) {
  return [
    ...array(dataset && dataset.posts).map((record) => ({ recordType: 'post', record })),
    ...array(dataset && (dataset.postBatches || dataset.batches))
      .map((record) => ({ recordType: 'postBatch', record }))
  ];
}

function sanitizeOperationalArchive(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const operationId = text(value.operationId);
  const archivedAt = validIso(value.archivedAt);
  const archivedBy = text(value.archivedBy);
  const classification = lower(value.classification);
  const candidateSetHash = lower(value.candidateSetHash);
  if (
    value.schemaVersion !== ARCHIVE_SCHEMA_VERSION
    || value.state !== 'archived'
    || !operationId
    || !archivedAt
    || !archivedBy
    || !ELIGIBLE_CLASSIFICATIONS.has(classification)
    || !/^[a-f0-9]{64}$/.test(candidateSetHash)
  ) return null;
  return {
    schemaVersion: ARCHIVE_SCHEMA_VERSION,
    state: 'archived',
    operationId,
    archivedAt,
    archivedBy,
    classification,
    candidateSetHash,
    recoverable: true
  };
}

function isOperationallyArchived(record) {
  return Boolean(sanitizeOperationalArchive(record && record.operationalArchive));
}

function recordFingerprint(record) {
  if (!record || typeof record !== 'object') return '';
  const { operationalArchive, ...source } = record;
  return sha256(source);
}

function hasFutureExecution(record, nowMs) {
  const value = validIso(record && (record.scheduledAt || record.scheduledTimeUTC || record.baseAt));
  return Boolean(value) && Date.parse(value) > nowMs;
}

function unresolvedApprovalReason(record) {
  if (!record || typeof record !== 'object') return '';
  if (record.approvalPending === true || record.needsApproval === true) {
    return 'unresolved_approval';
  }
  const state = lower(record.approvalState || record.approvalStatus);
  if (UNRESOLVED_APPROVAL_STATES.has(state)) return 'unresolved_approval';
  if (state && !RESOLVED_APPROVAL_STATES.has(state)) return 'approval_state_unproven';
  if (record.approvalRequired === true && !validIso(record.approvedAt)) {
    return 'approval_evidence_insufficient';
  }
  return '';
}

function providerOperationReason(record) {
  if (!record || typeof record !== 'object') return '';
  const status = lower(record.status || record.publicationState || record.providerStatus);
  if (
    ACTIVE_OR_UNCERTAIN_STATUSES.has(status)
    || record.outcomeUnknown === true
    || record.usageReconciliationRequired === true
  ) return 'provider_operation_active_or_uncertain';
  if (!record.providerOperation) return '';
  const operationState = lower(record.providerOperation.operationState);
  if (!operationState) return 'provider_operation_state_unproven';
  if (!TERMINAL_PROVIDER_OPERATION_STATES.has(operationState)) {
    return 'provider_operation_active_or_uncertain';
  }
  return '';
}

function authorityCoverageBlockers(coverage) {
  return REQUIRED_COVERAGE
    .filter((key) => !coverage || coverage[key] !== true)
    .map((key) => `authority_coverage_missing:${key}`);
}

function authorityManifestBlockers(dataset, { ownerId, authorityMode, nowMs }) {
  const blockers = [];
  for (const key of REQUIRED_COVERAGE) {
    if (!Array.isArray(dataset && dataset[key])) {
      blockers.push(`authority_collection_invalid:${key}`);
    }
  }
  const manifest = dataset && dataset.authorityManifest;
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return [...blockers, 'authority_manifest_missing'];
  }
  if (manifest.schemaVersion !== AUTHORITY_MANIFEST_SCHEMA_VERSION) {
    blockers.push('authority_manifest_schema_invalid');
  }
  if (text(manifest.ownerId) !== ownerId) blockers.push('authority_manifest_owner_mismatch');
  if (text(manifest.mode) !== authorityMode) blockers.push('authority_manifest_mode_mismatch');
  if (manifest.complete !== true) blockers.push('authority_manifest_incomplete');
  const observedAt = validIso(manifest.observedAt);
  if (!observedAt || Date.parse(observedAt) > nowMs) blockers.push('authority_manifest_timestamp_invalid');
  for (const key of REQUIRED_COVERAGE) {
    if (!manifest.coverage || manifest.coverage[key] !== true) {
      blockers.push(`authority_manifest_coverage_missing:${key}`);
    }
  }
  return [...new Set(blockers)];
}

function assessArchiveCandidate(raw, reportRecord, { ownerId, nowMs }) {
  const blockers = [];
  if (!raw || typeof raw !== 'object') blockers.push('record_not_found');
  if (!reportRecord || !ELIGIBLE_CLASSIFICATIONS.has(reportRecord.classification)) {
    blockers.push('classification_not_archive_eligible');
  }
  if (!recordId(raw)) blockers.push('record_id_not_durable');
  if (!text(raw && raw.userId) || text(raw && raw.userId) !== ownerId) {
    blockers.push('archive_owner_unproven');
  }
  if (isOperationallyArchived(raw)) blockers.push('already_archived');
  if (hasFutureExecution(raw, nowMs)) blockers.push('future_execution_scheduled');
  const operationReason = providerOperationReason(raw);
  if (operationReason) blockers.push(operationReason);
  const approvalReason = unresolvedApprovalReason(raw);
  if (approvalReason) blockers.push(approvalReason);
  return [...new Set(blockers)];
}

function normalizeLimit(value) {
  const limit = Number(value === undefined ? 25 : value);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ARCHIVE_BATCH_SIZE) {
    throw new OperationalHistoryArchiveError(
      `maxCandidates must be an integer between 1 and ${MAX_ARCHIVE_BATCH_SIZE}.`,
      { code: 'archive_batch_limit_invalid', status: 400 }
    );
  }
  return limit;
}

function approvalBinding(value) {
  return {
    schemaVersion: FOUNDER_APPROVAL_SCHEMA_VERSION,
    decision: 'approved',
    role: 'founder',
    approverId: text(value && value.approverId),
    approvedAt: validIso(value && value.approvedAt),
    ownerId: text(value && value.ownerId),
    operationId: text(value && value.operationId),
    candidateSetHash: lower(value && value.candidateSetHash),
    candidateIds: array(value && value.candidateIds).map(text).filter(Boolean).sort()
  };
}

function approvalSecret(value) {
  const secret = text(value);
  if (Buffer.byteLength(secret, 'utf8') < 32) {
    throw new OperationalHistoryArchiveError(
      'Founder archive approval verification is unavailable.',
      { code: 'founder_approval_verifier_unavailable', status: 503 }
    );
  }
  return secret;
}

function approvalSignature(binding, secret) {
  return crypto.createHmac('sha256', approvalSecret(secret))
    .update(canonicalJson(binding))
    .digest('hex');
}

function createFounderArchiveApproval(preview, { approverId, approvedAt, secret } = {}) {
  if (!preview || preview.executionReady !== true || !array(preview.candidateIds).length) {
    throw new OperationalHistoryArchiveError(
      'Only an execution-ready preview can be approved.',
      { code: 'archive_preview_not_execution_ready' }
    );
  }
  const binding = approvalBinding({
    approverId,
    approvedAt,
    ownerId: preview.ownerId,
    operationId: preview.operationId,
    candidateSetHash: preview.candidateSetHash,
    candidateIds: preview.candidateIds
  });
  if (!binding.approverId || !binding.approvedAt) {
    throw new OperationalHistoryArchiveError(
      'Founder approver and approval timestamp are required.',
      { code: 'founder_approval_incomplete', status: 400 }
    );
  }
  return {
    ...binding,
    verificationMethod: 'hmac_sha256',
    signature: approvalSignature(binding, secret)
  };
}

function verifyFounderArchiveApproval(approval, expected, secret) {
  if (
    !approval
    || approval.schemaVersion !== FOUNDER_APPROVAL_SCHEMA_VERSION
    || approval.decision !== 'approved'
    || approval.role !== 'founder'
    || approval.verificationMethod !== 'hmac_sha256'
  ) return false;
  const binding = approvalBinding(approval);
  const expectedIds = array(expected && expected.candidateIds).map(text).filter(Boolean).sort();
  if (
    !binding.approverId
    || !binding.approvedAt
    || binding.ownerId !== text(expected && expected.ownerId)
    || binding.operationId !== text(expected && expected.operationId)
    || binding.candidateSetHash !== lower(expected && expected.candidateSetHash)
    || canonicalJson(binding.candidateIds) !== canonicalJson(expectedIds)
  ) return false;
  const signature = lower(approval.signature);
  if (!/^[a-f0-9]{64}$/.test(signature)) return false;
  const calculated = approvalSignature(binding, secret);
  return crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(calculated, 'hex'));
}

function projectionCounts(dataset, now) {
  const report = auditOperationalHistory(dataset, { now, source: { kind: 'archive_projection' } });
  const raw = rawRecords(dataset);
  const archivedKeys = new Set(
    raw.filter(({ record }) => isOperationallyArchived(record))
      .map(({ recordType, record }) => `${recordType}:${recordId(record)}`)
  );
  const operational = report.projections.operational.filter(
    (record) => !archivedKeys.has(`${record.recordType}:${record.recordId}`)
  );
  return {
    total: raw.length,
    defaultVisible: raw.filter(({ record }) => !isOperationallyArchived(record)).length,
    operational: operational.length,
    history: report.projections.history.length,
    cleanupReview: report.projections.cleanupReview.length,
    archived: archivedKeys.size
  };
}

function createArchiveEnvelope({ operationId, archivedAt, archivedBy, classification, candidateSetHash }) {
  return {
    schemaVersion: ARCHIVE_SCHEMA_VERSION,
    state: 'archived',
    operationId,
    archivedAt,
    archivedBy,
    classification,
    candidateSetHash,
    recoverable: true
  };
}

function createLocalFixtureArchiveRepository(initialState, options = {}) {
  let state = clone(initialState || {});
  if (!Array.isArray(state.archiveOperations)) state.archiveOperations = [];
  const failures = new Set(array(options.failRecordIds).map(text));

  function collection(recordType) {
    const key = recordTypeCollection(recordType);
    if (!key) return null;
    if (!Array.isArray(state[key])) state[key] = [];
    return state[key];
  }

  return {
    async loadDataset() {
      return clone(state);
    },
    async getOperation(operationId) {
      const found = state.archiveOperations.find(
        (operation) => text(operation.operationId) === text(operationId)
      );
      return found ? clone(found) : null;
    },
    async archiveRecord({ recordType, recordId: id, expectedFingerprint, archive }) {
      if (failures.has(id)) throw new Error(`Fixture-injected archive failure for ${id}.`);
      const records = collection(recordType);
      if (!records) return { status: 'skipped', reason: 'record_type_unsupported' };
      const index = records.findIndex((record) => recordId(record) === id);
      if (index < 0) return { status: 'skipped', reason: 'record_not_found' };
      const current = records[index];
      const existing = sanitizeOperationalArchive(current.operationalArchive);
      if (existing) {
        return existing.operationId === archive.operationId
          ? { status: 'already_archived_same_operation' }
          : { status: 'skipped', reason: 'already_archived_by_other_operation' };
      }
      if (recordFingerprint(current) !== expectedFingerprint) {
        return { status: 'skipped', reason: 'record_changed_since_preview' };
      }
      records[index] = { ...current, operationalArchive: clone(archive) };
      return { status: 'archived' };
    },
    async saveOperation(operation) {
      const existing = state.archiveOperations.find(
        (item) => text(item.operationId) === text(operation.operationId)
      );
      if (!existing) state.archiveOperations.push(clone(operation));
      return clone(existing || operation);
    },
    snapshot() {
      return clone(state);
    }
  };
}

function createOperationalHistoryArchiveService({
  repository,
  ownerId,
  authorityMode,
  approvalSecret: secret,
  now = () => new Date().toISOString()
} = {}) {
  if (
    !repository
    || typeof repository.loadDataset !== 'function'
    || typeof repository.getOperation !== 'function'
    || typeof repository.archiveRecord !== 'function'
    || typeof repository.saveOperation !== 'function'
  ) {
    throw new TypeError('A complete operational archive repository is required.');
  }
  const exactOwnerId = text(ownerId);
  if (!exactOwnerId) throw new TypeError('An explicit archive ownerId is required.');

  async function preview({ maxCandidates } = {}) {
    const limit = normalizeLimit(maxCandidates);
    const generatedAt = validIso(now());
    if (!generatedAt) throw new TypeError('Archive clock returned an invalid timestamp.');
    const dataset = await repository.loadDataset();
    const report = auditOperationalHistory(dataset, {
      now: generatedAt,
      source: { kind: authorityMode || 'unknown' }
    });
    const rawByKey = new Map(
      rawRecords(dataset).map(({ recordType, record }) => [
        `${recordType}:${recordId(record)}`,
        record
      ])
    );
    const assessments = report.records
      .filter((record) => ELIGIBLE_CLASSIFICATIONS.has(record.classification))
      .map((record) => {
        const key = `${record.recordType}:${record.recordId}`;
        const raw = rawByKey.get(key);
        const blockers = assessArchiveCandidate(raw, record, {
          ownerId: exactOwnerId,
          nowMs: Date.parse(generatedAt)
        });
        return {
          recordType: record.recordType,
          recordId: record.recordId,
          classification: record.classification,
          providerArtifactId: record.providerArtifactId,
          canonicalLinkage: record.canonicalLinkage,
          fingerprint: raw ? recordFingerprint(raw) : '',
          blockers
        };
      })
      .sort((a, b) => (
        a.recordType.localeCompare(b.recordType) || a.recordId.localeCompare(b.recordId)
      ));
    const eligible = assessments.filter((candidate) => candidate.blockers.length === 0);
    const selected = eligible.slice(0, limit);
    const deferred = eligible.slice(limit).map((candidate) => ({
      ...candidate,
      blockers: ['batch_limit_deferred']
    }));
    const skipped = [
      ...assessments.filter((candidate) => candidate.blockers.length > 0),
      ...deferred
    ];
    const candidateBinding = selected.map((candidate) => ({
      recordType: candidate.recordType,
      recordId: candidate.recordId,
      classification: candidate.classification,
      fingerprint: candidate.fingerprint
    }));
    const candidateSetHash = sha256({
      schemaVersion: ARCHIVE_OPERATION_SCHEMA_VERSION,
      ownerId: exactOwnerId,
      candidates: candidateBinding
    });
    const operationId = `autoposter-archive-v1-${sha256({
      schemaVersion: ARCHIVE_OPERATION_SCHEMA_VERSION,
      ownerId: exactOwnerId,
      candidateSetHash
    })}`;
    const coverageBlockers = authorityCoverageBlockers(report.coverage);
    const modeBlockers = ALLOWED_AUTHORITY_MODES.has(authorityMode)
      ? []
      : ['authority_mode_not_local_or_emulator'];
    const manifestBlockers = authorityManifestBlockers(dataset, {
      ownerId: exactOwnerId,
      authorityMode,
      nowMs: Date.parse(generatedAt)
    });
    const blockers = [...new Set([...modeBlockers, ...coverageBlockers, ...manifestBlockers])];
    return {
      schemaVersion: ARCHIVE_OPERATION_SCHEMA_VERSION,
      mode: 'preview',
      readOnly: true,
      generatedAt,
      ownerId: exactOwnerId,
      authorityMode: authorityMode || 'unknown',
      coverage: report.coverage,
      operationId,
      candidateSetHash,
      candidateIds: selected.map((candidate) => candidate.recordId),
      candidates: selected,
      skipped,
      remainingCandidateIds: deferred.map((candidate) => candidate.recordId),
      maxCandidates: limit,
      beforeCounts: projectionCounts(dataset, generatedAt),
      blockers,
      executionReady: blockers.length === 0 && selected.length > 0,
      mutationEvidence: {
        performed: false,
        writes: 0,
        archives: 0,
        deletes: 0
      }
    };
  }

  async function execute({ approval, maxCandidates } = {}) {
    const baseApproval = approvalBinding(approval);
    if (!baseApproval.operationId) {
      throw new OperationalHistoryArchiveError(
        'A signed founder approval is required.',
        { code: 'founder_approval_required', status: 403 }
      );
    }
    const existing = await repository.getOperation(baseApproval.operationId);
    if (existing) {
      const verifiedReplay = verifyFounderArchiveApproval(approval, {
        ownerId: existing.ownerId,
        operationId: existing.operationId,
        candidateSetHash: existing.candidateSetHash,
        candidateIds: existing.candidateIds
      }, secret);
      if (!verifiedReplay || existing.approver !== baseApproval.approverId) {
        throw new OperationalHistoryArchiveError(
          'Founder approval verification failed.',
          { code: 'founder_approval_invalid', status: 403 }
        );
      }
      return {
        ...existing,
        replayed: true,
        replayMutationCount: 0
      };
    }

    const frozen = await preview({ maxCandidates });
    if (!frozen.executionReady) {
      throw new OperationalHistoryArchiveError(
        'Archive execution is not safe for the current authority snapshot.',
        {
          code: 'archive_authority_incomplete',
          details: { blockers: frozen.blockers, candidateIds: frozen.candidateIds }
        }
      );
    }
    if (!verifyFounderArchiveApproval(approval, frozen, secret)) {
      throw new OperationalHistoryArchiveError(
        'Founder approval verification failed.',
        { code: 'founder_approval_invalid', status: 403 }
      );
    }
    const executedAt = validIso(now());
    if (
      !executedAt
      || Date.parse(baseApproval.approvedAt) < Date.parse(frozen.generatedAt)
      || Date.parse(baseApproval.approvedAt) > Date.parse(executedAt)
    ) {
      throw new OperationalHistoryArchiveError(
        'Founder approval timestamp is not valid for this frozen preview.',
        { code: 'founder_approval_timestamp_invalid', status: 403 }
      );
    }

    const beforeDataset = await repository.loadDataset();
    const beforeCounts = projectionCounts(beforeDataset, frozen.generatedAt);
    const archivedIds = [];
    const skipped = [];
    const failures = [];
    for (const candidate of frozen.candidates) {
      const archive = createArchiveEnvelope({
        operationId: frozen.operationId,
        archivedAt: executedAt,
        archivedBy: baseApproval.approverId,
        classification: candidate.classification,
        candidateSetHash: frozen.candidateSetHash
      });
      try {
        const result = await repository.archiveRecord({
          recordType: candidate.recordType,
          recordId: candidate.recordId,
          expectedFingerprint: candidate.fingerprint,
          archive
        });
        if (result && result.status === 'archived') {
          archivedIds.push(candidate.recordId);
        } else if (result && result.status === 'already_archived_same_operation') {
          skipped.push({ recordId: candidate.recordId, reason: result.status });
        } else {
          skipped.push({
            recordId: candidate.recordId,
            reason: text(result && result.reason) || 'archive_not_applied'
          });
        }
      } catch (error) {
        failures.push({
          recordId: candidate.recordId,
          reason: text(error && error.message) || 'archive_adapter_failure'
        });
      }
    }

    const afterDataset = await repository.loadDataset();
    const afterCounts = projectionCounts(afterDataset, frozen.generatedAt);
    const state = skipped.length || failures.length || archivedIds.length !== frozen.candidateIds.length
      ? 'partial'
      : 'completed';
    const evidence = {
      schemaVersion: ARCHIVE_OPERATION_SCHEMA_VERSION,
      operationId: frozen.operationId,
      state,
      approver: baseApproval.approverId,
      approvedAt: baseApproval.approvedAt,
      executedAt,
      approvalVerificationMethod: 'hmac_sha256',
      approvalSignatureSha256: sha256(lower(approval.signature)),
      ownerId: exactOwnerId,
      authorityMode,
      candidateSetHash: frozen.candidateSetHash,
      candidateIds: frozen.candidateIds,
      archivedIds,
      skippedIds: skipped.map((item) => item.recordId),
      skipped,
      failures,
      beforeCounts,
      afterCounts,
      criteria: {
        classifications: [...ELIGIBLE_CLASSIFICATIONS],
        maxCandidates: frozen.maxCandidates,
        authorityCoverage: frozen.coverage,
        candidateSetFrozen: true,
        physicalDeletionAllowed: false
      },
      physicalDeletes: 0,
      recoverable: true,
      replayed: false
    };
    await repository.saveOperation(evidence);
    return evidence;
  }

  return { preview, execute };
}

module.exports = {
  AUTHORITY_MANIFEST_SCHEMA_VERSION,
  ARCHIVE_OPERATION_SCHEMA_VERSION,
  ARCHIVE_SCHEMA_VERSION,
  FOUNDER_APPROVAL_SCHEMA_VERSION,
  MAX_ARCHIVE_BATCH_SIZE,
  OperationalHistoryArchiveError,
  createFounderArchiveApproval,
  createLocalFixtureArchiveRepository,
  createOperationalHistoryArchiveService,
  isOperationallyArchived,
  projectionCounts,
  recordFingerprint,
  sanitizeOperationalArchive,
  verifyFounderArchiveApproval
};
