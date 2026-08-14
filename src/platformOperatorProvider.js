'use strict';

// Operator mission graphs as a second Platform work provider, proving the
// ingestion contract across a real process boundary rather than inside one
// service. Nothing in the Operator repository changes to make this work: it
// already serves GET /api/mission-graphs as an unauthenticated read model,
// while every state-changing route there sits behind its own capability-token
// middleware and is never addressed from here.
//
// Three properties keep this safe, and each is asserted in
// test/platform-work-providers.test.js:
//
//   1. GET only. The method is a constant in this file. There is no code path
//      here that can POST, so no Platform read can ever move Operator state —
//      not even if the configured base URL were hostile.
//   2. Off unless configured. No OPERATOR_BASE_URL means no provider is
//      registered at all. An unconfigured integration claims nothing; it is not
//      an outage and must not be reported as one.
//   3. Bounded. Each enabled read model gets one abort timeout, a capped result
//      count, and a response-size guard, so a hanging or oversized Operator
//      cannot hold the Platform's Work surface open.
//
// Operator is an internal module. Its work is visible on the Platform because
// the Platform tells the truth about what CHANTER runs, but it arrives with no
// link and no control, and platformWorkProviders enforces that from the
// registry independently of anything this file returns.

const platformStatus = require('./platformStatus');

const MODULE_ID = 'operator';
const READ_ONLY_METHOD = 'GET';
const MISSION_GRAPHS_PATH = '/api/mission-graphs';
const AUTOPOSTER_COMMANDS_PATH = '/api/platform/autoposter-commands';
// A read model this surface only summarises; the newest page is enough.
const MAX_GRAPHS = 25;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || '').trim().replace(/\/+$/, '');
}

// Rejects anything that is not a plain http(s) origin, so a misconfigured
// environment fails loudly at read time instead of turning into an odd request.
//
// The workspace travels as a query scope Operator applies at its own journal
// boundary, so what comes back is already confined. Filtering here instead
// would mean foreign rows had already crossed the process boundary into the
// customer-facing shell, and one missed filter anywhere downstream would
// render them.
function scopedUrl(baseUrl, pathname, workspaceId) {
  const url = new URL(`${normalizeBaseUrl(baseUrl)}${pathname}`);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Operator base URL must be an http(s) origin.');
  }
  url.searchParams.set('limit', String(MAX_GRAPHS));
  const scope = String(workspaceId || '').trim();
  if (scope) url.searchParams.set('workspaceId', scope);
  return url.toString();
}

function missionGraphsUrl(baseUrl, workspaceId) {
  return scopedUrl(baseUrl, MISSION_GRAPHS_PATH, workspaceId);
}

function autoPosterCommandsUrl(baseUrl, workspaceId) {
  return scopedUrl(baseUrl, AUTOPOSTER_COMMANDS_PATH, workspaceId);
}

// A customer-facing read of Operator without a verified workspace would be a
// read of every tenant's work. This provider therefore refuses rather than
// degrading to an unscoped read: the registry reports the module as degraded
// and names it, which is a truthful "could not read" — never someone else's
// mission objective rendered as this workspace's own.
function requireWorkspaceScope(context) {
  const workspaceId = String((context && context.workspaceId) || '').trim();
  if (!workspaceId) {
    throw new Error('Operator work requires one verified workspace; the platform resolved none.');
  }
  return workspaceId;
}

async function readMissionGraphs({ baseUrl, timeoutMs, fetchImpl, workspaceId }) {
  const response = await fetchImpl(missionGraphsUrl(baseUrl, workspaceId), {
    method: READ_ONLY_METHOD,
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) {
    throw new Error(`Operator answered ${response.status} for the mission-graph read model.`);
  }
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new Error('Operator mission-graph response exceeded the size the platform will read.');
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error('Operator returned a mission-graph response that was not JSON.');
  }
  if (!body || !Array.isArray(body.graphs)) {
    throw new Error('Operator mission-graph response did not carry a graphs array.');
  }
  return body.graphs;
}

async function readAutoPosterCommands({ baseUrl, timeoutMs, fetchImpl, workspaceId }) {
  const response = await fetchImpl(autoPosterCommandsUrl(baseUrl, workspaceId), {
    method: READ_ONLY_METHOD,
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) {
    throw new Error(`Operator answered ${response.status} for the AutoPoster command read model.`);
  }
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new Error('Operator AutoPoster command response exceeded the size the platform will read.');
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error('Operator returned an AutoPoster command response that was not JSON.');
  }
  if (!body || !Array.isArray(body.commands)) {
    throw new Error('Operator AutoPoster command response did not carry a commands array.');
  }
  return body.commands;
}

// Returns null when Operator is not configured. The caller registers nothing in
// that case, which is the difference between "CHANTER does not read Operator
// here" and "CHANTER could not reach Operator" — the shell must never show the
// first as the second.
function createOperatorWorkProvider(options = {}) {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  if (!baseUrl) return null;
  const timeoutMs = Math.max(250, Number(options.timeoutMs) || 2500);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const includeAutoPosterCommands = options.includeAutoPosterCommands === true;
  if (typeof fetchImpl !== 'function') return null;

  return {
    moduleId: MODULE_ID,
    listWork: async (context) => {
      // Authorization before fan-in: the scope is required before either read
      // is issued, so an unresolved workspace never reaches Operator at all.
      const workspaceId = requireWorkspaceScope(context);
      const [graphs, commands] = await Promise.all([
        readMissionGraphs({ baseUrl, timeoutMs, fetchImpl, workspaceId }),
        includeAutoPosterCommands
          ? readAutoPosterCommands({ baseUrl, timeoutMs, fetchImpl, workspaceId })
          : Promise.resolve([])
      ]);
      return [
        ...graphs
          .slice(0, MAX_GRAPHS)
          .map((graph) => platformStatus.projectOperatorMissionGraph(graph || {})),
        ...commands
          .slice(0, MAX_GRAPHS)
          .map((command) => platformStatus.projectOperatorAutoPosterCommand(command || {}))
      ];
    }
  };
}

module.exports = {
  MODULE_ID,
  READ_ONLY_METHOD,
  MAX_GRAPHS,
  missionGraphsUrl,
  autoPosterCommandsUrl,
  createOperatorWorkProvider
};
