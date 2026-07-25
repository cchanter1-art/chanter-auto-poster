'use strict';

// Max Scheduler + Release Queue visibility: route + rendering behavior.
// Exercises the real Express routes with mocked storage, covering explicit
// start date/time + per-channel offset scheduling, the All Channels /
// Active Channel view toggle, parent campaign summaries, preflight guards,
// and channel-switch isolation — all with real token-shaped strings present
// in the mocked account data so any leak would be caught.

process.env.ADMIN_PASSWORD = 'test-admin-password-123';
process.env.OPENAI_API_KEY = 'test-openai-key';
process.env.ENABLE_INSTAGRAM = 'false';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const express = require('express');

const storage = require('../src/storage');
const tiktok = require('../src/tiktok');
const instagram = require('../src/instagram');
const { attachUser } = require('../src/auth');

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

// A pre-existing two-channel campaign so the default view, the campaign
// summary strip, and the All Channels / Active Channel toggle all have
// real data to render against.
const queueJobs = [
  {
    id: 'job-chanter-1', accountId: 'chanter-open-id', tiktokOpenId: 'chanter-open-id', username: '__chanter',
    campaignId: 'cmpAAAAAAAA', status: 'scheduled', originalName: 'chanter-queued.jpg', mediaType: 'photo',
    mediaUrl: '/assets/chanter-logo.png', caption: 'Chanter queued', hashtags: '#chanter', privacyLevel: 'SELF_ONLY',
    scheduledAt: '2026-07-07T09:00:00.000Z', createdAt: '2026-07-06T00:00:00.000Z',
    channelOrder: 0, channelOffsetMinutes: 0
  },
  {
    id: 'job-cdwarrior-1', accountId: 'cdwarrior-open-id', tiktokOpenId: 'cdwarrior-open-id', username: '_cdwarrior',
    campaignId: 'cmpAAAAAAAA', status: 'scheduled', originalName: 'cdwarrior-queued.jpg', mediaType: 'photo',
    mediaUrl: '/assets/chanter-logo.png', caption: 'CD Warrior queued', hashtags: '#cdw', privacyLevel: 'SELF_ONLY',
    scheduledAt: '2026-07-07T09:05:00.000Z', createdAt: '2026-07-06T00:00:00.000Z',
    channelOrder: 1, channelOffsetMinutes: 5
  }
];

const addUploadedPostsCalls = [];
const applyExplicitScheduleCalls = [];
const autoScheduleCalls = [];
const updatePostCalls = [];
let failNextScheduleConfirmation = false;

storage.getTikTokAccounts = async () => accounts;
storage.getTikTokAccount = async (userId, accountId) =>
  accounts.find((account) => account.accountId === accountId) || null;
storage.getPosts = async (userId, accountId) =>
  queueJobs.filter((job) => !accountId || job.accountId === accountId);
