'use strict';

// A1 — Platform/Operator workspace isolation, proven over the real router.
//
// The defect this closes: the shell called workRegistry.collect(websiteContext(req))
// with a workspace taken straight from a request header, and the Operator
// provider ignored the context entirely and read EVERY tenant's mission graphs
// and canonical commands. Two things were wrong at once — nothing verified the
// workspace, and nothing scoped the read — so one customer's surface could
// render another's objectives.
//
// The invariant is an ORDERING one: authorization and workspace resolution
// happen before provider fan-in. That is why the "unknown workspace" case here
// asserts on what the fake Operator was NEVER asked, not merely on the status
// code: a refusal that still fanned out would leak the same data through a
// degraded projection.
//
// The fake Operator below behaves like the real one after this change — it
// applies `workspaceId` as a predicate — so a regression that stops sending the
// scope shows up as workspace A seeing workspace B's rows, exactly as it would
// in production.

process.env.ADMIN_PASSWORD = 'workspace-isolation-admin-password';
process.env.OPENAI_API_KEY = 'test-openai-key';
process.env.ENABLE_INSTAGRAM = 'false';
process.env.YOUTUBE_ENABLED = 'false';
process.env.PLATFORM_CANONICAL_EXECUTION_ENABLED = 'true';
process.env.PLATFORM_CANONICAL_STAGING_PERSISTENT = 'true';
process.env.PLATFORM_CANONICAL_MEDIA_REFERENCE_SECRET =
  'workspace-isolation-media-reference-secret-1234567890';
process.env.OPERATOR_BASE_URL = 'http://127.0.0.1:4020';
process.env.OPERATOR_MISSION_SUBMIT_TOKEN = 'workspace-isolation-submit-token';
process.env.OPERATOR_CONTROL_TOKEN = 'workspace-isolation-control-token';

const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');

const auth = require('../src/auth');
auth.requireAdminPage = (req, res, next) => next();
auth.requireAdminApi = (req, res, next) => next();
auth.resolveUserId = () => 'owner';

const firestoreModule = require('../src/firestore');
firestoreModule.validateFirebaseConfig = () => {
  throw new Error('firebase is deliberately unconfigured for this test');
};
firestoreModule.getFirestore = () => {
  throw new Error('this test must not reach storage');
};

const WORKSPACE_A = 'workspace-isolation-aaaa';
const WORKSPACE_B = 'workspace-isolation-bbbb';
const COMMAND_A = `platform-autoposter-${'a'.repeat(40)}`;
const COMMAND_B = `platform-autoposter-${'b'.repeat(40)}`;
const UNKNOWN_COMMAND = `platform-autoposter-${'f'.repeat(40)}`;

// Durable Operator truth, tagged with its owning workspace.
const GRAPHS = [
  {
    graphId: 'graph-a-0001',
    objective: 'WORKSPACE_A_SECRET_OBJECTIVE',
    status: 'approval_required',
    tenant: { workspaceId: WORKSPACE_A },
    nodeCount: 1,
    createdAt: '2026-08-01T09:00:00.000Z',
    updatedAt: '2026-08-01T09:00:00.000Z'
  },
  {
    graphId: 'graph-b-0001',
    objective: 'WORKSPACE_B_SECRET_OBJECTIVE',
    status: 'running',
    tenant: { workspaceId: WORKSPACE_B },
    nodeCount: 1,
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-01T10:00:00.000Z'
  }
];

// Deliberately NOT linked to the graphs above. A command and a graph that
// share a graph id are collapsed into one row by the registry, and the merged
// row is titled from the command — which would silently drop the objective and
// make the "A never renders B's objective" assertion vacuous.
const COMMANDS = [
  {
    commandId: COMMAND_A,
    tenantId: WORKSPACE_A,
    graphId: 'graph-a-command',
    graphHash: 'a'.repeat(64),
    lifecycleState: 'approval_required',
    productState: 'not_started',
    publicationApprovalState: 'human_required',
    jobIds: [],
    createdAt: '2026-08-01T09:00:00.000Z',
    updatedAt: '2026-08-01T09:00:00.000Z'
  },
  {
    commandId: COMMAND_B,
    tenantId: WORKSPACE_B,
    graphId: 'graph-b-command',
    graphHash: 'b'.repeat(64),
    lifecycleState: 'completed',
    productState: 'draft_created',
    publicationApprovalState: 'human_required',
    jobIds: ['job-b-0001'],
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-01T10:00:00.000Z'
  }
];

