'use strict';

process.env.ADMIN_PASSWORD = 'test-admin-password-123';
process.env.ADMIN_SESSION_SECRET = 'test-admin-session-secret-123';
process.env.ENABLE_INSTAGRAM = 'false';

const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');

const applicationService = require('../src/autoposterApplicationService');
const platformRoutes = require('../src/platformRoutes');
const {
  ADMIN_SESSION_COOKIE,
  attachUser,
  createAdminSessionToken,
  csrfOriginCheck
} = require('../src/auth');

test('cancellation API requires admin + same-origin CSRF and returns a bounded receipt', async (t) => {
  const original = applicationService.cancelApprovedPost;
  const calls = [];
  applicationService.cancelApprovedPost = async (context, input) => {
    calls.push({ context, input });
    return {
      ok: true,
      outcome: 'cancelled',
      post: {
        id: input.postId,
        batchId: input.batchId,
        status: 'cancelled',
        approved: false,
        scheduledAt: '2026-07-29T14:30:00.000Z',
        privacyLevel: 'SELF_ONLY',
        cancelledAt: '2026-07-29T14:50:00.000Z',
        cancellationReason: 'approved_overdue_item_cancelled_before_provider_dispatch',
        claimAttempts: 0,
        history: [{ event: 'cancelled' }],
        caption: 'must not appear in operational receipt',
        mediaUrl: 'https://private.example/media.mp4'
      }
    };
  };
  t.after(() => {
    applicationService.cancelApprovedPost = original;
  });

  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(attachUser);
  app.use(csrfOriginCheck);
  app.use(platformRoutes);
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const route = `${baseUrl}/api/platform/batches/batch-exact/items/job-exact/cancel-approved`;
  const body = JSON.stringify({
    expectedScheduledAt: '2026-07-29T14:30:00.000Z',
    expectedApprovedAt: '2026-07-29T14:24:46.497Z',
    expectedPrivacyLevel: 'SELF_ONLY'
  });
  const contentHeaders = {
    Origin: baseUrl,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'x-chanter-workspace-id': 'workspace-recovery'
  };

  const unauthorized = await fetch(route, { method: 'POST', headers: contentHeaders, body });
  assert.equal(unauthorized.status, 401);
  assert.equal(calls.length, 0);

  const cookie = `${ADMIN_SESSION_COOKIE}=${createAdminSessionToken()}`;
  const missingCsrf = await fetch(route, {
    method: 'POST',
    headers: { ...contentHeaders, Origin: undefined, Cookie: cookie },
    body
  });
  assert.equal(missingCsrf.status, 403);
  assert.equal(calls.length, 0);

  const wrongOrigin = await fetch(route, {
    method: 'POST',
    headers: { ...contentHeaders, Origin: 'https://evil.example', Cookie: cookie },
    body
  });
  assert.equal(wrongOrigin.status, 403);
  assert.equal(calls.length, 0);

  const response = await fetch(route, {
    method: 'POST',
    headers: { ...contentHeaders, Cookie: cookie },
    body
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const payload = await response.json();
  assert.deepEqual(payload, {
    ok: true,
    outcome: 'cancelled',
    item: {
      postId: 'job-exact',
      batchId: 'batch-exact',
      status: 'cancelled',
      approved: false,
      scheduledAt: '2026-07-29T14:30:00.000Z',
      privacyLevel: 'SELF_ONLY',
      cancelledAt: '2026-07-29T14:50:00.000Z',
      cancellationReason: 'approved_overdue_item_cancelled_before_provider_dispatch',
      claimAttempts: 0,
      providerDispatchEvidencePresent: false
    }
  });
  assert.equal(JSON.stringify(payload).includes('must not appear'), false);
  assert.equal(JSON.stringify(payload).includes('private.example'), false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].context.userId, 'owner');
  assert.equal(calls[0].context.source, 'website');
  assert.equal(calls[0].input.postId, 'job-exact');
  assert.equal(calls[0].input.batchId, 'batch-exact');
});
