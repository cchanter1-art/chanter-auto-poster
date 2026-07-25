'use strict';

// Multi-channel scheduling: route + rendering behavior.
// Exercises the real Express routes with mocked storage, covering channel
// selection, per-channel job creation and scheduling, publish-path channel
// safety, active-channel isolation, and no-secret rendering.

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
const scheduler = require('../src/scheduler');
const { attachUser } = require('../src/auth');

// Raw account records as storage would return them. Tokens are present here
// on purpose: the routes must never render or serialize them.
const accounts = [
  {
    accountId: 'chanter-open-id', open_id: 'chanter-open-id', username: '__chanter',
    userId: 'owner', platform: 'tiktok', displayName: 'CHANTER', connected: true,
    access_token: 'secret-token-chanter', refresh_token: 'secret-refresh-chanter'
  },
  {
    accountId: 'cdwarrior-open-id', open_id: 'cdwarrior-open-id', username: '_cdwarrior',
    userId: 'owner', platform: 'tiktok', displayName: 'CD Warrior', connected: true,
    access_token: 'secret-token-cdwarrior', refresh_token: 'secret-refresh-cdwarrior'
  },
  {
    accountId: 'retired-open-id', open_id: 'retired-open-id', username: 'retired_channel',
    userId: 'owner', platform: 'tiktok', displayName: 'Retired', connected: false, access_token: '', refresh_token: ''
  }
];

// In-memory queue store: seeded per-channel jobs plus whatever /upload creates.
const queueJobs = [
  {
    id: 'job-chanter-1', accountId: 'chanter-open-id', tiktokOpenId: 'chanter-open-id',
    username: '__chanter', campaignId: 'cmp12345678', status: 'scheduled',
    originalName: 'chanter-queued.jpg', mediaType: 'photo', mediaUrl: '/assets/chanter-logo.png',
    caption: 'Chanter queued', hashtags: '#chanter', privacyLevel: 'SELF_ONLY',
    scheduledAt: new Date(Date.now() + 60_000).toISOString(),
    // Seeded as human-approved: the Publish Now assertions below exercise
    // the per-channel publish path, which only approved jobs may reach.
    approved: true, approvedAt: new Date().toISOString(), approvedBy: 'admin:owner'
  },
  {
    id: 'job-cdwarrior-1', accountId: 'cdwarrior-open-id', tiktokOpenId: 'cdwarrior-open-id',
    username: '_cdwarrior', campaignId: 'cmp12345678', status: 'scheduled',
    originalName: 'cdwarrior-queued.jpg', mediaType: 'photo', mediaUrl: '/assets/chanter-logo.png',
    caption: 'CD Warrior queued', hashtags: '#cdw', privacyLevel: 'SELF_ONLY',
    scheduledAt: new Date(Date.now() + 60_000).toISOString(),
    approved: true, approvedAt: new Date().toISOString(), approvedBy: 'admin:owner'
  }
];

const addUploadedPostsCalls = [];
const autoScheduleCalls = [];
const updatePostCalls = [];
const processPostCalls = [];

storage.getTikTokAccounts = async () => accounts;
storage.getTikTokAccount = async (userId, accountId) =>
  accounts.find((account) => account.accountId === accountId) || null;
storage.listConnectedAccountReferencesForOwner = async () => accounts.map((account) => ({
  provider: 'tiktok',
  accountId: account.accountId,
  workspaceId: ''
}));
storage.getPosts = async (userId, accountId) =>
  queueJobs.filter((job) => !accountId || job.accountId === accountId);
