'use strict';

// Queue Control P0 — delete truthfulness at the route layer.
//
// The confirmed production bug: /posts/:id/delete redirected with
// "?notice=Deleted." while the post was still in Firestore, because the
// route ignored storage.deletePost's boolean result AND scoped the delete
// to the active channel even though the All Channels queue view (and the
// Publishing Log) render delete buttons for every channel's posts.
//
// These tests lock in: unscoped-but-owned deletes work from any channel
// view, false success notices are impossible, failures keep the post, and
// the Mark / Delete Marked bulk endpoint reports per-post truth.

process.env.ADMIN_PASSWORD = 'test-admin-password-123';
process.env.OPENAI_API_KEY = 'test-openai-key';
process.env.ENABLE_INSTAGRAM = 'false';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const express = require('express');

const storage = require('../src/storage');
const tiktok = require('../src/tiktok');
const instagram = require('../src/instagram');
const { attachUser } = require('../src/auth');

const accounts = [
  { accountId: 'account-a', open_id: 'account-a', username: 'account_a', connected: true },
  { accountId: 'account-b', open_id: 'account-b', username: 'account_b', connected: true }
];

// One two-channel campaign so the Release Queue defaults to All Channels —
// exactly the view where cross-channel deletes silently failed before.
const queueJobs = [
  {
    id: 'job-a-1', accountId: 'account-a', tiktokOpenId: 'account-a', username: 'account_a',
    campaignId: 'cmp-delete-1', status: 'scheduled', originalName: 'job-a-video.mp4', mediaType: 'video',
    mediaUrl: '/assets/chanter-logo.png', caption: 'Job A', hashtags: '#a', privacyLevel: 'SELF_ONLY',
    scheduledAt: new Date(Date.now() + 60_000).toISOString(), createdAt: '2026-07-09T00:00:00.000Z'
  },
  {
    id: 'job-b-1', accountId: 'account-b', tiktokOpenId: 'account-b', username: 'account_b',
    campaignId: 'cmp-delete-1', status: 'scheduled', originalName: 'job-b-video.mp4', mediaType: 'video',
    mediaUrl: '/assets/chanter-logo.png', caption: 'Job B', hashtags: '#b', privacyLevel: 'SELF_ONLY',
    scheduledAt: new Date(Date.now() + 120_000).toISOString(), createdAt: '2026-07-09T00:00:00.000Z'
  }
];

const deleteCalls = [];
// id -> behavior for the deletePost mock: true / false / 'throw'
const deleteBehavior = new Map([
  ['job-a-1', true],
  ['job-b-1', true]
]);

storage.getTikTokAccounts = async () => accounts;
storage.getTikTokAccount = async (userId, accountId) =>
  accounts.find((account) => account.accountId === accountId) || null;
storage.getPosts = async (userId, accountId) =>
  queueJobs.filter((job) => !accountId || job.accountId === accountId);
storage.getDashboardJobs = async () => queueJobs;
storage.getSettings = async () => ({ dailyPostTime: '09:00' });
storage.getCounts = async () => ({ total: 2, pending: 0, scheduled: 2, processing: 0, ready: 0, posted: 0, failed: 0 });
storage.deletePost = async (...args) => {
  const [, id] = args;
  deleteCalls.push(args);
  const behavior = deleteBehavior.has(id) ? deleteBehavior.get(id) : false;
  if (behavior === 'throw') throw new Error('Firestore unavailable');
  return behavior;
};
tiktok.getTikTokAuthStatus = async (accountId) => ({ connected: Boolean(accountId), accountId });
tiktok.queryCreatorInfo = async (accountId) => ({
  creator_username: (accounts.find((item) => item.accountId === accountId) || {}).username || '',
  privacy_level_options: ['SELF_ONLY']
});
instagram.getInstagramHealth = async () => ({
  success: true, platform: 'instagram', configured: true, canPublish: false, mode: 'dry-run', missing: [], message: 'ok'
});

