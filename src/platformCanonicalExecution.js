'use strict';

// Composer -> typed command -> Operator gateway. This module does not create a
// batch or queue job; when enabled, Operator/Runtime are the only execution
// path. The default-off route chooses this service or the legacy service once,
// never both.

const { createHash } = require('crypto');
const config = require('./config');
const batchService = require('./batchService');
const { createCanonicalStagedMedia } = require('./canonicalStagedMedia');
const {
  createOperatorAutoPosterCommandClient
} = require('./operatorAutoPosterCommandClient');
const { containsForbiddenMaterial } = require('./forbiddenMaterial');

const COMMAND_SCHEMA_VERSION = 'chanter.platform.autoposter.create-work.v1';
const COMMAND_ID_PATTERN = /^platform-autoposter-[a-f0-9]{40}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,159}$/;
const CONTROL_CHAR_PATTERN = /[\x00-\x1f\x7f]/;
const ISO_WITH_ZONE_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

class CanonicalExecutionError extends Error {
  constructor(message, {
    status = 400,
    code = 'canonical_execution_failed',
    retryable = false,
    details = {}
  } = {}) {
    super(message);
    this.name = 'CanonicalExecutionError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

function deriveCommandId(tenantId, actorId, intakeKey) {
  const exactTenantId = String(tenantId || '');
  const exactActorId = String(actorId || '');
  const exactIntakeKey = String(intakeKey || '');
  if (
    !IDENTIFIER_PATTERN.test(exactTenantId)
    || !IDENTIFIER_PATTERN.test(exactActorId)
    || !IDENTIFIER_PATTERN.test(exactIntakeKey)
  ) {
    throw new CanonicalExecutionError(
      'Canonical tenant, actor, and intake identities must be exact non-empty values.',
      { code: 'canonical_identity_invalid' }
    );
  }
  const digest = createHash('sha256')
    .update(`${exactTenantId}\n${exactActorId}\n${exactIntakeKey}`)
    .digest('hex')
    .slice(0, 40);
  return `platform-autoposter-${digest}`;
}

function canonicalRequestedAt(value, now) {
  const raw = String(value || '').trim();
  const timestamp = raw || new Date(now()).toISOString();
  const parsed = Date.parse(timestamp);
  if (!ISO_WITH_ZONE_PATTERN.test(timestamp) || !Number.isFinite(parsed)) {
    throw new CanonicalExecutionError('requestedAt must be a valid ISO-8601 timestamp.', {
      code: 'canonical_command_invalid'
    });
  }
  return timestamp;
}

function exactCommandText(value, label, maxLength, { allowBlank = false } = {}) {
  const exact = String(value || '').trim();
  if (
    exact.length > maxLength
    || (!allowBlank && !exact)
    || CONTROL_CHAR_PATTERN.test(exact)
  ) {
    throw new CanonicalExecutionError(`${label} is invalid for the canonical command.`, {
      code: 'canonical_command_invalid'
    });
  }
  return exact;
}

function safeCommandView(linkage) {
  return {
    commandId: String(linkage.commandId || ''),
    lifecycleState: String(linkage.lifecycleState || ''),
    productState: String(linkage.productState || ''),
    publicationApprovalState: String(linkage.publicationApprovalState || 'human_required'),
    createdAt: String(linkage.createdAt || linkage.requestedAt || ''),
    updatedAt: String(linkage.updatedAt || linkage.createdAt || linkage.requestedAt || '')
  };
}

function hasDurableProductResult(linkage) {
  return Boolean(
    linkage
    && linkage.lifecycleState === 'completed'
    && linkage.productState === 'draft_created'
    && String(linkage.campaignId || '').trim()
    && Array.isArray(linkage.jobIds)
    && linkage.jobIds.length === 1
    && String(linkage.jobIds[0] || '').trim()
    && String(linkage.approvalId || '').trim()
    && String(linkage.evidenceBundleId || '').trim()
  );
}

function createPlatformCanonicalExecution(dependencies = {}) {
  const settings = dependencies.config || config.canonicalExecution;
  const preflight = dependencies.validateCanonicalSubmission
    || batchService.validateCanonicalSubmission;
  const now = dependencies.now || (() => Date.now());
  const stagedMedia = dependencies.stagedMedia || createCanonicalStagedMedia({
    rootDir: settings.stagedMediaDir,
    secret: settings.mediaReferenceSecret
  });
  const operatorClient = dependencies.operatorClient || createOperatorAutoPosterCommandClient({
    baseUrl: settings.operatorBaseUrl,
    submitToken: settings.submitToken,
    controlToken: settings.controlToken,
    timeoutMs: settings.timeoutMs,
    fetchImpl: dependencies.fetchImpl
  });

  function requireConfiguration() {
    if (
      !settings.enabled
      || !String(settings.operatorBaseUrl || '')
      || !String(settings.submitToken || '')
      || !String(settings.controlToken || '')
      || String(settings.submitToken) === String(settings.controlToken)
      || String(settings.mediaReferenceSecret || '').length < 32
      || settings.persistentStagingAcknowledged !== true
    ) {
      throw new CanonicalExecutionError(
        'Canonical execution is enabled but its Operator capabilities or media-reference signer are unavailable.',
        { status: 503, code: 'canonical_execution_unavailable', retryable: true }
      );
    }
  }

  async function acceptComposerRequest(context, input = {}) {
    requireConfiguration();
    const intakeKey = String(input.intakeKey || '');
    if (!intakeKey || intakeKey !== intakeKey.trim()) {
      throw new CanonicalExecutionError('A stable canonical intakeKey is required.', {
        code: 'canonical_identity_invalid'
      });
    }

    const validated = await preflight(context, input);
    const tenantId = String(validated.tenantId || '');
    const actorId = String(context.actorId || '');
    const commandId = deriveCommandId(tenantId, actorId, intakeKey);
    const requestedAt = canonicalRequestedAt(input.requestedAt, now);
    const copy = {
      caption: exactCommandText(input.caption, 'caption', 2_200, { allowBlank: true }),
      hashtags: exactCommandText(input.hashtags, 'hashtags', 1_000, { allowBlank: true }),
      youtube: {
        title: exactCommandText(
          input.youtube && input.youtube.title,
          'YouTube title',
          100,
          { allowBlank: validated.destination.provider !== 'youtube' }
        ),
        description: exactCommandText(
          input.youtube && input.youtube.description,
          'YouTube description',
          5_000,
          { allowBlank: true }
        )
      }
    };
    exactCommandText(validated.destination.accountId, 'destination accountId', 256);
    if (
      !ISO_WITH_ZONE_PATTERN.test(String(validated.schedule.scheduledAt || ''))
      || Date.parse(validated.schedule.scheduledAt) <= Date.parse(requestedAt)
      || containsForbiddenMaterial(copy, {
        protectedValues: [
          settings.submitToken,
          settings.controlToken,
          settings.mediaReferenceSecret
        ]
      })
    ) {
      throw new CanonicalExecutionError('Canonical command content or schedule is invalid.', {
        code: 'canonical_command_invalid'
      });
    }

    let media;
    const publicUrl = String(input.mediaUrl || input.publicMediaUrl || '').trim();
    if (publicUrl) {
      media = { kind: 'public_url', url: publicUrl, mediaType: 'video' };
    } else {
      const files = Array.isArray(input.files) ? input.files.filter(Boolean) : [];
      const staged = await stagedMedia.stage(commandId, files[0]);
      media = {
        kind: 'autoposter_staged_upload',
        reference: staged.reference,
        fileName: staged.media.fileName,
        mimeType: staged.media.mimeType,
        byteSize: staged.media.byteSize,
        sha256: staged.media.sha256
      };
    }

    const command = {
      schemaVersion: COMMAND_SCHEMA_VERSION,
      commandId,
      tenantId,
      actorId,
      intakeKey,
      media,
      destinations: [{
        provider: validated.destination.provider,
        accountId: validated.destination.accountId,
        soundMode: validated.destination.soundMode
      }],
      copy,
      schedule: {
        mode: 'explicit',
        scheduledAt: validated.schedule.scheduledAt,
        timezoneName: validated.schedule.timezoneName,
        timezoneOffsetMinutes: validated.schedule.timezoneOffsetMinutes
      },
      approvalPolicy: {
        draftExecution: 'operator_control_required',
        publication: 'human_required'
      },
      requestedAt
    };

    const submitted = await operatorClient.submit(command);
    const executed = await operatorClient.execute(commandId, submitted.graphHash);
    // Runtime releases staging after a successful durable product write. This
    // second idempotent cleanup covers a later same-intake composer replay:
    // staging was recreated, but Operator correctly reused the completed graph
    // and therefore did not invoke Runtime again.
    if (
      media.kind === 'autoposter_staged_upload'
      && hasDurableProductResult(executed)
      && typeof stagedMedia.release === 'function'
    ) {
      await stagedMedia.release(media.reference).catch(() => {});
    }
    return {
      accepted: true,
      awaitingApproval: true,
      replayed: Boolean(executed.replayed),
      command: safeCommandView(executed),
      linkage: executed
    };
  }

  async function getCommand(commandId) {
    const exact = String(commandId || '');
    if (!COMMAND_ID_PATTERN.test(exact)) {
      throw new CanonicalExecutionError('Canonical command was not found.', {
        status: 404,
        code: 'not_found'
      });
    }
    return operatorClient.get(exact);
  }

  return { acceptComposerRequest, getCommand };
}

const defaultService = createPlatformCanonicalExecution();

module.exports = {
  COMMAND_SCHEMA_VERSION,
  COMMAND_ID_PATTERN,
  CanonicalExecutionError,
  deriveCommandId,
  safeCommandView,
  hasDurableProductResult,
  createPlatformCanonicalExecution,
  acceptComposerRequest: (...args) => defaultService.acceptComposerRequest(...args),
  getCommand: (...args) => defaultService.getCommand(...args)
};
