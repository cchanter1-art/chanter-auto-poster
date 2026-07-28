'use strict';

const express = require('express');
const {
  OperationalHistoryArchiveError
} = require('./operationalHistoryArchive');
const {
  createEmulatorFirestore,
  createFirestoreEmulatorArchiveCommandService
} = require('./operationalHistoryArchiveFirestore');

const CONTROL_PATH = '/internal/operational-history/archive';
const PREVIEW_TTL_MS = 10 * 60 * 1000;
const APPROVAL_CONFIRMATION = 'APPROVE_ARCHIVE';

function text(value) {
  return String(value === null || value === undefined ? '' : value).trim();
}

function exactInteger(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new OperationalHistoryArchiveError(
      'Archive candidate limit must be between 1 and 100.',
      { code: 'archive_batch_limit_invalid', status: 400 }
    );
  }
  return parsed;
}

function founderOwnerId(req) {
  const session = req && req.adminSession;
  if (
    !req
    || req.isAdmin !== true
    || !session
    || session.role !== 'admin'
    || !text(session.sub)
  ) return '';
  return text(session.sub);
}

function requireFounderPage(req, res, next) {
  if (founderOwnerId(req)) {
    next();
    return;
  }
  res.redirect(`/admin-login?returnTo=${encodeURIComponent(CONTROL_PATH)}`);
}

function requireFounderApi(req, res, next) {
  if (founderOwnerId(req)) {
    next();
    return;
  }
  res.status(401).json({
    ok: false,
    code: 'founder_auth_required',
    reason: 'Founder authentication is required.'
  });
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function classificationSummary(candidates) {
  const summary = {};
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const classification = text(candidate && candidate.classification) || 'unknown';
    summary[classification] = (summary[classification] || 0) + 1;
  }
  return summary;
}

function publicPreview(preview) {
  return {
    schemaVersion: preview.schemaVersion,
    mode: preview.mode,
    readOnly: preview.readOnly,
    generatedAt: preview.generatedAt,
    ownerId: preview.ownerId,
    authorityMode: preview.authorityMode,
    operationId: preview.operationId,
    candidateSetHash: preview.candidateSetHash,
    candidateCount: preview.candidateIds.length,
    candidateIds: preview.candidateIds,
    classificationSummary: classificationSummary(preview.candidates),
    candidates: preview.candidates.map((candidate) => ({
      recordType: candidate.recordType,
      recordId: candidate.recordId,
      classification: candidate.classification
    })),
    remainingCandidateIds: preview.remainingCandidateIds,
    skipped: preview.skipped.map((candidate) => ({
      recordType: candidate.recordType,
      recordId: candidate.recordId,
      classification: candidate.classification,
      blockers: candidate.blockers
    })),
    maxCandidates: preview.maxCandidates,
    beforeCounts: preview.beforeCounts,
    blockers: preview.blockers,
    executionReady: preview.executionReady,
    mutationEvidence: preview.mutationEvidence
  };
}

function publicEvidence(evidence) {
  return {
    schemaVersion: evidence.schemaVersion,
    evidenceId: evidence.operationId,
    operationId: evidence.operationId,
    state: evidence.state,
    approver: evidence.approver,
    approvedAt: evidence.approvedAt,
    executedAt: evidence.executedAt,
    ownerId: evidence.ownerId,
    authorityMode: evidence.authorityMode,
    candidateSetHash: evidence.candidateSetHash,
    candidateIds: evidence.candidateIds,
    archivedIds: evidence.archivedIds,
    skippedIds: evidence.skippedIds,
    skipped: evidence.skipped,
    failures: evidence.failures,
    beforeCounts: evidence.beforeCounts,
    afterCounts: evidence.afterCounts,
    physicalDeletes: evidence.physicalDeletes,
    recoverable: evidence.recoverable,
    replayed: evidence.replayed,
    replayMutationCount: Number(evidence.replayMutationCount || 0)
  };
}

function archiveError(res, error) {
  const known = error instanceof OperationalHistoryArchiveError;
  res.status(known ? error.status : 500).json({
    ok: false,
    code: known ? error.code : 'archive_control_failed',
    reason: known ? error.message : 'Operational archive control failed.',
    blockers: known && error.details && Array.isArray(error.details.blockers)
      ? error.details.blockers
      : undefined
  });
}

function defaultCommandFactory({ ownerId }) {
  const emulatorHost = text(process.env.FIRESTORE_EMULATOR_HOST);
  const projectId = text(process.env.GCLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID);
  const { db, safety } = createEmulatorFirestore({ emulatorHost, projectId });
  return createFirestoreEmulatorArchiveCommandService({
    db,
    ownerId,
    approvalSecret: text(process.env.AUTOPOSTER_ARCHIVE_APPROVAL_SECRET),
    emulatorHost: safety.emulatorHost,
    projectId: safety.projectId
  });
}

function previewKey(ownerId, operationId) {
  return `${ownerId}:${operationId}`;
}

