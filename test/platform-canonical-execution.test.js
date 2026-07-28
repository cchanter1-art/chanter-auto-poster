'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createHash } = require('node:crypto');

const {
  REFERENCE_PREFIX,
  createCanonicalStagedMedia
} = require('../src/canonicalStagedMedia');
const {
  COMMAND_SCHEMA_VERSION,
  createPlatformCanonicalExecution,
  deriveCommandId
} = require('../src/platformCanonicalExecution');
const {
  OperatorCommandClientError,
  createOperatorAutoPosterCommandClient
} = require('../src/operatorAutoPosterCommandClient');
const { createBatchService } = require('../src/batchService');

const SECRET = 'canonical-media-reference-test-secret-1234567890';
const COMMAND_ID = 'platform-autoposter-0123456789abcdef0123456789abcdef01234567';

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chanter-canonical-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function sourceFile(directory, name, content, mime = 'video/mp4') {
  const filePath = path.join(directory, name);
  fs.writeFileSync(filePath, content);
  return {
    path: filePath,
    filename: name,
    originalname: name,
    mimetype: mime,
    size: fs.statSync(filePath).size
  };
}

test('staged media reference is deterministic, exact, signed, and preserves the immutable source', async (t) => {
  const directory = temporaryDirectory(t);
  const source = sourceFile(directory, 'pilot.mp4', Buffer.from('video-one'));
  const staging = createCanonicalStagedMedia({
    rootDir: path.join(directory, 'staged'),
    secret: SECRET
  });

  const first = await staging.stage(COMMAND_ID, source);
  const replay = await staging.stage(COMMAND_ID, source);
  assert.equal(replay.replayed, true);
  assert.equal(replay.reference, first.reference);
  assert.match(
    first.reference,
    /^chanter-autoposter-staged:\/\/v1\/[A-Za-z0-9_-]+\.[a-f0-9]{64}$/
  );
  assert.equal(first.reference.startsWith(REFERENCE_PREFIX), true);
  assert.equal(first.media.sha256, createHash('sha256').update('video-one').digest('hex'));

  const materialized = await staging.materialize(first.reference);
  assert.notEqual(path.resolve(materialized.file.path), path.resolve(source.path));
  assert.equal(fs.readFileSync(materialized.file.path, 'utf8'), 'video-one');
  await materialized.cleanup();
  assert.equal(fs.existsSync(materialized.file.path), false);

  // Runtime/storage may delete its disposable copy; replay still resolves the
  // same stable staged source after that cleanup.
  const recovered = await staging.materialize(first.reference);
  assert.equal(fs.readFileSync(recovered.file.path, 'utf8'), 'video-one');
  await recovered.cleanup();
});

test('same intake command with changed staged media fails with an explicit conflict', async (t) => {
  const directory = temporaryDirectory(t);
  const staging = createCanonicalStagedMedia({
    rootDir: path.join(directory, 'staged'),
    secret: SECRET
  });
  await staging.stage(COMMAND_ID, sourceFile(directory, 'first.mp4', Buffer.from('first')));
  await assert.rejects(
    staging.stage(COMMAND_ID, sourceFile(directory, 'second.mp4', Buffer.from('second'))),
    (error) => error.code === 'intake_media_conflict' && error.status === 409
  );
});

test('staging rejects missing custody roots, weak signing secrets, and mismatched media types', async (t) => {
  const directory = temporaryDirectory(t);
  const missingRoot = createCanonicalStagedMedia({ rootDir: '', secret: SECRET });
  await assert.rejects(
    missingRoot.stage(COMMAND_ID, sourceFile(directory, 'missing-root.mp4', Buffer.from('missing-root'))),
    (error) => error.code === 'canonical_execution_unavailable'
  );

  const weak = createCanonicalStagedMedia({
    rootDir: path.join(directory, 'weak'),
    secret: 'too-short'
  });
  await assert.rejects(
    weak.stage(COMMAND_ID, sourceFile(directory, 'weak.mp4', Buffer.from('weak'))),
    (error) => error.code === 'canonical_execution_unavailable'
  );

  const staging = createCanonicalStagedMedia({
    rootDir: path.join(directory, 'staged'),
    secret: SECRET
  });
  await assert.rejects(
    staging.stage(
      COMMAND_ID,
      sourceFile(directory, 'mismatch.mov', Buffer.from('mismatch'), 'video/mp4')
    ),
    /extension and video MIME type do not match/
  );
});