const operatorRequests = [];

// Stands in for Operator AFTER this change: `workspaceId` is a predicate, and
// a foreign id is answered exactly as an unknown one.
function fakeOperatorFetch(url) {
  operatorRequests.push(String(url));
  const parsed = new URL(String(url));
  const scope = parsed.searchParams.get('workspaceId') || '';
  const json = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body)
  });

  const commandMatch = parsed.pathname.match(
    /^\/api\/platform\/autoposter-commands\/(.+)$/
  );
  if (commandMatch) {
    const commandId = decodeURIComponent(commandMatch[1]);
    const found = COMMANDS.find(
      (command) => command.commandId === commandId && (!scope || command.tenantId === scope)
    );
    if (!found) {
      return json(404, {
        code: 'PLATFORM_COMMAND_NOT_FOUND',
        message: 'Platform AutoPoster command was not found.'
      });
    }
    return json(200, found);
  }

  if (parsed.pathname === '/api/platform/autoposter-commands') {
    return json(200, {
      commands: COMMANDS.filter((command) => !scope || command.tenantId === scope)
    });
  }

  if (parsed.pathname === '/api/mission-graphs') {
    return json(200, {
      graphs: GRAPHS.filter((graph) => !scope || graph.tenant.workspaceId === scope)
    });
  }

  return json(404, { message: 'unexpected path' });
}

// The verified workspace this request resolves to. `null` models a workspace
// the membership check refuses — an unknown or foreign one.
let resolvedWorkspaceId = WORKSPACE_A;

const applicationService = require('../src/autoposterApplicationService');
applicationService.getPlanUsage = async () => {
  if (!resolvedWorkspaceId) {
    const error = new Error('Workspace not found.');
    error.status = 404;
    error.code = 'workspace_not_found';
    throw error;
  }
  return {
    commercialContext: {
      userId: 'owner',
      workspace: { workspaceId: resolvedWorkspaceId, status: 'active' },
      workspaceScope: { workspaceId: resolvedWorkspaceId, allowLegacyOwnerRecords: true }
    },
    view: {}
  };
};

const batchService = require('../src/batchService');
batchService.listDestinations = async () => ({ destinations: [] });
batchService.listBatches = async () => ({ batches: [] });
batchService.listSeries = async () => ({ series: [] });

// The router registers its providers at require time, so the injected fetch is
// installed before the require — the same mechanism the sibling provider tests
// use. Nothing about the shell surfaces is touched to make this work.
const operatorModule = require('../src/platformOperatorProvider');
const originalCreate = operatorModule.createOperatorWorkProvider;
operatorModule.createOperatorWorkProvider = (options) =>
  originalCreate({ ...options, fetchImpl: fakeOperatorFetch });
const platformRoutes = require('../src/platformRoutes');
operatorModule.createOperatorWorkProvider = originalCreate;

// The command detail page reads through the client, which builds its own
// fetch at module load, so it is pointed at the same fake Operator.
const {
  createOperatorAutoPosterCommandClient
} = require('../src/operatorAutoPosterCommandClient');
const canonicalExecution = require('../src/platformCanonicalExecution');
const config = require('../src/config');
const scopedExecution = canonicalExecution.createPlatformCanonicalExecution({
  operatorClient: createOperatorAutoPosterCommandClient({
    baseUrl: config.canonicalExecution.operatorBaseUrl,
    submitToken: config.canonicalExecution.submitToken,
    controlToken: config.canonicalExecution.controlToken,
    fetchImpl: fakeOperatorFetch
  })
});
canonicalExecution.getCommand = (...args) => scopedExecution.getCommand(...args);

