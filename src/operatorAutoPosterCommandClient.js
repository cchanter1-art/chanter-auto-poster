'use strict';

// Narrow HTTP client for the canonical AutoPoster command gateway. Submission
// and execution are deliberately separate capabilities; read models are safe
// GETs and carry no token.

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const { safeDiagnosticText } = require('./forbiddenMaterial');

class OperatorCommandClientError extends Error {
  constructor(message, {
    status = 503,
    code = 'operator_unavailable',
    retryable = true,
    details = {}
  } = {}) {
    super(message);
    this.name = 'OperatorCommandClientError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

function normalizedBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function endpoint(baseUrl, pathname, query = null) {
  let url;
  try {
    url = new URL(`${normalizedBaseUrl(baseUrl)}${pathname}`);
  } catch {
    throw new OperatorCommandClientError('Operator command gateway is not configured with a valid URL.', {
      code: 'canonical_execution_unavailable',
      retryable: false
    });
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new OperatorCommandClientError('Operator command gateway must use HTTP or HTTPS.', {
      code: 'canonical_execution_unavailable',
      retryable: false
    });
  }
  for (const [key, value] of Object.entries(query || {})) {
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function bearer(token) {
  return { authorization: `Bearer ${token}` };
}

async function responseJson(response) {
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new OperatorCommandClientError('Operator returned an oversized command response.', {
      code: 'operator_invalid_response',
      retryable: false
    });
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new OperatorCommandClientError('Operator returned a command response that was not JSON.', {
      code: 'operator_invalid_response',
      retryable: false
    });
  }
}

function failureFromResponse(response, body, operation, protectedValues = []) {
  const status = Number(response.status) || 503;
  const retryable = status >= 500 || status === 408 || status === 429;
  const reason = safeDiagnosticText(String(
    (body && (body.reason || body.message || body.error))
    || `Operator rejected ${operation} with HTTP ${status}.`
  ), { maxLength: 500, protectedValues });
  return new OperatorCommandClientError(reason, {
    status: retryable ? 503 : status,
    code: String((body && body.code) || (retryable ? 'operator_unavailable' : 'operator_rejected')),
    retryable,
    details: { operatorStatus: status }
  });
}

function requireLinkage(body, commandId, { requireGraph = true } = {}) {
  const view = body && body.command && typeof body.command === 'object'
    ? body.command
    : body;
  if (
    !view
    || typeof view !== 'object'
    || String(view.commandId || '') !== String(commandId || '')
    || (requireGraph && !String(view.graphId || '').trim())
    || (requireGraph && !String(view.graphHash || '').trim())
  ) {
    throw new OperatorCommandClientError('Operator command response was missing exact command/graph linkage.', {
      code: 'operator_invalid_response',
      retryable: false
    });
  }
  return view;
}

function createOperatorAutoPosterCommandClient(options = {}) {
  const baseUrl = normalizedBaseUrl(options.baseUrl);
  const submitToken = String(options.submitToken || '');
  const controlToken = String(options.controlToken || '');
  const timeoutMs = Math.max(500, Number(options.timeoutMs) || 10_000);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const protectedValues = [submitToken, controlToken];

  function requireWriteConfiguration() {
    if (
      !baseUrl
      || !submitToken
      || !controlToken
      || submitToken === controlToken
      || typeof fetchImpl !== 'function'
    ) {
      throw new OperatorCommandClientError(
        'Canonical execution is unavailable because the Operator command gateway is not fully configured.',
        { code: 'canonical_execution_unavailable', retryable: true }
      );
    }
  }

  async function request(pathname, {
    method = 'GET',
    token = '',
    body,
    query,
    operation = 'command request'
  } = {}) {
    if (typeof fetchImpl !== 'function') {
      throw new OperatorCommandClientError('Operator HTTP client is unavailable.', {
        code: 'canonical_execution_unavailable',
        retryable: true
      });
    }
    let response;
    try {
      response = await fetchImpl(endpoint(baseUrl, pathname, query), {
        method,
        headers: {
          accept: 'application/json',
          ...(token ? bearer(token) : {}),
          ...(body === undefined ? {} : { 'content-type': 'application/json' })
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      if (error instanceof OperatorCommandClientError) throw error;
      throw new OperatorCommandClientError(`Operator is unavailable for ${operation}.`, {
        code: 'operator_unavailable',
        retryable: true
      });
    }
    const responseBody = await responseJson(response);
    if (!response.ok) {
      throw failureFromResponse(response, responseBody, operation, protectedValues);
    }
    return responseBody;
  }

  async function submit(command) {
    requireWriteConfiguration();
    const body = await request('/api/platform/autoposter-commands', {
      method: 'POST',
      token: submitToken,
      body: command,
      operation: 'command submission'
    });
    return requireLinkage(body, command.commandId);
  }

  async function execute(commandId, graphHash) {
    requireWriteConfiguration();
    const body = await request(
      `/api/platform/autoposter-commands/${encodeURIComponent(commandId)}/execute`,
      {
        method: 'POST',
        token: controlToken,
        body: { graphHash },
        operation: 'command execution'
      }
    );
    return requireLinkage(body, commandId);
  }

  // The workspace scope travels to Operator, which applies it as a predicate
  // on its own table. The confinement therefore happens before a foreign row
  // is ever selected, rather than after it has crossed back into this process.
  async function get(commandId, { workspaceId = '' } = {}) {
    if (!baseUrl) {
      throw new OperatorCommandClientError('Operator command read model is not configured.', {
        code: 'canonical_execution_unavailable',
        retryable: true
      });
    }
    const scope = String(workspaceId || '').trim();
    const body = await request(
      `/api/platform/autoposter-commands/${encodeURIComponent(String(commandId || ''))}`,
      {
        operation: 'command read',
        ...(scope ? { query: { workspaceId: scope } } : {})
      }
    );
    return requireLinkage(body, commandId, { requireGraph: false });
  }

  async function list({ limit = 25 } = {}) {
    if (!baseUrl) return [];
    const body = await request('/api/platform/autoposter-commands', {
      query: { limit: Math.min(100, Math.max(1, Number(limit) || 25)) },
      operation: 'command-list read'
    });
    if (!body || !Array.isArray(body.commands)) {
      throw new OperatorCommandClientError('Operator command-list response did not carry a commands array.', {
        code: 'operator_invalid_response',
        retryable: false
      });
    }
    return body.commands;
  }

  return { submit, execute, get, list };
}

module.exports = {
  MAX_RESPONSE_BYTES,
  OperatorCommandClientError,
  createOperatorAutoPosterCommandClient
};