test('composer maps one validated request to the exact versioned command and exact-hash execute', async () => {
  const calls = [];
  const operatorClient = {
    submit: async (command) => {
      calls.push({ operation: 'submit', command });
      return {
        commandId: command.commandId,
        graphId: 'graph-1',
        graphHash: 'a'.repeat(64),
        replayed: false
      };
    },
    execute: async (commandId, graphHash) => {
      calls.push({ operation: 'execute', commandId, graphHash });
      return {
        commandId,
        graphId: 'graph-1',
        graphHash,
        lifecycleState: 'completed',
        productState: 'scheduled_unapproved',
        publicationApprovalState: 'human_required',
        createdAt: '2026-07-26T10:00:00.000Z',
        updatedAt: '2026-07-26T10:00:01.000Z',
        replayed: false
      };
    },
    get: async () => ({})
  };
  const service = createPlatformCanonicalExecution({
    config: {
      enabled: true,
      operatorBaseUrl: 'http://127.0.0.1:4010',
      submitToken: 'submit-token-1234567890',
      controlToken: 'control-token-1234567890',
      mediaReferenceSecret: SECRET,
      persistentStagingAcknowledged: true,
      timeoutMs: 1000,
      stagedMediaDir: 'unused'
    },
    validateCanonicalSubmission: async () => ({
      tenantId: 'tenant-a',
      destination: {
        provider: 'tiktok',
        accountId: 'Account-Exact',
        soundMode: 'tiktok_recommended'
      },
      schedule: {
        scheduledAt: '2026-07-27T09:00:00.000+03:00',
        timezoneName: 'Asia/Nicosia',
        timezoneOffsetMinutes: -180
      }
    }),
    operatorClient,
    stagedMedia: { stage: async () => { throw new Error('public URL must not stage'); } },
    now: () => Date.parse('2026-07-26T10:00:00.000Z')
  });

  const result = await service.acceptComposerRequest(
    { actorId: 'admin:owner' },
    {
      intakeKey: 'intake-1',
      mediaUrl: 'https://cdn.example.com/pilot.mp4',
      caption: 'Pilot',
      hashtags: '#chanter',
      youtube: { title: '', description: '' },
      requestedAt: '2026-07-26T10:00:00.000Z'
    }
  );

  const expectedId = deriveCommandId('tenant-a', 'admin:owner', 'intake-1');
  assert.equal(result.command.commandId, expectedId);
  assert.equal(result.accepted, true);
  assert.equal(result.awaitingApproval, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], {
    operation: 'execute',
    commandId: expectedId,
    graphHash: 'a'.repeat(64)
  });
  assert.deepEqual(calls[0].command, {
    schemaVersion: COMMAND_SCHEMA_VERSION,
    commandId: expectedId,
    tenantId: 'tenant-a',
    actorId: 'admin:owner',
    intakeKey: 'intake-1',
    media: {
      kind: 'public_url',
      url: 'https://cdn.example.com/pilot.mp4',
      mediaType: 'video'
    },
    destinations: [{
      provider: 'tiktok',
      accountId: 'Account-Exact',
      soundMode: 'tiktok_recommended'
    }],
    copy: {
      caption: 'Pilot',
      hashtags: '#chanter',
      youtube: { title: '', description: '' }
    },
    schedule: {
      mode: 'explicit',
      scheduledAt: '2026-07-27T09:00:00.000+03:00',
      timezoneName: 'Asia/Nicosia',
      timezoneOffsetMinutes: -180
    },
    approvalPolicy: {
      draftExecution: 'operator_control_required',
      publication: 'human_required'
    },
    requestedAt: '2026-07-26T10:00:00.000Z'
  });
  assert.equal(JSON.stringify(calls[0].command).includes('token'), false);
  assert.equal(JSON.stringify(calls[0].command).includes(SECRET), false);
});