async function startServer() {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', require('node:path').join(__dirname, '..', 'src', 'views'));
  app.use('/', platformRoutes);
  app.use((error, req, res, next) => {
    if (!error) { next(); return; }
    res.status(error.status || 500).json({ ok: false, code: error.code || '', reason: error.message });
  });
  return new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
}

test('workspace A never renders workspace B graph objectives or commands', async (t) => {
  resolvedWorkspaceId = WORKSPACE_A;
  operatorRequests.length = 0;
  const server = await startServer();
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const work = await (await fetch(`${baseUrl}/api/platform/work`)).json();
  assert.equal(work.ok, true);

  const serialized = JSON.stringify(work);
  assert.ok(serialized.includes('WORKSPACE_A_SECRET_OBJECTIVE'), 'A must see its own work');
  assert.equal(
    serialized.includes('WORKSPACE_B_SECRET_OBJECTIVE'),
    false,
    'A rendered B objective'
  );
  assert.equal(serialized.includes(COMMAND_B), false, 'A rendered B command');
  assert.equal(serialized.includes('graph-b-0001'), false, 'A rendered B graph');

  // Every Operator read carried the verified scope; none went out unscoped.
  assert.ok(operatorRequests.length > 0, 'Operator was read at all');
  for (const url of operatorRequests) {
    assert.ok(
      new URL(url).searchParams.get('workspaceId') === WORKSPACE_A,
      `an Operator read escaped the verified workspace: ${url}`
    );
  }

  // And the same shell renders B's work — and only B's — for B.
  resolvedWorkspaceId = WORKSPACE_B;
  const bWork = await (await fetch(`${baseUrl}/api/platform/work`)).json();
  const bSerialized = JSON.stringify(bWork);
  assert.ok(bSerialized.includes('WORKSPACE_B_SECRET_OBJECTIVE'));
  assert.equal(bSerialized.includes('WORKSPACE_A_SECRET_OBJECTIVE'), false);
});

test('a foreign commandId is the same safe not-found as an unknown one', async (t) => {
  resolvedWorkspaceId = WORKSPACE_A;
  const server = await startServer();
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const mine = await (await fetch(`${baseUrl}/platform/autoposter/compose/commands/${COMMAND_A}`)).text();
  assert.ok(mine.includes(COMMAND_A), 'A must be able to open its own command');

  const foreignResponse = await fetch(`${baseUrl}/platform/autoposter/compose/commands/${COMMAND_B}`);
  const unknownResponse = await fetch(`${baseUrl}/platform/autoposter/compose/commands/${UNKNOWN_COMMAND}`);
  const foreign = await foreignResponse.text();
  const unknown = await unknownResponse.text();

  assert.equal(foreignResponse.status, unknownResponse.status);
  // The rendered page differs only by the id the caller typed. Any other
  // difference — a distinct message, a lifecycle hint, a workspace name —
  // would confirm the foreign command exists.
  assert.equal(foreign.replace(COMMAND_B, 'ID'), unknown.replace(UNKNOWN_COMMAND, 'ID'));
  assert.equal(foreign.includes(WORKSPACE_B), false, 'foreign workspace leaked into the page');
  assert.equal(foreign.includes('graph-b-0001'), false, 'foreign graph leaked into the page');
  assert.equal(foreign.includes('draft_created'), false, 'foreign product state leaked into the page');
});

test('an unresolvable workspace fails before any provider is contacted', async (t) => {
  resolvedWorkspaceId = null;
  operatorRequests.length = 0;
  const server = await startServer();
  t.after(() => {
    resolvedWorkspaceId = WORKSPACE_A;
    return new Promise((resolve) => server.close(resolve));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const response = await fetch(`${baseUrl}/api/platform/work`);
  assert.equal(response.status, 404, 'an unknown workspace must be refused, not degraded');
  const body = await response.json();
  assert.equal(body.ok, false);

  // The point of the ordering. A refusal that had already fanned out would
  // have leaked exactly the data the refusal is meant to withhold.
  assert.deepEqual(
    operatorRequests,
    [],
    'a provider was contacted before the workspace was verified'
  );
});