const { installCommercialFixture } = require('./helpers/commercial-fixture');
installCommercialFixture(require('../src/commercialService'), storage);
const routes = require('../src/routes');

test('queue delete is truthful and works across channels; bulk delete reports per-post truth', async (t) => {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'src', 'views'));
  app.use(express.urlencoded({ extended: true }));
  app.use(attachUser);
  app.use(routes);
  // Mirror server.js's error middleware so a thrown deletePost surfaces the
  // same truthful notice production shows.
  app.use((error, req, res, next) => {
    if (!error) { next(); return; }
    const wantsJson =
      String(req.path || '').startsWith('/api/') ||
      String(req.headers.accept || '').toLowerCase().includes('application/json');
    if (wantsJson) {
      res.status(error.status || 500).json({ ok: false, reason: error.message || 'Unexpected server error' });
      return;
    }
    res.redirect(`/private/autoposter/legacy?notice=${encodeURIComponent(error.message || 'Unexpected server error')}`);
  });

  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  // ── Unauthorized: no admin session may delete anything ──────────────────
  const unauthedDelete = await fetch(`${baseUrl}/posts/job-a-1/delete`, { method: 'POST', redirect: 'manual' });
  assert.equal(unauthedDelete.status, 302);
  assert.match(unauthedDelete.headers.get('location'), /^\/admin-login/);
  const unauthedBulk = await fetch(`${baseUrl}/api/posts/delete-marked`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ ids: ['job-a-1'] })
  });
  assert.equal(unauthedBulk.status, 401);
  assert.equal(deleteCalls.length, 0, 'no delete reached storage without a session');

  const loginResponse = await fetch(`${baseUrl}/admin-login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: 'test-admin-password-123', returnTo: '/private/autoposter/legacy' })
  });
  const adminCookie = String(loginResponse.headers.get('set-cookie') || '').split(';')[0];
  assert.match(adminCookie, /^chanter_admin_session=/);

  // ── All Channels view renders both channels' cards with delete + mark UI ──
  const pageResponse = await fetch(`${baseUrl}/private/autoposter/legacy`, { headers: { Cookie: adminCookie } });
  const pageHtml = await pageResponse.text();
  assert.equal(pageResponse.status, 200);
  assert.match(pageHtml, /job-a-video\.mp4/);
  assert.match(pageHtml, /job-b-video\.mp4/, 'the non-active channel\'s job renders in All Channels view');
  assert.match(pageHtml, /action="\/posts\/job-b-1\/delete"/, 'the non-active channel\'s job has a delete form');
  assert.match(pageHtml, /data-delete-form/);
  assert.match(pageHtml, /data-post-id="job-b-1"/);
  assert.match(pageHtml, /data-mark-toolbar/);
  assert.match(pageHtml, /data-mark-toggle/);
  assert.match(pageHtml, /data-delete-marked/);
  assert.match(pageHtml, /data-clear-marks/);
  assert.match(pageHtml, /\/api\/posts\/delete-marked/);

  // ── Cross-channel delete: active channel is account-a, deleting
  // account-b's job must reach storage WITHOUT a channel scope ────────────
  const crossChannelDelete = await fetch(`${baseUrl}/posts/job-b-1/delete`, {
    method: 'POST', redirect: 'manual', headers: { Cookie: adminCookie }
  });
  assert.equal(crossChannelDelete.status, 302);
  assert.match(crossChannelDelete.headers.get('location'), /notice=Deleted\./);
  assert.equal(deleteCalls.length, 1);
  assert.equal(deleteCalls[0][1], 'job-b-1');
  assert.equal(deleteCalls[0][2], undefined, 'admin delete is not scoped to the active channel');

  // ── Missing post: no false "Deleted." notice ─────────────────────────────
  const missingDelete = await fetch(`${baseUrl}/posts/job-missing/delete`, {
    method: 'POST', redirect: 'manual', headers: { Cookie: adminCookie }
  });
  assert.equal(missingDelete.status, 302);
  const missingLocation = decodeURIComponent(missingDelete.headers.get('location'));
  assert.match(missingLocation, /Delete failed/);
  assert.doesNotMatch(missingLocation, /notice=Deleted\./);

  // ── Failed deletion: the error surfaces, never a success notice ─────────
  deleteBehavior.set('job-a-1', 'throw');
  const failedDelete = await fetch(`${baseUrl}/posts/job-a-1/delete`, {
    method: 'POST', redirect: 'manual', headers: { Cookie: adminCookie }
  });
  assert.equal(failedDelete.status, 302);
  const failedLocation = decodeURIComponent(failedDelete.headers.get('location'));
  assert.match(failedLocation, /Firestore unavailable/);
  assert.doesNotMatch(failedLocation, /notice=Deleted\./);
  deleteBehavior.set('job-a-1', true);

  // The card is still visible after a failed delete (storage unchanged).
  const afterFailureHtml = await (await fetch(`${baseUrl}/private/autoposter/legacy`, { headers: { Cookie: adminCookie } })).text();
  assert.match(afterFailureHtml, /job-a-video\.mp4/);

  // ── Bulk delete: empty selection is rejected ─────────────────────────────
  const emptyBulk = await fetch(`${baseUrl}/api/posts/delete-marked`, {
    method: 'POST',
    headers: { Cookie: adminCookie, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ ids: [] })
  });
  assert.equal(emptyBulk.status, 400);
  assert.equal((await emptyBulk.json()).ok, false);

  // ── Bulk delete: partial success reports per-post truth ─────────────────
  deleteBehavior.set('job-err', 'throw');
  const callsBeforeBulk = deleteCalls.length;
  const bulkResponse = await fetch(`${baseUrl}/api/posts/delete-marked`, {
    method: 'POST',
    headers: { Cookie: adminCookie, 'Content-Type': 'application/json', Accept: 'application/json' },
    // job-a-1 is sent twice: the endpoint must de-duplicate.
    body: JSON.stringify({ ids: ['job-a-1', 'job-a-1', 'job-missing', 'job-err'] })
  });
  assert.equal(bulkResponse.status, 200);
  const bulkPayload = await bulkResponse.json();
  assert.equal(bulkPayload.ok, false, 'partial success is not reported as full success');
  assert.deepEqual(bulkPayload.deleted, ['job-a-1']);
  assert.deepEqual(bulkPayload.failed.map((item) => item.id), ['job-missing', 'job-err']);
  assert.match(bulkPayload.failed[0].reason, /not found/i);
  assert.match(bulkPayload.failed[1].reason, /Firestore unavailable/);
  assert.equal(deleteCalls.length - callsBeforeBulk, 3, 'duplicate ids were de-duplicated');
  deleteCalls.slice(callsBeforeBulk).forEach((call) => {
    assert.equal(call[2], undefined, 'bulk delete is not scoped to the active channel');
  });

  // ── Bulk delete: full success ────────────────────────────────────────────
  const fullBulk = await fetch(`${baseUrl}/api/posts/delete-marked`, {
    method: 'POST',
    headers: { Cookie: adminCookie, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ ids: ['job-a-1', 'job-b-1'] })
  });
  const fullPayload = await fullBulk.json();
  assert.equal(fullBulk.status, 200);
  assert.equal(fullPayload.ok, true);
  assert.deepEqual(fullPayload.deleted, ['job-a-1', 'job-b-1']);
  assert.deepEqual(fullPayload.failed, []);

  // ── Bulk delete: oversized selections are refused outright ──────────────
  const oversizedBulk = await fetch(`${baseUrl}/api/posts/delete-marked`, {
    method: 'POST',
    headers: { Cookie: adminCookie, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ ids: Array.from({ length: 201 }, (_, index) => `job-${index}`) })
  });
  assert.equal(oversizedBulk.status, 400);
});