storage.getPost = async (userId, id, accountId) => {
  const job = queueJobs.find((item) => item.id === id) || null;
  if (!job) return null;
  if (accountId && job.accountId !== accountId) return null;
  return job;
};
storage.getDashboardJobs = async () => queueJobs;
// Hermetic YouTube truth: the dashboard payload must not pick up real
// connected channels from a live Firestore environment.
storage.getYouTubeAccounts = async () => [];
storage.getSettings = async () => ({ dailyPostTime: '18:00' });
storage.getCounts = async () => ({ total: 2, pending: 0, scheduled: 2, processing: 0, ready: 0, posted: 0, failed: 0 });
storage.addUploadedPosts = async (userId, files, defaults) => {
  addUploadedPostsCalls.push({ userId, files, defaults });
  const targets = Array.isArray(defaults.accounts) && defaults.accounts.length > 0
    ? defaults.accounts
    : [{ accountId: defaults.accountId, tiktokOpenId: defaults.tiktokOpenId, username: defaults.username }];
  const campaignId = `cmp-${addUploadedPostsCalls.length}`;
  const created = targets.map((target, index) => ({
    id: `created-${campaignId}-${target.accountId}-${index}`,
    accountId: target.accountId,
    tiktokOpenId: target.tiktokOpenId || target.accountId,
    username: target.username,
    campaignId,
    status: 'pending',
    storageFallback: false,
    autoMusicApplied: false
  }));
  queueJobs.push(...created);
  return created;
};
storage.autoSchedulePosts = async (userId, postIds, accountId) => {
  autoScheduleCalls.push({ postIds, accountId });
  for (const id of postIds) {
    const job = queueJobs.find((item) => item.id === id);
    if (job) {
      job.status = 'scheduled';
      job.scheduledAt = new Date(Date.now() + 86_400_000).toISOString();
    }
  }
  return postIds.length;
};
storage.updatePost = async (userId, id, patch, accountId) => {
  updatePostCalls.push({ id, patch, accountId });
  return { id, accountId, ...patch };
};
tiktok.getTikTokAuthStatus = async (accountId) => {
  const account = accounts.find((item) => item.accountId === accountId);
  return { connected: Boolean(account && account.connected), accountId };
};
tiktok.queryCreatorInfo = async (accountId) => ({
  creator_username: (accounts.find((item) => item.accountId === accountId) || {}).username || '',
  privacy_level_options: ['SELF_ONLY']
});
instagram.getInstagramHealth = async () => ({
  success: true, platform: 'instagram', configured: true, canPublish: false, mode: 'dry-run', missing: [], message: 'ok'
});
scheduler.processPost = async (id, options) => {
  processPostCalls.push({ id, options });
  return { ok: true, mode: 'api', postId: id };
};

const { installCommercialFixture } = require('./helpers/commercial-fixture');
installCommercialFixture(require('../src/commercialService'), storage);
const routes = require('../src/routes');