function sameIds(left, right) {
  return JSON.stringify(Array.isArray(left) ? left : [])
    === JSON.stringify(Array.isArray(right) ? right : []);
}

function createOperationalHistoryArchiveRouter({
  commandFactory = defaultCommandFactory,
  now = () => new Date().toISOString(),
  previewTtlMs = PREVIEW_TTL_MS
} = {}) {
  const router = express.Router();
  const issuedPreviews = new Map();

  router.get(CONTROL_PATH, requireFounderPage, (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.render('operational-history-archive', {
      appName: 'CHANTER AutoPoster',
      ownerId: founderOwnerId(req),
      controlPath: CONTROL_PATH
    });
  });

  router.post(
    `${CONTROL_PATH}/preview`,
    requireFounderApi,
    express.json({ limit: '16kb' }),
    asyncRoute(async (req, res) => {
      res.set('Cache-Control', 'no-store');
      try {
        const ownerId = founderOwnerId(req);
        const maxCandidates = exactInteger(req.body && req.body.maxCandidates, 100);
        const command = await commandFactory({ ownerId, req });
        const preview = await command.preview({ maxCandidates });
        if (preview.executionReady) {
          issuedPreviews.set(previewKey(ownerId, preview.operationId), {
            ownerId,
            preview,
            maxCandidates,
            issuedAt: Date.parse(now()),
            approvedAt: ''
          });
        }
        res.json({ ok: true, preview: publicPreview(preview) });
      } catch (error) {
        archiveError(res, error);
      }
    })
  );

  router.post(
    `${CONTROL_PATH}/execute`,
    requireFounderApi,
    express.json({ limit: '16kb' }),
    asyncRoute(async (req, res) => {
      res.set('Cache-Control', 'no-store');
      try {
        const ownerId = founderOwnerId(req);
        const operationId = text(req.body && req.body.operationId);
        const candidateSetHash = text(req.body && req.body.candidateSetHash).toLowerCase();
        if (text(req.body && req.body.confirmation) !== APPROVAL_CONFIRMATION) {
          throw new OperationalHistoryArchiveError(
            'Explicit founder confirmation is required.',
            { code: 'founder_confirmation_required', status: 403 }
          );
        }
        const issued = issuedPreviews.get(previewKey(ownerId, operationId));
        if (!issued) {
          throw new OperationalHistoryArchiveError(
            'A valid server-issued archive preview is required.',
            { code: 'archive_preview_required', status: 409 }
          );
        }
        if (!Number.isFinite(issued.issuedAt) || Date.parse(now()) - issued.issuedAt > previewTtlMs) {
          issuedPreviews.delete(previewKey(ownerId, operationId));
          throw new OperationalHistoryArchiveError(
            'The archive preview expired. Request a new preview.',
            { code: 'archive_preview_expired', status: 409 }
          );
        }
        if (
          operationId !== issued.preview.operationId
          || candidateSetHash !== issued.preview.candidateSetHash
        ) {
          throw new OperationalHistoryArchiveError(
            'The submitted archive preview does not match the server-issued preview.',
            { code: 'archive_preview_mismatch', status: 409 }
          );
        }

        const command = await commandFactory({ ownerId, req });
        const existing = await command.getResult(operationId);
        if (!existing) {
          const fresh = await command.preview({ maxCandidates: issued.maxCandidates });
          if (
            !fresh.executionReady
            || fresh.operationId !== issued.preview.operationId
            || fresh.candidateSetHash !== issued.preview.candidateSetHash
            || !sameIds(fresh.candidateIds, issued.preview.candidateIds)
          ) {
            throw new OperationalHistoryArchiveError(
              'Archive candidates changed after preview. Review a new preview.',
              { code: 'archive_preview_changed', status: 409 }
            );
          }
        }

        issued.approvedAt ||= now();
        const approval = command.approve(issued.preview, {
          approverId: `founder:${ownerId}`,
          approvedAt: issued.approvedAt
        });
        const evidence = await command.execute({
          approval,
          maxCandidates: issued.maxCandidates
        });
        res.json({ ok: true, evidence: publicEvidence(evidence) });
      } catch (error) {
        archiveError(res, error);
      }
    })
  );

  router.get(
    `${CONTROL_PATH}/operations/:operationId`,
    requireFounderApi,
    asyncRoute(async (req, res) => {
      res.set('Cache-Control', 'no-store');
      try {
        const ownerId = founderOwnerId(req);
        const operationId = text(req.params.operationId);
        const command = await commandFactory({ ownerId, req });
        const evidence = await command.getResult(operationId);
        if (!evidence) {
          throw new OperationalHistoryArchiveError(
            'Archive operation evidence was not found.',
            { code: 'archive_operation_not_found', status: 404 }
          );
        }
        res.json({ ok: true, evidence: publicEvidence(evidence) });
      } catch (error) {
        archiveError(res, error);
      }
    })
  );

  return router;
}

module.exports = {
  APPROVAL_CONFIRMATION,
  CONTROL_PATH,
  createOperationalHistoryArchiveRouter,
  founderOwnerId,
  publicEvidence,
  publicPreview
};