test('canonical preflight uses exact account, media, schedule, capability, and Runtime entitlement authorities', async () => {
  const calls = [];
  const commercialContext = {
    userId: 'owner',
    workspace: { workspaceId: 'tenant-a' },
    workspaceScope: { workspaceId: 'tenant-a', allowLegacyOwnerRecords: false },
    plan: { id: 'studio' },
    entitlements: {
      connectedAccountLimit: 5,
      batchSizeLimit: 30,
      schedulingHorizonDays: 30
    }
  };
  const applicationService = {
    validateMedia: (context, input) => {
      calls.push({ operation: 'media', context, input });
      return { valid: true };
    },
    getPlanUsage: async () => {
      calls.push({ operation: 'commercial' });
      return { commercialContext, view: { available: true } };
    },
    validateConnectedAccount: async (context, input) => {
      calls.push({ operation: 'account', context, input });
      return { account: { accountId: input.accountId } };
    },
    authorizeSchedule: async (context, input) => {
      calls.push({ operation: 'authorize', context, input });
      return { workspaceId: 'tenant-a', allowed: true };
    }
  };
  const service = createBatchService({
    applicationService,
    storage: {},
    now: () => Date.parse('2026-07-26T10:00:00.000Z'),
    config: {
      batchIntake: {
        maxItems: 30,
        staggerDefaultMinutes: 30,
        staggerMinMinutes: 5,
        staggerMaxMinutes: 1440,
        safetyBufferMinutes: 10
      }
    }
  });
  const file = {
    path: 'unused.mp4',
    originalname: 'pilot.mp4',
    mimetype: 'video/mp4',
    size: 10
  };
  const result = await service.validateCanonicalSubmission(
    {
      userId: 'owner',
      actorId: 'admin:owner',
      source: 'website',
      idempotency: { key: '' }
    },
    {
      files: [file],
      destinations: [{
        provider: 'tiktok',
        accountId: 'Case-Sensitive-Account',
        soundMode: 'tiktok_recommended'
      }],
      scheduleMode: 'interval',
      startDate: '2026-07-27',
      startTime: '09:00',
      timezoneName: 'Asia/Nicosia',
      timezoneOffsetMinutes: -180
    }
  );
  assert.equal(result.tenantId, 'tenant-a');
  assert.deepEqual(result.destination, {
    provider: 'tiktok',
    accountId: 'Case-Sensitive-Account',
    soundMode: 'tiktok_recommended'
  });
  assert.equal(result.schedule.timezoneOffsetMinutes, -180);
  assert.equal(calls.find((call) => call.operation === 'account').input.accountId, 'Case-Sensitive-Account');
  assert.equal(calls.find((call) => call.operation === 'authorize').input.authorizationSource, 'runtime');
  assert.equal(calls.filter((call) => call.operation === 'commercial').length, 1);

  await assert.rejects(
    service.validateCanonicalSubmission(
      { userId: 'owner', actorId: 'admin:owner', source: 'website', idempotency: { key: '' } },
      {
        files: [file],
        destinations: [
          { provider: 'tiktok', accountId: 'one' },
          { provider: 'tiktok', accountId: 'two' }
        ],
        scheduleMode: 'interval'
      }
    ),
    (error) => error.code === 'canonical_scope_unsupported'
  );
  await assert.rejects(
    service.validateCanonicalSubmission(
      { userId: 'owner', actorId: 'admin:owner', source: 'website', idempotency: { key: '' } },
      {
        files: [file, { ...file, path: `${file.path}.second` }],
        destinations: [{ provider: 'tiktok', accountId: 'one' }],
        scheduleMode: 'interval'
      }
    ),
    (error) => error.code === 'canonical_scope_unsupported'
  );
});

