'use strict';

const CLASSIFICATIONS = Object.freeze([
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

const REMOVABLE_CLASSIFICATIONS = new Set(['test_demo', 'duplicate', 'orphaned']);
const ACTIVE_STATUSES = new Set(['pending', 'ready', 'processing', 'publishing', 'outcome_unknown']);
const CANCELLED_STATUSES = new Set(['cancelled', 'canceled', 'tombstoned']);
const PUBLISHED_STATUSES = new Set(['posted', 'published', 'uploaded_private']);
const TEST_MARKER = /(^|[_:.-])(test|demo|fixture|seed)([_:.-]|$)/i;

function text(value) {
  return String(value === null || value === undefined ? '' : value).trim();
}

function lower(value) {
  return text(value).toLowerCase();
}

function own(object, key) {
  return Boolean(object) && Object.prototype.hasOwnProperty.call(object, key);
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function recordId(record, fallback) {
  return text(record && (record.id || record.recordId || record.postId || record.batchId)) || fallback;
}

function dateIso(value) {
  if (!value) return '';
  if (typeof value === 'object') {
    if (typeof value.toDate === 'function') return dateIso(value.toDate());
    if (Number.isFinite(Number(value._seconds))) {
      return new Date(Number(value._seconds) * 1000).toISOString();
    }
    if (Number.isFinite(Number(value.seconds))) {
      return new Date(Number(value.seconds) * 1000).toISOString();
    }
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : '';
}

function firstScalarByKey(value, keys, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 4) return '';
  for (const [key, child] of Object.entries(value)) {
    const normalized = lower(key).replace(/[^a-z0-9]/g, '');
    if (keys.has(normalized) && ['string', 'number'].includes(typeof child) && text(child)) {
      return text(child);
    }
  }
  for (const child of Object.values(value)) {
    if (!child || typeof child !== 'object') continue;
    const found = firstScalarByKey(child, keys, depth + 1);
    if (found) return found;
  }
  return '';
}

function providerArtifactId(record) {
  if (!record || typeof record !== 'object') return '';
  const direct = text(
    record.publishId
    || record.providerPostId
    || record.externalVideoId
    || record.youtubeVideoId
  );
  if (direct) return direct;
  const evidenceContainers = [
    record.providerVerification,
    record.providerOperation,
    record.lastResult && record.lastResult.response,
    record.lastInstagramResult && record.lastInstagramResult.response
  ];
  return firstScalarByKey(evidenceContainers, new Set([
    'publishid',
    'providerpostid',
    'externalvideoid',
    'videoid',
    'postid',
    'itemid'
  ]));
}

function canonicalLinkage(record) {
  const historyCount = array(record && record.history).length;
  return {
    commandId: text(record && (record.canonicalCommandId || record.commandId)),
    graphId: text(record && (record.runtimeGraphId || record.graphId)),
    missionId: text(record && (record.runtimeMissionId || record.missionId)),
    approvalId: text(record && record.approvalId),
    evidenceBundleId: text(record && record.evidenceBundleId),
    batchId: text(record && record.batchId),
    seriesId: text(record && record.seriesId),
    campaignId: text(record && record.campaignId),
    duplicateOf: text(record && (record.duplicateOf || record.canonicalDuplicateOf)),
    historyEntries: historyCount,
    providerOperation: Boolean(record && record.providerOperation),
    providerVerification: Boolean(record && record.providerVerification)
  };
}

function hasCanonicalEvidence(linkage, artifactId) {
  return Boolean(
    artifactId
    || linkage.commandId
    || linkage.graphId
    || linkage.missionId
    || linkage.approvalId
    || linkage.evidenceBundleId
    || linkage.duplicateOf
    || linkage.historyEntries > 0
    || linkage.providerOperation
    || linkage.providerVerification
  );
}

function explicitNonProduction(record) {
  if (!record || typeof record !== 'object') return false;
  if (
    record.isTest === true
    || record.isDemo === true
    || record.testRecord === true
    || record.demoRecord === true
    || lower(record.cleanupClassification) === 'test_demo'
  ) return true;
  if (record.metadata && typeof record.metadata === 'object') {
    if (record.metadata.isTest === true || record.metadata.isDemo === true) return true;
  }
  const environment = lower(record.environment || (record.metadata && record.metadata.environment));
  if (['test', 'demo', 'fixture'].includes(environment)) return true;
  return TEST_MARKER.test(text(record.creationSource));
}

function approved(record) {
  return Boolean(dateIso(record && record.approvedAt) || text(record && record.approvalId));
}

function scheduledAt(record) {
  return dateIso(record && (record.scheduledAt || record.scheduledTimeUTC));
}

function isFutureSchedule(record, nowMs) {
  const value = scheduledAt(record);
  return Boolean(value) && Date.parse(value) > nowMs;
}

function isArchived(record) {
  const archive = record && record.operationalArchive;
  return Boolean(
    archive
    && archive.schemaVersion === 'chanter.autoposter.operational-archive.v1'
    && archive.state === 'archived'
    && text(archive.operationId)
    && dateIso(archive.archivedAt)
    && text(archive.archivedBy)
    && ['published', 'cancelled', 'legacy'].includes(lower(archive.classification))
    && /^[a-f0-9]{64}$/.test(lower(archive.candidateSetHash))
    && archive.recoverable === true
  );
}

function publicationStatus(record) {
  return lower(record && (record.status || record.publicationState || record.providerStatus));
}

function duplicateIdentity(record) {
  const idempotencyKey = text(record && (record.runtimeIdempotencyKey || record.idempotencyKey));
  if (!idempotencyKey) return '';
  return [
    text(record.userId),
    text(record.workspaceId),
    lower(record.provider || record.platform),
    text(record.accountId || record.tiktokOpenId),
    idempotencyKey
  ].join('|');
}

function canonicalScore(record) {
  const linkage = canonicalLinkage(record);
  const artifact = providerArtifactId(record);
  let score = 0;
  if (PUBLISHED_STATUSES.has(publicationStatus(record)) || artifact) score += 1000;
  if (hasCanonicalEvidence(linkage, artifact)) score += 500;
  if (approved(record)) score += 100;
  if (scheduledAt(record)) score += 20;
  if (dateIso(record && record.createdAt)) score += 5;
  return score;
}

function buildDuplicateMap(posts) {
  const duplicates = new Map();
  const groups = new Map();
  const postIds = new Set(posts.map((record) => recordId(record, '')).filter(Boolean));
  for (const record of posts) {
    const id = recordId(record, '');
    const explicit = text(record && (record.duplicateOf || record.canonicalDuplicateOf));
    if (id && explicit && id !== explicit && postIds.has(explicit)) {
      duplicates.set(id, { keeperId: explicit, reason: `Explicit duplicate of ${explicit}.` });
    }
    const identity = duplicateIdentity(record);
    if (!identity || !id) continue;
    if (!groups.has(identity)) groups.set(identity, []);
    groups.get(identity).push(record);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const ordered = [...group].sort((a, b) => {
      const score = canonicalScore(b) - canonicalScore(a);
      if (score !== 0) return score;
      const created = text(a.createdAt).localeCompare(text(b.createdAt));
      return created !== 0 ? created : recordId(a, '').localeCompare(recordId(b, ''));
    });
    const keeperId = recordId(ordered[0], '');
    for (const record of ordered.slice(1)) {
      const id = recordId(record, '');
      duplicates.set(id, {
        keeperId,
        reason: `Exact owner/workspace/provider/account/idempotency identity is also held by ${keeperId}.`
      });
    }
  }
  return duplicates;
}

function normalizeDataset(input) {
  if (Array.isArray(input)) {
    return {
      posts: input,
      postBatches: [],
      canonicalCommands: [],
      missionGraphs: [],
      evidenceRecords: [],
      coverage: {
        posts: true,
        postBatches: false,
        canonicalCommands: false,
        missionGraphs: false,
        evidenceRecords: false
      }
    };
  }
  if (!input || typeof input !== 'object') throw new TypeError('Audit input must be an array or object.');
  return {
    posts: array(input.posts),
    postBatches: array(input.postBatches || input.batches),
    canonicalCommands: array(input.canonicalCommands || input.commands),
    missionGraphs: array(input.missionGraphs || input.graphs),
    evidenceRecords: array(input.evidenceRecords || input.evidence),
    coverage: {
      posts: own(input, 'posts'),
      postBatches: own(input, 'postBatches') || own(input, 'batches'),
      canonicalCommands: own(input, 'canonicalCommands') || own(input, 'commands'),
      missionGraphs: own(input, 'missionGraphs') || own(input, 'graphs'),
      evidenceRecords: own(input, 'evidenceRecords') || own(input, 'evidence')
    }
  };
}

function ids(records, fields) {
  return new Set(records.map((record) => {
    for (const field of fields) {
      const value = text(record && record[field]);
      if (value) return value;
    }
    return '';
  }).filter(Boolean));
}

function orphanReason(record, dataset, referenceIds) {
  const linkage = canonicalLinkage(record);
  if (
    dataset.coverage.postBatches
    && linkage.batchId
    && !referenceIds.postBatches.has(linkage.batchId)
  ) return `Batch ${linkage.batchId} is referenced but absent from the supplied batch export.`;
  if (
    dataset.coverage.canonicalCommands
    && linkage.commandId
    && !referenceIds.canonicalCommands.has(linkage.commandId)
  ) return `Command ${linkage.commandId} is referenced but absent from the supplied command export.`;
  if (
    dataset.coverage.missionGraphs
    && linkage.graphId
    && !referenceIds.missionGraphs.has(linkage.graphId)
  ) return `Graph ${linkage.graphId} is referenced but absent from the supplied graph export.`;
  if (
    dataset.coverage.evidenceRecords
    && linkage.evidenceBundleId
    && !referenceIds.evidenceRecords.has(linkage.evidenceBundleId)
  ) return `Evidence bundle ${linkage.evidenceBundleId} is referenced but absent from the supplied evidence export.`;
  if (
    dataset.coverage.posts
    && linkage.duplicateOf
    && !referenceIds.posts.has(linkage.duplicateOf)
  ) return `Canonical duplicate target ${linkage.duplicateOf} is absent from the supplied post export.`;
  return '';
}

function classifyPost(record, context) {
  const status = publicationStatus(record);
  const artifactId = providerArtifactId(record);
  const linkage = canonicalLinkage(record);
  const isApproved = approved(record);
  const futureSchedule = isFutureSchedule(record, context.nowMs);
  const duplicate = context.duplicates.get(context.id);
  const orphan = orphanReason(record, context.dataset, context.referenceIds);
  const nonProduction = explicitNonProduction(record);
  const archived = isArchived(record);
  let classification;
  let reason;

  if (PUBLISHED_STATUSES.has(status) || artifactId) {
    classification = 'published';
    reason = artifactId
      ? 'Provider publication evidence exists; preserve as published history.'
      : `Recorded publication status is ${status}; preserve as published history.`;
  } else if (status === 'processing' || status === 'publishing' || status === 'outcome_unknown') {
    classification = 'active';
    reason = status === 'outcome_unknown'
      ? 'Provider outcome requires reconciliation and remains active operational work.'
      : `Execution status is ${status}.`;
  } else if (!isApproved && ['pending', 'scheduled', 'ready'].includes(status)) {
    classification = 'waiting_approval';
    reason = 'Queue work is not explicitly approved.';
  } else if (futureSchedule || status === 'scheduled') {
    classification = 'scheduled';
    reason = futureSchedule
      ? `Future execution is scheduled for ${scheduledAt(record)}.`
      : 'Recorded queue status is scheduled.';
  } else if (duplicate) {
    classification = 'duplicate';
    reason = duplicate.reason;
  } else if (orphan) {
    classification = 'orphaned';
    reason = orphan;
  } else if (nonProduction) {
    classification = 'test_demo';
    reason = 'An explicit test/demo/fixture marker identifies non-production data.';
  } else if (status === 'failed') {
    classification = 'failed';
    reason = 'Recorded queue status is failed; resolution is not assumed.';
  } else if (CANCELLED_STATUSES.has(status)) {
    classification = 'cancelled';
    reason = `Recorded lifecycle status is ${status}.`;
  } else if (ACTIVE_STATUSES.has(status)) {
    classification = 'active';
    reason = `Recorded operational status is ${status}.`;
  } else if (
    !text(record.provider || record.platform)
    || !text(record.accountId || record.tiktokOpenId)
    || !text(record.workspaceId)
  ) {
    classification = 'legacy';
    reason = 'One or more current provider/account/workspace identity fields are absent.';
  } else {
    classification = 'unknown';
    reason = status
      ? `Status ${status} has no proven cleanup mapping.`
      : 'No authoritative lifecycle status is present.';
  }

  const blockers = [];
  if (!REMOVABLE_CLASSIFICATIONS.has(classification)) blockers.push('classification_not_removable');
  if (artifactId || linkage.providerVerification) blockers.push('provider_publication_evidence');
  if (hasCanonicalEvidence(linkage, artifactId)) blockers.push('canonical_evidence_or_linkage');
  if (isApproved) blockers.push('active_approval');
  if (futureSchedule || status === 'scheduled') blockers.push('future_schedule');
  if (['processing', 'publishing', 'outcome_unknown'].includes(status)) blockers.push('active_execution');
  const ownershipExplicitlyNonProduction = nonProduction
    || record.customerOwned === false
    || record.customerOwnedProduction === false
    || record.cleanupSafeToRemove === true;
  if (!ownershipExplicitlyNonProduction) blockers.push('customer_ownership_unproven');
  const removalBlockers = [...new Set(blockers)];
  const removalEligible = REMOVABLE_CLASSIFICATIONS.has(classification) && removalBlockers.length === 0;

  let recommendedAction = 'preserve_unknown';
  if (['active', 'scheduled', 'waiting_approval'].includes(classification)) {
    recommendedAction = 'preserve_active';
  } else if (classification === 'failed') {
    recommendedAction = 'preserve_needs_attention';
  } else if (['published', 'cancelled', 'legacy'].includes(classification)) {
    recommendedAction = archived ? 'preserve_archived_history' : 'archive_history_after_approval';
  } else if (REMOVABLE_CLASSIFICATIONS.has(classification)) {
    recommendedAction = removalEligible
      ? 'remove_only_after_explicit_approval'
      : 'preserve_for_cleanup_review';
  }

  return {
    recordType: 'post',
    recordId: context.id,
    campaignJobId: text(record.campaignId || record.seriesId || record.batchId || context.id),
    provider: lower(record.provider || record.platform) || 'unknown',
    accountId: text(record.accountId || record.tiktokOpenId) || 'unknown',
    createdTime: dateIso(record.createdAt),
    scheduledTime: scheduledAt(record),
    publicationState: status || 'unknown',
    approvalState: isApproved ? 'approved' : 'unapproved',
    providerArtifactId: artifactId,
    canonicalLinkage: linkage,
    archived,
    classification,
    classificationReason: reason,
    recommendedAction,
    removalEligible,
    removalBlockers,
    duplicateKeeperId: duplicate ? duplicate.keeperId : ''
  };
}

function batchClassification(batch, childRecords, context) {
  const status = lower(batch.status);
  const artifactId = providerArtifactId(batch);
  const isApproved = approved(batch);
  const futureSchedule = isFutureSchedule(batch, context.nowMs);
  if (PUBLISHED_STATUSES.has(status) || artifactId) {
    return {
      classification: 'published',
      reason: artifactId
        ? 'Provider publication evidence exists on the batch; preserve as published history.'
        : `Recorded batch publication status is ${status}; preserve as published history.`
    };
  }
  if (['processing', 'publishing', 'outcome_unknown'].includes(status)) {
    return {
      classification: 'active',
      reason: status === 'outcome_unknown'
        ? 'Batch provider outcome requires reconciliation and remains active operational work.'
        : `Recorded batch execution status is ${status}.`
    };
  }
  if (!isApproved && ['pending', 'scheduled', 'ready'].includes(status)) {
    return {
      classification: 'waiting_approval',
      reason: 'Batch work is not explicitly approved.'
    };
  }
  if (futureSchedule || status === 'scheduled') {
    return {
      classification: 'scheduled',
      reason: futureSchedule
        ? `Future batch execution is scheduled for ${scheduledAt(batch)}.`
        : 'Recorded batch status is scheduled.'
    };
  }
  if (
    context.postsCovered
    && childRecords.length === 0
    && Number(batch.itemCount || 0) > 0
  ) {
    return {
      classification: 'orphaned',
      reason: 'Batch declares items but no child posts exist in the supplied post export.'
    };
  }
  if (childRecords.length > 0) {
    const childClasses = new Set(childRecords.map((record) => record.classification));
    for (const classification of ['active', 'scheduled', 'waiting_approval', 'failed']) {
      if (childClasses.has(classification)) {
        return { classification, reason: `At least one child post is ${classification}.` };
      }
    }
    if ([...childClasses].every((classification) => classification === 'published')) {
      return { classification: 'published', reason: 'Every supplied child post is published.' };
    }
    if ([...childClasses].every((classification) => classification === 'cancelled')) {
      return { classification: 'cancelled', reason: 'Every supplied child post is cancelled.' };
    }
    if ([...childClasses].every((classification) => classification === 'test_demo')) {
      return { classification: 'test_demo', reason: 'Every supplied child post is explicit test/demo data.' };
    }
  }
  if (CANCELLED_STATUSES.has(status)) {
    return { classification: 'cancelled', reason: `Recorded batch status is ${status}.` };
  }
  if (status === 'failed') {
    return { classification: 'failed', reason: 'Recorded batch status is failed; resolution is not assumed.' };
  }
  if (ACTIVE_STATUSES.has(status)) {
    return { classification: 'active', reason: `Recorded batch status is ${status}.` };
  }
  if (explicitNonProduction(batch)) {
    return { classification: 'test_demo', reason: 'An explicit test/demo/fixture marker identifies the batch.' };
  }
  if (!text(batch.workspaceId) || !text(batch.provider)) {
    return { classification: 'legacy', reason: 'Current batch workspace/provider identity is incomplete.' };
  }
  return { classification: 'unknown', reason: 'Batch state cannot be proven from the supplied records.' };
}

function classifyBatch(batch, index, postReports, dataset, nowMs) {
  const id = recordId(batch, `batch:${index + 1}`);
  const children = postReports.filter((record) => record.canonicalLinkage.batchId === id);
  const derived = batchClassification(batch, children, {
    nowMs,
    postsCovered: dataset.coverage.posts
  });
  const nonProduction = explicitNonProduction(batch);
  const archived = isArchived(batch);
  const linkage = canonicalLinkage(batch);
  const artifactId = providerArtifactId(batch);
  const isApproved = approved(batch);
  const futureSchedule = isFutureSchedule(batch, nowMs);
  const blockers = [];
  if (!REMOVABLE_CLASSIFICATIONS.has(derived.classification)) blockers.push('classification_not_removable');
  if (artifactId || linkage.providerVerification) blockers.push('provider_publication_evidence');
  if (hasCanonicalEvidence(linkage, artifactId)) blockers.push('canonical_evidence_or_linkage');
  if (isApproved) blockers.push('active_approval');
  if (futureSchedule || lower(batch.status) === 'scheduled') blockers.push('future_schedule');
  if (['processing', 'publishing', 'outcome_unknown'].includes(lower(batch.status))) {
    blockers.push('active_execution');
  }
  if (!dataset.coverage.posts) blockers.push('post_coverage_unavailable');
  if (children.length > 0) blockers.push('child_records_exist');
  if (!nonProduction && batch.customerOwned !== false && batch.cleanupSafeToRemove !== true) {
    blockers.push('customer_ownership_unproven');
  }
  const removalEligible = REMOVABLE_CLASSIFICATIONS.has(derived.classification) && blockers.length === 0;
  let recommendedAction = 'preserve_unknown';
  if (['active', 'scheduled', 'waiting_approval'].includes(derived.classification)) {
    recommendedAction = 'preserve_active';
  } else if (derived.classification === 'failed') {
    recommendedAction = 'preserve_needs_attention';
  } else if (['published', 'cancelled', 'legacy'].includes(derived.classification)) {
    recommendedAction = archived ? 'preserve_archived_history' : 'archive_history_after_approval';
  } else if (REMOVABLE_CLASSIFICATIONS.has(derived.classification)) {
    recommendedAction = removalEligible
      ? 'remove_only_after_explicit_approval'
      : 'preserve_for_cleanup_review';
  }
  return {
    recordType: 'postBatch',
    recordId: id,
    campaignJobId: id,
    provider: lower(batch.provider) || 'unknown',
    accountId: text(batch.accountId) || 'unknown',
    createdTime: dateIso(batch.createdAt),
    scheduledTime: dateIso(batch.baseAt),
    publicationState: lower(batch.status) || 'unknown',
    approvalState: isApproved ? 'approved' : 'unapproved',
    providerArtifactId: artifactId,
    canonicalLinkage: { ...linkage, batchId: id },
    archived,
    classification: derived.classification,
    classificationReason: derived.reason,
    recommendedAction,
    removalEligible,
    removalBlockers: blockers,
    childRecordIds: children.map((record) => record.recordId)
  };
}

function emptyCounts() {
  return Object.fromEntries(CLASSIFICATIONS.map((classification) => [classification, 0]));
}

function countClassifications(records) {
  const counts = emptyCounts();
  for (const record of records) counts[record.classification] += 1;
  return { total: records.length, ...counts };
}

function recordRef(record) {
  return {
    recordType: record.recordType,
    recordId: record.recordId,
    classification: record.classification,
    reason: record.classificationReason,
    recommendedAction: record.recommendedAction,
    archived: record.archived,
    removalEligible: record.removalEligible,
    removalBlockers: record.removalBlockers
  };
}

function auditOperationalHistory(input, options = {}) {
  const dataset = normalizeDataset(input);
  const now = dateIso(options.now || new Date());
  if (!now) throw new TypeError('Audit now must be a valid date.');
  const nowMs = Date.parse(now);
  const duplicates = buildDuplicateMap(dataset.posts);
  const referenceIds = {
    posts: ids(dataset.posts, ['id', 'recordId', 'postId']),
    postBatches: ids(dataset.postBatches, ['batchId', 'id']),
    canonicalCommands: ids(dataset.canonicalCommands, ['commandId', 'id']),
    missionGraphs: ids(dataset.missionGraphs, ['graphId', 'id']),
    evidenceRecords: ids(dataset.evidenceRecords, ['evidenceBundleId', 'id'])
  };
  const postReports = dataset.posts.map((record, index) => {
    const id = recordId(record, `post:${index + 1}`);
    return classifyPost(record, { id, nowMs, duplicates, dataset, referenceIds });
  });
  const batchReports = dataset.postBatches.map((record, index) =>
    classifyBatch(record, index, postReports, dataset, nowMs));
  const records = [...postReports, ...batchReports];
  const counts = countClassifications(records);
  const archiveCandidates = records
    .filter((record) =>
      ['published', 'cancelled', 'legacy'].includes(record.classification) && !record.archived)
    .map(recordRef);
  const removalCandidates = records
    .filter((record) => record.removalEligible)
    .map(recordRef);
  const skippedRemoval = records
    .filter((record) =>
      REMOVABLE_CLASSIFICATIONS.has(record.classification) && !record.removalEligible)
    .map(recordRef);
  const unknownRecords = records
    .filter((record) => record.classification === 'unknown')
    .map(recordRef);

  return {
    schemaVersion: 1,
    mode: 'dry_run',
    readOnly: true,
    generatedAt: now,
    source: options.source || { kind: 'in_memory' },
    coverage: dataset.coverage,
    counts,
    beforeCounts: counts,
    afterCounts: counts,
    records,
    proposals: {
      archive: archiveCandidates,
      remove: removalCandidates,
      skippedRemoval,
      unknown: unknownRecords
    },
    projections: {
      operational: records
        .filter((record) =>
          !record.archived
          && ['active', 'scheduled', 'waiting_approval', 'failed'].includes(record.classification))
        .map(recordRef),
      history: records
        .filter((record) => ['published', 'cancelled', 'legacy'].includes(record.classification))
        .map(recordRef),
      cleanupReview: records
        .filter((record) => ['test_demo', 'duplicate', 'orphaned'].includes(record.classification))
        .map(recordRef),
      preservedUnknown: unknownRecords
    },
    mutationEvidence: {
      operationId: null,
      performed: false,
      writes: 0,
      archives: 0,
      deletes: 0,
      note: 'Dry-run classification only; no mutation capability is present in this module.'
    }
  };
}

module.exports = {
  CLASSIFICATIONS,
  auditOperationalHistory,
  explicitNonProduction,
  providerArtifactId
};
