'use strict';

process.env.ADMIN_PASSWORD = 'scheduled-dispatch-test-admin-password';
process.env.CRON_SECRET = 'scheduled-dispatch-test-cron-secret';
process.env.SCHEDULER_BATCH_SIZE = '1';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const express = require('express');

const scheduler = require('../src/scheduler');
const routes = require('../src/routes');
const { attachUser } = require('../src/auth');
const { runSchedulerPing } = require('../src/ping-scheduler');
const { postFromDoc } = require('../src/postsMapper');

test('canonical tick rejects missing authority and accepts the shared server secret', async (t) => {
  const originalTick = scheduler.runSchedulerTick;
  let tickCalls = 0;
  scheduler.runSchedulerTick = async () => {
    tickCalls += 1;
    return {
      ok: true,
      now: '2026-07-28T18:01:00.000Z',
      batchSize: 1,
      checked: 0,
      due: 0,
      posted: 0,
      failed: 0,
      blockedUnapproved: 0,
      errors: []
    };
  };
  t.after(() => { scheduler.runSchedulerTick = originalTick; });

  const app = express();
  app.use(attachUser);
  app.use(routes);
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const rejected = await fetch(`${baseUrl}/api/cron/tick`);
  assert.equal(rejected.status, 403);
  assert.equal(tickCalls, 0);

  const accepted = await fetch(`${baseUrl}/api/cron/tick`, {
    headers: { 'x-cron-secret': process.env.CRON_SECRET }
  });
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).batchSize, 1);
  assert.equal(tickCalls, 1);
});

test('scheduler caller sends authority only in the header and redacts failure evidence', async () => {
  const secret = 'scheduler-ping-secret-canary';
  let captured = null;
  const success = await runSchedulerPing({
    appUrl: 'https://example.invalid/',
    cronSecret: secret,
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return new Response('{"ok":true}', { status: 200 });
    }
  });

  assert.equal(success.status, 200);
  assert.equal(captured.url, 'https://example.invalid/api/cron/tick');
  assert.equal(captured.options.headers['x-cron-secret'], secret);
  assert.doesNotMatch(captured.url, /secret/i);

  await assert.rejects(
    runSchedulerPing({
      appUrl: 'https://example.invalid',
      cronSecret: secret,
      fetchImpl: async () => new Response(`failure ${secret}`, { status: 503 })
    }),
    (error) => {
      assert.match(error.message, /HTTP 503/);
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    }
  );
});

test('Render intent declares exactly one authenticated external cron caller', () => {
  const renderSource = fs.readFileSync(path.join(__dirname, '..', 'render.yaml'), 'utf8');
  const pingSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'ping-scheduler.js'), 'utf8');
  assert.equal((renderSource.match(/type:\s*cron/g) || []).length, 1);
  assert.match(renderSource, /schedule:\s*"\* \* \* \* \*"/);
  assert.match(renderSource, /startCommand:\s*npm run scheduler:ping/);
  assert.match(renderSource, /key:\s*SCHEDULER_BATCH_SIZE\s+value:\s*1/);
  assert.match(renderSource, /fromGroup:\s*chanter-scheduler-shared/);
  assert.doesNotMatch(pingSource, /\?secret=/);
});

test('dispatch evidence projection is closed, deterministic, and secret-free', () => {
  const timestamp = (value) => ({
    toDate: () => new Date(value),
    toMillis: () => Date.parse(value)
  });
  const projected = postFromDoc({
    id: 'job-1',
    data: () => ({
      status: 'processing',
      dispatchOperation: {
        version: 1,
        operationId: 'c'.repeat(64),
        attemptNumber: 1,
        provider: 'tiktok',
        state: 'dispatching',
        claimedAt: timestamp('2026-07-28T18:01:35.000Z'),
        startedAt: timestamp('2026-07-28T18:01:36.000Z'),
        completedAt: null,
        providerMutationStarted: true,
        accessToken: 'must-never-project',
        workerSecret: 'must-never-project'
      }
    })
  });

  assert.deepEqual(projected.dispatchOperation, {
    version: 1,
    operationId: 'c'.repeat(64),
    attemptNumber: 1,
    provider: 'tiktok',
    state: 'dispatching',
    claimedAt: '2026-07-28T18:01:35.000Z',
    startedAt: '2026-07-28T18:01:36.000Z',
    completedAt: null,
    providerMutationStarted: true
  });
  assert.doesNotMatch(JSON.stringify(projected.dispatchOperation), /token|secret/i);
});

test('scheduler recovery contains no physical-delete path', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'scheduler.js'), 'utf8');
  assert.doesNotMatch(source, /deletePost|storage\.delete|tx\.delete|\.delete\(/);
});
