'use strict';

const config = require('./config');
const { safeDiagnosticText } = require('./forbiddenMaterial');

async function runSchedulerPing({
  appUrl = config.appUrl,
  cronSecret = config.cronSecret,
  fetchImpl = fetch
} = {}) {
  if (!appUrl) {
    throw new Error('APP_URL must point to the deployed Render web service');
  }
  if (!cronSecret) {
    throw new Error('CRON_SECRET must be configured on both Render services');
  }

  const response = await fetchImpl(`${String(appUrl).replace(/\/+$/, '')}/api/cron/tick`, {
    headers: {
      accept: 'application/json',
      'x-cron-secret': cronSecret
    },
    signal: AbortSignal.timeout(15 * 60 * 1000)
  });
  const body = await response.text();

  if (!response.ok) {
    const safeBody = safeDiagnosticText(body.slice(0, 1000), {
      protectedValues: [cronSecret]
    });
    throw new Error(`Scheduler tick returned HTTP ${response.status}: ${safeBody}`);
  }

  return { status: response.status, body };
}

async function main() {
  const result = await runSchedulerPing();
  console.log('[scheduler-ping]', result.body);
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[scheduler-ping] failed:', error.message || error);
    process.exitCode = 1;
  });
}

module.exports = { runSchedulerPing };