test('multi-channel scheduling end-to-end at the route layer', async (t) => {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'src', 'views'));
  app.use(express.urlencoded({ extended: true }));
  app.use(attachUser);
  app.use(routes);

  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  const loginResponse = await fetch(`${baseUrl}/admin-login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: 'test-admin-password-123', returnTo: '/private/autoposter' })
  });
  const adminCookie = String(loginResponse.headers.get('set-cookie') || '').split(';')[0];
  assert.match(adminCookie, /^chanter_admin_session=/);

  // ── Channel picker rendering ─────────────────────────────────────────────
  const pageResponse = await fetch(`${baseUrl}/private/autoposter`, { headers: { Cookie: adminCookie } });
  const pageHtml = await pageResponse.text();
  assert.equal(pageResponse.status, 200);

  // Connected channels are still IDENTIFIED here — the console owns provider
  // state. What it no longer does is offer them as post targets: destination
  // selection is a composer concern and moved there with the intake form.
  assert.match(pageHtml, /@__chanter/);
  assert.match(pageHtml, /@_cdwarrior/);
  assert.doesNotMatch(pageHtml, /Target Publishing Channels/, 'no destination picker on the dashboard');
  assert.doesNotMatch(pageHtml, /name="targetChannels"/, 'connected channels are not post targets here');
  assert.doesNotMatch(pageHtml, /Select all connected/);
  assert.doesNotMatch(pageHtml, /data-preflight-channels/, 'per-channel intake readiness left with the form');
  assert.doesNotMatch(pageHtml, /btn-create/, 'no creation submit control remains');
  // One way to create, and it is the canonical composer.
  assert.match(pageHtml, /href="\/platform\/compose"/);

  // Release Queue shows channel ownership, campaign, and job id per item.
  assert.match(pageHtml, /@__chanter/);
  assert.match(pageHtml, /Campaign cmp12345/);
  assert.match(pageHtml, /Job job-chan/);

  // No token or secret values are rendered anywhere.
  assert.doesNotMatch(pageHtml, /secret-token/);
  assert.doesNotMatch(pageHtml, /secret-refresh/);
  assert.doesNotMatch(pageHtml, /access_token/);

  // ── Scheduling: one channel ──────────────────────────────────────────────
  const singleBody = new FormData();
  singleBody.append('publicMediaUrl', 'https://cdn.example.com/asset.mp4');
  singleBody.append('caption', 'Solo release');
  singleBody.append('targetChannels', 'cdwarrior-open-id');
  const singleResponse = await fetch(`${baseUrl}/upload`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: adminCookie },
    body: singleBody
  });
  assert.equal(singleResponse.status, 302);
  assert.equal(addUploadedPostsCalls.length, 1);
  assert.deepEqual(
    addUploadedPostsCalls[0].defaults.accounts.map((a) => a.accountId),
    ['cdwarrior-open-id']
  );
  assert.equal(addUploadedPostsCalls[0].defaults.accounts[0].username, '_cdwarrior');
  assert.equal(autoScheduleCalls.length, 1);
  assert.equal(autoScheduleCalls[0].accountId, 'cdwarrior-open-id');
  assert.equal(autoScheduleCalls[0].postIds.length, 1);

  // ── Scheduling: two channels creates one child job per channel ──────────
  const dualBody = new FormData();
  dualBody.append('publicMediaUrl', 'https://cdn.example.com/asset.mp4');
  dualBody.append('caption', 'Dual release');
  dualBody.append('targetChannels', 'chanter-open-id');
  dualBody.append('targetChannels', 'cdwarrior-open-id');
  const dualResponse = await fetch(`${baseUrl}/upload`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: adminCookie },
    body: dualBody
  });
  assert.equal(dualResponse.status, 302);
  assert.match(String(dualResponse.headers.get('location')), /across\+2\+channels|across%202%20channels/);
  assert.equal(addUploadedPostsCalls.length, 2);
  assert.deepEqual(
    addUploadedPostsCalls[1].defaults.accounts.map((a) => a.accountId),
    ['chanter-open-id', 'cdwarrior-open-id']
  );
  // Each channel's queue is scheduled independently.
  assert.deepEqual(
    autoScheduleCalls.slice(1).map((call) => call.accountId),
    ['chanter-open-id', 'cdwarrior-open-id']
  );
  autoScheduleCalls.slice(1).forEach((call) => assert.equal(call.postIds.length, 1));

  // ── Preflight guards on the server: disconnected and unknown channels ───
  const disconnectedBody = new FormData();
  disconnectedBody.append('publicMediaUrl', 'https://cdn.example.com/asset.mp4');
  disconnectedBody.append('targetChannels', 'retired-open-id');
  const disconnectedResponse = await fetch(`${baseUrl}/upload`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: adminCookie },
    body: disconnectedBody
  });
  assert.equal(disconnectedResponse.status, 302);
  assert.match(String(disconnectedResponse.headers.get('location')), /reconnected/);
  assert.equal(addUploadedPostsCalls.length, 2, 'disconnected channel scheduled nothing');

  const unknownBody = new FormData();
  unknownBody.append('publicMediaUrl', 'https://cdn.example.com/asset.mp4');
  unknownBody.append('targetChannels', 'ghost-open-id');
  const unknownResponse = await fetch(`${baseUrl}/upload`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: adminCookie },
    body: unknownBody
  });
  assert.equal(unknownResponse.status, 302);
  assert.match(String(unknownResponse.headers.get('location')), /not\+found|not%20found/);
  assert.equal(addUploadedPostsCalls.length, 2, 'unknown channel scheduled nothing');

  // ── Backward compatibility: no targetChannels falls back to the active channel ──
  const legacyBody = new FormData();
  legacyBody.append('publicMediaUrl', 'https://cdn.example.com/asset.mp4');
  legacyBody.append('caption', 'Legacy flow');
  const legacyResponse = await fetch(`${baseUrl}/upload`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: adminCookie },
    body: legacyBody
  });
  assert.equal(legacyResponse.status, 302);
  assert.equal(addUploadedPostsCalls.length, 3);
  assert.deepEqual(
    addUploadedPostsCalls[2].defaults.accounts.map((a) => a.accountId),
    ['chanter-open-id'],
    'active channel is the single target when none are submitted'
  );

  // ── Publish Now uses the job's assigned channel ──────────────────────────
  // Active channel is @__chanter; its own job publishes fine.
  const publishOwn = await fetch(`${baseUrl}/posts/job-chanter-1/prepare`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: adminCookie },
    body: new URLSearchParams({ force: '1' })
  });
  assert.equal(publishOwn.status, 302);
  assert.equal(processPostCalls.length, 1);
  assert.equal(processPostCalls[0].id, 'job-chanter-1');
  // The scheduler receives only the job id: channel credentials are resolved
  // from the job document itself (see tiktok-multi-account.test.js), so the
  // active UI channel cannot leak into the publish path.
  assert.equal('accountId' in (processPostCalls[0].options || {}), false);

  // Provider-neutral admin queue management is workspace-scoped, not tied
  // to the active TikTok picker. The shared service verifies the owned job,
  // and the worker still resolves credentials from that job's account.
  const publishForeign = await fetch(`${baseUrl}/posts/job-cdwarrior-1/prepare`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: adminCookie },
    body: new URLSearchParams({ force: '1' })
  });
  assert.equal(publishForeign.status, 302);
  assert.match(decodeURIComponent(String(publishForeign.headers.get('location'))), /Posted\. Check the status/);
  assert.equal(processPostCalls.length, 2);
  assert.equal(processPostCalls[1].id, 'job-cdwarrior-1');
  assert.equal('accountId' in (processPostCalls[1].options || {}), false);

  // ── Changing the active channel does not mutate queued jobs ─────────────
  const beforeSwitch = JSON.stringify(queueJobs);
  const updateCallsBeforeSwitch = updatePostCalls.length;
  const switchResponse = await fetch(`${baseUrl}/private/autoposter/account`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: adminCookie },
    body: new URLSearchParams({ accountId: 'cdwarrior-open-id' })
  });
  assert.equal(switchResponse.status, 302);
  assert.equal(JSON.stringify(queueJobs), beforeSwitch, 'queued jobs unchanged after channel switch');
  assert.equal(updatePostCalls.length, updateCallsBeforeSwitch, 'no job writes on channel switch');

  // ── Dashboard: channel and campaign per job, no secrets ──────────────────
  const dashboardResponse = await fetch(`${baseUrl}/api/private/autoposter/dashboard`, {
    headers: { Cookie: adminCookie }
  });
  const dashboardData = await dashboardResponse.json();
  assert.equal(dashboardResponse.status, 200);
  const dashboardJob = dashboardData.jobs.find((job) => job.id === 'job-cdwarrior-1');
  assert.ok(dashboardJob);
  assert.equal(dashboardJob.accountId, 'cdwarrior-open-id');
  assert.equal(dashboardJob.username, '_cdwarrior');
  assert.equal(dashboardJob.campaignId, 'cmp12345678');
  dashboardData.accounts.forEach((account) => {
    assert.equal('access_token' in account, false);
    assert.equal('refresh_token' in account, false);
  });
  const dashboardJson = JSON.stringify(dashboardData);
  assert.doesNotMatch(dashboardJson, /secret-token/);
  assert.doesNotMatch(dashboardJson, /secret-refresh/);

  // The dashboard UI renders channel identity per job (channel badge and
  // channel filter are driven by these fields in AutoPosterDashboard.jsx).
  const fs = require('node:fs');
  const dashboardSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'pages', 'AutoPosterDashboard.jsx'),
    'utf8'
  );
  assert.match(dashboardSource, /JobAccountBadge account=\{account\}|JobAccountBadge account=\{/);
  assert.match(dashboardSource, /channelHandle/);
  assert.match(dashboardSource, /campaignId/);
});
