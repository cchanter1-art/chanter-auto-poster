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
//   3. Bounded. One request, one abort timeout, a capped result count, and a
//      response-size guard, so a hanging or oversized Operator cannot hold the
//      Platform's Work surface open.
//
// Operator is an internal module. Its work is visible on the Platform because
// the Platform tells the truth about what CHANTER runs, but it arrives with no
// link and no control, and platformWorkProviders enforces that from the
// registry independently of anything this file returns.

const platformStatus = require('./platformStatus');

const MODULE_ID = 'operator';
const READ_ONLY_METHOD = 'GET';
const MISSION_GRAPHS_PATH = '/api/mission-graphs';
// A read model this surface only summarises; the newest page is enough.
const MAX_GRAPHS = 25;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || '').trim().replace(/\/+$/, '');
}

// Rejects anything that is not a plain http(s) origin, so a misconfigured
// environment fails loudly at read time instead of turning into an odd request.
function missionGraphsUrl(baseUrl) {
  const url = new URL(`${normalizeBaseUrl(baseUrl)}${MISSION_GRAPHS_PATH}`);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Operator base URL must be an http(s) origin.');
  }
  url.searchParams.set('limit', String(MAX_GRAPHS));
  return url.toString();
}

async function readMissionGraphs({ baseUrl, timeoutMs, fetchImpl }) {
  const response = await fetchImpl(missionGraphsUrl(baseUrl), {
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

// Returns null when Operator is not configured. The caller registers nothing in
// that case, which is the difference between "CHANTER does not read Operator
// here" and "CHANTER could not reach Operator" — the shell must never show the
// first as the second.
function createOperatorWorkProvider(options = {}) {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  if (!baseUrl) return null;
  const timeoutMs = Math.max(250, Number(options.timeoutMs) || 2500);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') return null;

  return {
    moduleId: MODULE_ID,
    listWork: async () => {
      const graphs = await readMissionGraphs({ baseUrl, timeoutMs, fetchImpl });
      return graphs
        .slice(0, MAX_GRAPHS)
        .map((graph) => platformStatus.projectOperatorMissionGraph(graph || {}));
    }
  };
}

module.exports = {
  MODULE_ID,
  READ_ONLY_METHOD,
  MAX_GRAPHS,
  missionGraphsUrl,
  createOperatorWorkProvider
};