test('completed Operator replay removes re-staged bytes, while uncertain execution retains them', async () => {
  const now = () => Date.parse('2026-07-26T00:00:00.000Z');
  const settings = {
    enabled: true,
    operatorBaseUrl: 'http://127.0.0.1:4010',
    submitToken: 'submit-token-1234567890',
    controlToken: 'control-token-1234567890',
    mediaReferenceSecret: SECRET,
    persistentStagingAcknowledged: true,
    stagedMediaDir: 'unused'
  };
  const validated = {
    tenantId: 'tenant-a',
    destination: { provider: 'tiktok', accountId: 'account-a', soundMode: 'keep_original' },
    schedule: {
    scheduledAt: '2026-07-27T09:00:00.000+03:00',
      timezoneName: 'Asia/Nicosia',
      timezoneOffsetMinutes: -180
    }
  };
  let stagedExists = false;
  const reference = `${REFERENCE_PREFIX}payload.${'a'.repeat(64)}`;
  const stagedMedia = {
    stage: async () => {
      stagedExists = true;
      return {
        reference,
        media: {
          fileName: 'pilot.mp4',
          mimeType: 'video/mp4',
          byteSize: 10,
          sha256: 'b'.repeat(64)
        }
      };
    },
    release: async (value) => {
      assert.equal(value, reference);
      stagedExists = false;
    }
  };
  const completed = createPlatformCanonicalExecution({
    config: settings,
    now,
    validateCanonicalSubmission: async () => validated,
    stagedMedia,
    operatorClient: {
      submit: async (command) => ({
        commandId: command.commandId,
        graphId: 'graph-completed',
        graphHash: 'c'.repeat(64)
      }),
      execute: async (commandId, graphHash) => ({
        replayed: true,
        commandId,
        graphId: 'graph-completed',
        graphHash,
        lifecycleState: 'completed',
        productState: 'draft_created',
        campaignId: 'campaign-completed',
        jobIds: ['job-completed'],
        approvalId: 'autoposter-approval:mission-completed',
        evidenceBundleId: 'autoposter-evidence:graph-completed',
        publicationApprovalState: 'human_required'
      })
    }
  });
  await completed.acceptComposerRequest(
    { actorId: 'admin:owner' },
    {
      intakeKey: 'completed-replay',
      files: [{ path: 'unused', originalname: 'pilot.mp4', mimetype: 'video/mp4', size: 10 }]
    }
  );
  assert.equal(stagedExists, false, 'completed product replay removes the re-staged source');

  let releaseCalls = 0;
  const uncertain = createPlatformCanonicalExecution({
    config: settings,
    now,
    validateCanonicalSubmission: async () => validated,
    stagedMedia: {
      stage: stagedMedia.stage,
      release: async () => { releaseCalls += 1; }
    },
    operatorClient: {
      submit: async (command) => ({
        commandId: command.commandId,
        graphId: 'graph-uncertain',
        graphHash: 'd'.repeat(64)
      }),
      execute: async () => {
        throw new OperatorCommandClientError('Runtime response was lost.', {
          status: 503,
          code: 'operator_unavailable',
          retryable: true
        });
      }
    }
  });
  await assert.rejects(
    uncertain.acceptComposerRequest(
      { actorId: 'admin:owner' },
      {
        intakeKey: 'uncertain-execution',
        files: [{ path: 'unused', originalname: 'pilot.mp4', mimetype: 'video/mp4', size: 10 }]
      }
    ),
    (error) => error.code === 'operator_unavailable'
  );
  assert.equal(releaseCalls, 0, 'uncertain execution retains staged bytes for recovery');
  assert.equal(stagedExists, true);
});