storage.getPost = async (userId, id, accountId) => {
  if (failNextScheduleConfirmation) {
    failNextScheduleConfirmation = false;
    throw new Error('simulated confirmation read failure');
  }
  const job = queueJobs.find((item) => item.id === id) || null;
  return job && (!accountId || job.accountId === accountId) ? job : null;
};
storage.getDashboardJobs = async () => queueJobs;
// Hermetic YouTube truth: the dashboard payload must not pick up real
// connected channels from a live Firestore environment.
storage.getYouTubeAccounts = async () => [];
storage.getSettings = async () => ({ dailyPostTime: '18:00' });
storage.getCounts = async (userId, accountId) => {
  const jobs = queueJobs.filter((job) => !accountId || job.accountId === accountId);
  return jobs.reduce(
    (counts, job) => { counts.total += 1; counts[job.status] = (counts[job.status] || 0) + 1; return counts; },
    { total: 0, pending: 0, scheduled: 0, processing: 0, ready: 0, posted: 0, failed: 0 }
  );
};
storage.addUploadedPosts = async (userId, files, defaults) => {
  addUploadedPostsCalls.push({ userId, files, defaults });
  const targets = Array.isArray(defaults.accounts) && defaults.accounts.length > 0
    ? defaults.accounts
    : [{ accountId: defaults.accountId, tiktokOpenId: defaults.tiktokOpenId, username: defaults.username }];
  const campaignId = `cmp-new-${addUploadedPostsCalls.length}`;
  const scheduleEntries = Array.isArray(defaults.scheduleEntries) && defaults.scheduleEntries.length > 0
    ? defaults.scheduleEntries
    : targets.map((target) => ({ accountId: target.accountId, scheduledAt: defaults.scheduledAt || null }));
  const created = scheduleEntries.map((entry, index) => {
    const target = targets.find((candidate) => candidate.accountId === entry.accountId);
    return {
      id: `created-${addUploadedPostsCalls.length}-${index}`,
      accountId: target.accountId,
      tiktokOpenId: target.tiktokOpenId || target.accountId,
      username: target.username,
      campaignId,
      seriesId: defaults.scheduleSeries ? campaignId : '',
      seriesFrequency: defaults.scheduleSeries ? defaults.scheduleSeries.frequency : '',
      seriesOccurrenceIndex: Number.isInteger(entry.occurrenceIndex) ? entry.occurrenceIndex : null,
      seriesOccurrenceCount: defaults.scheduleSeries ? defaults.scheduleSeries.occurrenceCount : 0,
      status: entry.scheduledAt ? 'scheduled' : 'pending',
      scheduledAt: entry.scheduledAt || null,
      approvedAt: defaults.selfApprove ? new Date().toISOString() : null,
      approvedBy: defaults.selfApprove ? defaults.selfApprove.approvedBy : null,
      storageFallback: false,
      autoMusicApplied: false,
      createdAt: new Date().toISOString()
    };
  });
  queueJobs.push(...created);
  return created;
};
storage.applyExplicitSchedule = async (userId, posts, plan) => {
  applyExplicitScheduleCalls.push({ posts, plan });
  const planByAccount = new Map(plan.channels.map((channel) => [channel.accountId, channel]));
  let count = 0;
  posts.forEach((post) => {
    const planChannel = planByAccount.get(post.accountId);
    if (!planChannel) return;
    const job = queueJobs.find((item) => item.id === post.id);
    if (job) {
      job.scheduledAt = planChannel.scheduledAt;
      job.status = 'scheduled';
      job.channelOffsetMinutes = planChannel.offsetMinutes;
      job.channelOrder = planChannel.order;
      job.campaignStartAt = plan.baseAt;
    }
    count += 1;
  });
  return count;
};
storage.autoSchedulePosts = async (userId, postIds, accountId) => {
  autoScheduleCalls.push({ postIds, accountId });
  postIds.forEach((id) => {
    const job = queueJobs.find((item) => item.id === id);
    if (job) {
      job.status = 'scheduled';
      job.scheduledAt = new Date(Date.now() + 86_400_000).toISOString();
    }
  });
  return postIds.length;
};
storage.updatePost = async (userId, id, patch) => {
  updatePostCalls.push({ id, patch });
  const job = queueJobs.find((item) => item.id === id);
  if (job) Object.assign(job, patch);
  return job;
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

const { installCommercialFixture } = require('./helpers/commercial-fixture');
installCommercialFixture(require('../src/commercialService'), storage);
const routes = require('../src/routes');

test('Max Scheduler campaign creation and Release Queue visibility', async (t) => {
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
  // Defensive isolation: restore the env vars this file sets on top of
  // whatever the runner provided, even though node --test already gives
  // every test file its own process/module cache.
  const envSnapshot = {
    ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    ENABLE_INSTAGRAM: process.env.ENABLE_INSTAGRAM
  };
  t.after(() => { Object.assign(process.env, envSnapshot); });
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

  // ── Default view: the seeded campaign spans 2 channels, so the queue
  // defaults to All Channels and shows a parent campaign summary ─────────
  const defaultResponse = await fetch(`${baseUrl}/private/autoposter`, { headers: { Cookie: adminCookie } });
  const defaultHtml = await defaultResponse.text();
  assert.equal(defaultResponse.status, 200);
  assert.match(defaultHtml, /@__chanter/);
  assert.match(defaultHtml, /@_cdwarrior/);
  assert.match(defaultHtml, /Campaign cmpAAAAA/);
  assert.match(defaultHtml, /class="btn btn-primary" href="\?queueView=all"/);
  assert.doesNotMatch(defaultHtml, /Showing jobs for active channel only/);
  // The console is a DASHBOARD: it observes work, it does not create it. The
  // intake fields that used to live here moved to the canonical composer, so
  // their absence is the contract now — asserted by name so a reintroduced
  // second composer fails loudly rather than quietly reappearing.
  for (const field of ['startDate', 'startTime', 'offsetMinutes', 'repeatMode', 'approveSeries', 'endDate']) {
    assert.doesNotMatch(defaultHtml, new RegExp(`name="${field}"`), `${field} must not be composed from the dashboard`);
  }
  assert.doesNotMatch(defaultHtml, /class="upload-form"/, 'no intake form remains');
  assert.doesNotMatch(defaultHtml, /action="\/upload"/, 'no creation submit control remains');
  assert.doesNotMatch(defaultHtml, /data-media-upload/, 'no upload input remains');
  assert.doesNotMatch(defaultHtml, /Approve the full daily series now/);
  // …and there is exactly one way to reach the composer from here.
  assert.match(defaultHtml, /href="\/platform\/compose"/);
  assert.equal((defaultHtml.match(/data-compose-link/g) || []).length, 1, 'one Compose action');

  // ── Active Channel mode: only the active channel's job, plus the
  // required explanatory copy ─────────────────────────────────────────────
  const activeResponse = await fetch(`${baseUrl}/private/autoposter?queueView=active`, { headers: { Cookie: adminCookie } });
  const activeHtml = await activeResponse.text();
  assert.equal(activeResponse.status, 200);
  // The channel picker always lists every account regardless of queue
  // view, so the channel-scoping check has to look at queue-card-only
  // content (the job's original filename), not the bare @handle.
  assert.match(activeHtml, /chanter-queued\.jpg/);
  assert.doesNotMatch(activeHtml, /cdwarrior-queued\.jpg/);
  assert.match(activeHtml, /Showing jobs for active channel only\. Switch to All Channels to view all campaign jobs\./);
  assert.match(activeHtml, /class="btn btn-primary" href="\?queueView=active"/);

  // ── All Channels mode explicitly requested ──────────────────────────────
  const allResponse = await fetch(`${baseUrl}/private/autoposter?queueView=all`, { headers: { Cookie: adminCookie } });
  const allHtml = await allResponse.text();
  assert.equal(allResponse.status, 200);
  assert.match(allHtml, /chanter-queued\.jpg/);
  assert.match(allHtml, /cdwarrior-queued\.jpg/);
  assert.match(allHtml, /2 channels/);
  assert.match(allHtml, /2 jobs/);

  // No token or secret values are rendered in any view mode.
  for (const html of [defaultHtml, activeHtml, allHtml]) {
    assert.doesNotMatch(html, /secret-token/);
    assert.doesNotMatch(html, /secret-refresh/);
    assert.doesNotMatch(html, /access_token/);
  }

  // ── Max Scheduler: two channels, explicit start date/time, default offset ──
  const dualBody = new FormData();
  dualBody.append('publicMediaUrl', 'https://cdn.example.com/asset.mp4');
  dualBody.append('caption', 'Max Scheduler drop');
  dualBody.append('targetChannels', 'chanter-open-id');
  dualBody.append('targetChannels', 'cdwarrior-open-id');
  dualBody.append('startDate', '2026-07-07');
  dualBody.append('startTime', '09:00');
  dualBody.append('timezoneOffsetMinutes', '0');
  const dualResponse = await fetch(`${baseUrl}/upload`, {
    method: 'POST', redirect: 'manual', headers: { Cookie: adminCookie }, body: dualBody
  });
  assert.equal(dualResponse.status, 302);
  // /upload is now a DEPRECATED compatibility adapter: it still works exactly
  // as before — same service path, same entitlements, same approval gate — and
  // it says so to machine callers, naming the surface that replaced it. It is
  // never a redirect: a redirected POST would silently discard the body.
  assert.equal(dualResponse.headers.get('deprecation'), 'true', 'the adapter announces its deprecation');
  assert.match(dualResponse.headers.get('link') || '', /<\/platform\/compose>;\s*rel="successor-version"/);
  assert.notEqual(dualResponse.headers.get('location'), '/platform/compose', 'a POST is adapted, never redirected');
  assert.equal(applyExplicitScheduleCalls.length, 1, 'Max Scheduler path was used instead of autoSchedulePosts');
  assert.equal(autoScheduleCalls.length, 0);
  const firstPlan = applyExplicitScheduleCalls[0].plan;
  assert.equal(firstPlan.baseAt, '2026-07-07T09:00:00.000Z');
  assert.equal(firstPlan.channels[0].accountId, 'chanter-open-id');
  assert.equal(firstPlan.channels[0].scheduledAt, '2026-07-07T09:00:00.000Z');
  assert.equal(firstPlan.channels[1].accountId, 'cdwarrior-open-id');
  assert.equal(firstPlan.channels[1].scheduledAt, '2026-07-07T09:05:00.000Z');
  const createdChanterJob = queueJobs.find((job) => job.id.startsWith('created-1-') && job.accountId === 'chanter-open-id');
  const createdCdwarriorJob = queueJobs.find((job) => job.id.startsWith('created-1-') && job.accountId === 'cdwarrior-open-id');
  assert.equal(createdChanterJob.scheduledAt, '2026-07-07T09:00:00.000Z');
  assert.equal(createdCdwarriorJob.scheduledAt, '2026-07-07T09:05:00.000Z');
  assert.equal(createdCdwarriorJob.channelOffsetMinutes, 5);

  // ── Custom offset (+10 minutes) ─────────────────────────────────────────
  const customOffsetBody = new FormData();
  customOffsetBody.append('publicMediaUrl', 'https://cdn.example.com/asset.mp4');
  customOffsetBody.append('caption', 'Custom offset drop');
  customOffsetBody.append('targetChannels', 'chanter-open-id');
  customOffsetBody.append('targetChannels', 'cdwarrior-open-id');
  customOffsetBody.append('startDate', '2026-07-08');
  customOffsetBody.append('startTime', '10:00');
  customOffsetBody.append('offsetMinutes', '10');
  customOffsetBody.append('timezoneOffsetMinutes', '0');
  const customOffsetResponse = await fetch(`${baseUrl}/upload`, {
    method: 'POST', redirect: 'manual', headers: { Cookie: adminCookie }, body: customOffsetBody
  });
  assert.equal(customOffsetResponse.status, 302);
  const secondPlan = applyExplicitScheduleCalls[1].plan;
  assert.equal(secondPlan.channels[1].scheduledAt, '2026-07-08T10:10:00.000Z');

  // ── Daily recurring schedule: inclusive date range × selected channels ──
  const recurringCallsBefore = addUploadedPostsCalls.length;
  const explicitCallsBeforeRecurring = applyExplicitScheduleCalls.length;
  const autoCallsBeforeRecurring = autoScheduleCalls.length;
  const recurringBody = new FormData();
  recurringBody.append('publicMediaUrl', 'https://cdn.example.com/daily.mp4');
  recurringBody.append('caption', 'Daily same-time campaign');
  recurringBody.append('targetChannels', 'chanter-open-id');
  recurringBody.append('targetChannels', 'cdwarrior-open-id');
  recurringBody.append('repeatMode', 'daily');
  recurringBody.append('startDate', '2099-07-11');
  recurringBody.append('endDate', '2099-07-13');
  recurringBody.append('startTime', '09:00');
  recurringBody.append('offsetMinutes', '5');
  recurringBody.append('timezoneOffsetMinutes', '0');
  recurringBody.append('approveSeries', '1');
  const recurringResponse = await fetch(`${baseUrl}/upload`, {
    method: 'POST', redirect: 'manual', headers: { Cookie: adminCookie }, body: recurringBody
  });
  assert.equal(recurringResponse.status, 302);
  assert.equal(addUploadedPostsCalls.length, recurringCallsBefore + 1);
  assert.equal(applyExplicitScheduleCalls.length, explicitCallsBeforeRecurring, 'recurring jobs are scheduled atomically at creation');
  assert.equal(autoScheduleCalls.length, autoCallsBeforeRecurring, 'recurring jobs do not enter legacy auto-scheduling');
  const recurringDefaults = addUploadedPostsCalls.at(-1).defaults;
  assert.equal(recurringDefaults.scheduleEntries.length, 6);
  assert.deepEqual(recurringDefaults.selfApprove, { approvedBy: 'admin:owner' });
  assert.deepEqual(recurringDefaults.scheduleSeries, {
    frequency: 'daily', startDate: '2099-07-11', endDate: '2099-07-13', occurrenceCount: 3, sourceCount: 1, timezone: ''
  });
  assert.deepEqual(recurringDefaults.scheduleEntries.map((entry) => entry.scheduledAt), [
    '2099-07-11T09:00:00.000Z',
    '2099-07-11T09:05:00.000Z',
    '2099-07-12T09:00:00.000Z',
    '2099-07-12T09:05:00.000Z',
    '2099-07-13T09:00:00.000Z',
    '2099-07-13T09:05:00.000Z'
  ]);
  const recurringJobs = queueJobs.filter((job) => job.id.startsWith(`created-${addUploadedPostsCalls.length}-`));
  assert.equal(recurringJobs.length, 6);
  assert.equal(recurringJobs.every((job) => job.status === 'scheduled'), true);
  assert.equal(recurringJobs.every((job) => Boolean(job.approvedAt)), true);
  assert.equal(recurringJobs.every((job) => job.approvedBy === 'admin:owner'), true);
  assert.equal(new Set(recurringJobs.map((job) => job.seriesId)).size, 1);

  // ── Preflight: Max Scheduler blocks a disconnected channel server-side ──
  const disconnectedBody = new FormData();
  disconnectedBody.append('publicMediaUrl', 'https://cdn.example.com/asset.mp4');
  disconnectedBody.append('targetChannels', 'retired-open-id');
  const beforeDisconnected = addUploadedPostsCalls.length;
  const disconnectedResponse = await fetch(`${baseUrl}/upload`, {
    method: 'POST', redirect: 'manual', headers: { Cookie: adminCookie }, body: disconnectedBody
  });
  assert.equal(disconnectedResponse.status, 302);
  assert.match(String(disconnectedResponse.headers.get('location')), /reconnected/);
  assert.equal(addUploadedPostsCalls.length, beforeDisconnected, 'the pre-existing connected-channel guard already blocks this before Max Scheduler runs');

  // ── Single-channel campaign at an explicit start date/time ──────────────
  const soloBody = new FormData();
  soloBody.append('publicMediaUrl', 'https://cdn.example.com/asset.mp4');
  soloBody.append('caption', 'Solo Max Scheduler drop');
  soloBody.append('startDate', '2026-07-09');
  soloBody.append('startTime', '08:00');
  soloBody.append('timezoneOffsetMinutes', '0');
  const soloResponse = await fetch(`${baseUrl}/upload`, {
    method: 'POST', redirect: 'manual', headers: { Cookie: adminCookie }, body: soloBody
  });
  assert.equal(soloResponse.status, 302);
  const soloPlan = applyExplicitScheduleCalls[applyExplicitScheduleCalls.length - 1].plan;
  assert.equal(soloPlan.channels.length, 1);
  assert.equal(soloPlan.channels[0].scheduledAt, '2026-07-09T08:00:00.000Z');

  // ── Changing the active channel does not mutate a Max Scheduler job's
  // scheduledAt/offset ─────────────────────────────────────────────────────
  const beforeSwitch = JSON.stringify(queueJobs);
  const updateCallsBeforeSwitch = updatePostCalls.length;
  const switchResponse = await fetch(`${baseUrl}/private/autoposter/account`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: adminCookie },
    body: new URLSearchParams({ accountId: 'cdwarrior-open-id' })
  });
  assert.equal(switchResponse.status, 302);
  assert.equal(JSON.stringify(queueJobs), beforeSwitch, 'switching the active channel must not change any queued job');
  assert.equal(updatePostCalls.length, updateCallsBeforeSwitch);

  // ── Dashboard: All Channels / per-channel filter is present and carries
  // no secrets, alongside the campaign/channel fields it's built from ──────
  const dashboardResponse = await fetch(`${baseUrl}/api/private/autoposter/dashboard`, { headers: { Cookie: adminCookie } });
  const dashboardData = await dashboardResponse.json();
  assert.equal(dashboardResponse.status, 200);
  assert.ok(dashboardData.accounts.some((account) => account.username === '__chanter'));
  assert.ok(dashboardData.accounts.some((account) => account.username === '_cdwarrior'));
  dashboardData.accounts.forEach((account) => {
    assert.equal('access_token' in account, false);
    assert.equal('refresh_token' in account, false);
  });
  assert.doesNotMatch(JSON.stringify(dashboardData), /secret-token|secret-refresh/);

  const dashboardSource = require('node:fs').readFileSync(
    path.join(__dirname, '..', 'src', 'pages', 'AutoPosterDashboard.jsx'),
    'utf8'
  );
  assert.match(dashboardSource, /option value="all">All channels<\/option>/);
  assert.match(dashboardSource, /accountFilter/);
  assert.match(dashboardSource, /summarizeDashboardCampaigns/);

  // ── Fast Schedule intake: an XHR submit (Accept: application/json) gets
  // inline JSON instead of a redirect, so the page can keep form state ────
  const inlineBody = new FormData();
  inlineBody.append('publicMediaUrl', 'https://cdn.example.com/asset.mp4');
  inlineBody.append('caption', 'Inline JSON drop');
  inlineBody.append('targetChannels', 'chanter-open-id');
  inlineBody.append('startDate', '2026-07-10');
  inlineBody.append('startTime', '11:00');
  inlineBody.append('timezoneOffsetMinutes', '0');
  const inlineResponse = await fetch(`${baseUrl}/upload`, {
    method: 'POST', redirect: 'manual',
    headers: { Cookie: adminCookie, Accept: 'application/json' },
    body: inlineBody
  });
  assert.equal(inlineResponse.status, 200, 'JSON-accepting intake submit responds inline instead of redirecting');
  const inlinePayload = await inlineResponse.json();
  assert.equal(inlinePayload.ok, true);
  assert.match(inlinePayload.notice, /Created 1 post/);
  assert.match(inlinePayload.notice, /1 scheduled/);
  assert.doesNotMatch(JSON.stringify(inlinePayload), /secret-token|secret-refresh|access_token/);
  const callsAfterPostA = addUploadedPostsCalls.length;
  const explicitSchedulesAfterPostA = applyExplicitScheduleCalls.length;
  const automaticSchedulesAfterPostA = autoScheduleCalls.length;

  // Preflight failures also answer inline — form state survives client-side.
  const inlineBlockedBody = new FormData();
  inlineBlockedBody.append('publicMediaUrl', 'https://cdn.example.com/asset.mp4');
  inlineBlockedBody.append('targetChannels', 'retired-open-id');
  const inlineBlockedResponse = await fetch(`${baseUrl}/upload`, {
    method: 'POST', redirect: 'manual',
    headers: { Cookie: adminCookie, Accept: 'application/json' },
    body: inlineBlockedBody
  });
  assert.equal(inlineBlockedResponse.status, 409);
  const inlineBlockedPayload = await inlineBlockedResponse.json();
  assert.equal(inlineBlockedPayload.ok, false);
  assert.match(inlineBlockedPayload.notice, /reconnected/);
  assert.equal(addUploadedPostsCalls.length, callsAfterPostA, 'a rejected retry creates no duplicate job');

  // The same retained admin/account session can immediately schedule post B.
  // Only B's media/caption reach storage; A's exact URL/time are not reused.
  const inlineNextBody = new FormData();
  inlineNextBody.append('publicMediaUrl', 'https://cdn.example.com/post-b.mp4');
  inlineNextBody.append('caption', 'Post B');
  inlineNextBody.append('targetChannels', 'chanter-open-id');
  inlineNextBody.append('timezoneOffsetMinutes', '0');
  const inlineNextResponse = await fetch(`${baseUrl}/upload`, {
    method: 'POST', redirect: 'manual',
    headers: { Cookie: adminCookie, Accept: 'application/json' },
    body: inlineNextBody
  });
  assert.equal(inlineNextResponse.status, 200);
  assert.equal((await inlineNextResponse.json()).ok, true);
  assert.equal(addUploadedPostsCalls.length, callsAfterPostA + 1);
  const postBCall = addUploadedPostsCalls.at(-1);
  assert.equal(postBCall.defaults.publicMediaUrl, 'https://cdn.example.com/post-b.mp4');
  assert.equal(postBCall.defaults.caption, 'Post B');
  assert.deepEqual(postBCall.defaults.accounts.map((item) => item.accountId), ['chanter-open-id']);
  assert.equal(applyExplicitScheduleCalls.length, explicitSchedulesAfterPostA, 'post B did not reuse post A\'s explicit start time');
  assert.equal(autoScheduleCalls.length, automaticSchedulesAfterPostA + 1);
  assert.equal(autoScheduleCalls.at(-1).accountId, 'chanter-open-id', 'post B used the retained channel context');

  // A queue item may be committed even when the confirmation read fails.
  // Preserve that uncertainty through the HTTP adapter and tell the browser
  // to refresh the queue before the operator considers a retry.
  const callsBeforeUnknownResult = addUploadedPostsCalls.length;
  failNextScheduleConfirmation = true;
  const unknownResultBody = new FormData();
  unknownResultBody.append('publicMediaUrl', 'https://cdn.example.com/confirmation-unknown.mp4');
  unknownResultBody.append('caption', 'Confirmation unknown');
  unknownResultBody.append('targetChannels', 'chanter-open-id');
  const unknownResultResponse = await fetch(`${baseUrl}/upload`, {
    method: 'POST', redirect: 'manual',
    headers: { Cookie: adminCookie, Accept: 'application/json' },
    body: unknownResultBody
  });
  assert.equal(unknownResultResponse.status, 500);
  const unknownResultPayload = await unknownResultResponse.json();
  assert.equal(unknownResultPayload.ok, false);
  assert.equal(unknownResultPayload.resultUnknown, true);
  assert.equal(unknownResultPayload.code, 'internal');
  assert.match(unknownResultPayload.notice, /could not be fully confirmed/);
  assert.equal(unknownResultPayload.createdPostIds.length, 1);
  assert.equal(unknownResultPayload.createdPostId, unknownResultPayload.createdPostIds[0]);
  assert.equal(addUploadedPostsCalls.length, callsBeforeUnknownResult + 1, 'the uncertain response corresponds to a committed queue item');
  assert.ok(queueJobs.some((job) => job.id === unknownResultPayload.createdPostId));

  // The console is now a dashboard. What it must still do is OBSERVE work
  // correctly, so the queue-refresh guarantees the removed intake form used to
  // trigger are asserted here in their own right — they are queue behaviour,
  // not intake behaviour, and they outlived the form.
  const intakeHtml = await (await fetch(`${baseUrl}/private/autoposter`, { headers: { Cookie: adminCookie } })).text();
  for (const [, inlineScript] of intakeHtml.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
    if (inlineScript.trim()) new vm.Script(inlineScript, { filename: 'rendered-index-inline.js' });
  }

  // No composer survives here — not visibly, and not hidden in the DOM.
  assert.doesNotMatch(intakeHtml, /<form[^>]*class="upload-form"/, 'no intake form remains');
  assert.doesNotMatch(intakeHtml, /data-submit-feedback|data-upload-progress-fill/, 'no intake submit surface remains');
  assert.doesNotMatch(intakeHtml, /<input[^>]*type="file"/, 'no upload control remains anywhere in the DOM');
  assert.doesNotMatch(intakeHtml, /data-preflight/, 'the intake readiness panel left with the form it reviewed');
  for (const name of ['images', 'autoMusicToken', 'autoCaption', 'autoMusic', 'targetChannels']) {
    assert.doesNotMatch(intakeHtml, new RegExp(`name="${name}"`), `${name} is no longer composed here`);
  }

  // Queue observation, unchanged.
  assert.match(intakeHtml, /chanter:queue-refresh/);
  assert.match(intakeHtml, /loadQueueView\(window\.location\.href, \{ navigateOnFailure: false \}\)/, 'background queue refresh cannot force a page reload');
  assert.match(intakeHtml, /requestVersion !== queueRequestVersion/, 'only the newest overlapping queue refresh can replace the live queue');
  assert.match(intakeHtml, /data-queue-view-region/, 'the release queue region still renders');

  const creativeDetails = intakeHtml.match(/<details id="creative-tools"[^>]*>/);
  assert.ok(creativeDetails, 'Creative Engine renders as a secondary disclosure');
  assert.doesNotMatch(creativeDetails[0], /\sopen(?:\s|=|>)/, 'Creative Engine is closed by default');
  assert.ok(intakeHtml.indexOf('id="creative-tools"') > intakeHtml.indexOf('data-queue-view-region'), 'core scheduling and queue render before Creative Engine');
  assert.equal((intakeHtml.match(/id="prompt-evolver-root"/g) || []).length, 1, 'Creative Engine functionality remains mounted once');
  assert.match(intakeHtml, /href="#creative-tools" data-creative-tools-link/);
});