test('disabled or incomplete canonical configuration fails before product preflight', async () => {
  let preflightCalls = 0;
  const service = createPlatformCanonicalExecution({
    config: {
      enabled: true,
      operatorBaseUrl: 'http://127.0.0.1:4010',
      submitToken: '',
      controlToken: 'control-token',
      mediaReferenceSecret: SECRET,
      persistentStagingAcknowledged: true,
      stagedMediaDir: 'unused'
    },
    validateCanonicalSubmission: async () => { preflightCalls += 1; },
    operatorClient: {},
    stagedMedia: {}
  });
  await assert.rejects(
    service.acceptComposerRequest({ actorId: 'admin:owner' }, { intakeKey: 'one' }),
    (error) => error.code === 'canonical_execution_unavailable' && error.retryable === true
  );
  assert.equal(preflightCalls, 0);

  const collapsedCapabilities = createPlatformCanonicalExecution({
    config: {
      enabled: true,
      operatorBaseUrl: 'http://127.0.0.1:4010',
      submitToken: 'one-shared-capability',
      controlToken: 'one-shared-capability',
      mediaReferenceSecret: SECRET,
      persistentStagingAcknowledged: true,
      stagedMediaDir: 'unused'
    },
    validateCanonicalSubmission: async () => { preflightCalls += 1; },
    operatorClient: {},
    stagedMedia: {}
  });
  await assert.rejects(
    collapsedCapabilities.acceptComposerRequest(
      { actorId: 'admin:owner' },
      { intakeKey: 'collapsed-capabilities' }
    ),
    (error) => error.code === 'canonical_execution_unavailable'
  );
  assert.equal(preflightCalls, 0);
});

test('canonical activation refuses ephemeral staging even when every secret is configured', async () => {
  let preflightCalls = 0;
  const service = createPlatformCanonicalExecution({
    config: {
      enabled: true,
      operatorBaseUrl: 'http://127.0.0.1:4010',
      submitToken: 'submit-token-1234567890',
      controlToken: 'control-token-1234567890',
      mediaReferenceSecret: SECRET,
      persistentStagingAcknowledged: false,
      stagedMediaDir: 'unused'
    },
    validateCanonicalSubmission: async () => { preflightCalls += 1; },
    operatorClient: {},
    stagedMedia: {}
  });
  await assert.rejects(
    service.acceptComposerRequest(
      { actorId: 'admin:owner' },
      { intakeKey: 'ephemeral-refused' }
    ),
    (error) => error.code === 'canonical_execution_unavailable' && error.status === 503
  );
  assert.equal(preflightCalls, 0);
});

test('Operator client uses separate submit/control bearer tokens and exact graphHash', async () => {
  const requests = [];
  const client = createOperatorAutoPosterCommandClient({
    baseUrl: 'http://operator.test',
    submitToken: 'submit-capability',
    controlToken: 'control-capability',
    timeoutMs: 1000,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      const commandId = 'platform-autoposter-' + 'a'.repeat(40);
      return new Response(JSON.stringify({
        commandId,
        graphId: 'graph-1',
        graphHash: 'b'.repeat(64)
      }), { status: requests.length === 1 ? 201 : 200 });
    }
  });
  const command = { commandId: 'platform-autoposter-' + 'a'.repeat(40) };
  const submitted = await client.submit(command);
  await client.execute(command.commandId, submitted.graphHash);
  assert.equal(requests[0].options.headers.authorization, 'Bearer submit-capability');
  assert.equal(requests[1].options.headers.authorization, 'Bearer control-capability');
  assert.deepEqual(JSON.parse(requests[1].options.body), { graphHash: 'b'.repeat(64) });
});

test('Operator unavailability is retryable and never reaches execute', async () => {
  const client = createOperatorAutoPosterCommandClient({
    baseUrl: 'http://operator.test',
    submitToken: 'submit-capability',
    controlToken: 'control-capability',
    timeoutMs: 1000,
    fetchImpl: async () => { throw new Error('offline'); }
  });
  await assert.rejects(
    client.submit({ commandId: 'platform-autoposter-' + 'a'.repeat(40) }),
    (error) => (
      error instanceof OperatorCommandClientError
      && error.code === 'operator_unavailable'
      && error.retryable === true
    )
  );
});
