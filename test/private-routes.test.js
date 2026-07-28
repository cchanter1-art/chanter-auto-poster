'use strict';

process.env.ADMIN_PASSWORD = 'test-admin-password-123';
process.env.OPENAI_API_KEY = 'test-openai-key';
process.env.ENABLE_INSTAGRAM = 'false';
process.env.YOUTUBE_ENABLED = 'false';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const express = require('express');

const storage = require('../src/storage');
const tiktok = require('../src/tiktok');
const instagram = require('../src/instagram');
const autoCaption = require('../src/autoCaption');
const autoMusic = require('../src/autoMusic');
const { attachUser } = require('../src/auth');

// Canary token values: these must never appear in any rendered page or
// JSON response. The connected-account/provider views are allowlist-based,
// so a leak here means a broken security boundary, not a formatting bug.
const CANARY_ACCESS_TOKEN = 'CANARY-ACCESS-TOKEN-9a8b7c6d5e4f3a2b';
const CANARY_REFRESH_TOKEN = 'CANARY-REFRESH-TOKEN-2b3a4f5e6d7c8b9a';

const accounts = [
  {
    accountId: 'account-a', open_id: 'account-a', username: 'account_a', connected: true,
    access_token: CANARY_ACCESS_TOKEN, refresh_token: CANARY_REFRESH_TOKEN,
    scope: 'user.info.basic,video.publish', connectedAt: '2026-07-01T00:00:00.000Z'
  },
  {
    accountId: 'account-b', open_id: 'account-b', username: 'account_b', connected: true,
    access_token: CANARY_ACCESS_TOKEN, refresh_token: CANARY_REFRESH_TOKEN
  }
];
const postsByAccount = {
  'account-a': [{
    id: 'post-a', accountId: 'account-a', tiktokOpenId: 'account-a', username: 'account_a',
    status: 'posted', originalName: 'account-a-history.jpg', mediaType: 'photo',
    mediaUrl: '/assets/chanter-logo.png', caption: 'Account A history', hashtags: '#a',
    privacyLevel: 'SELF_ONLY', postedAt: new Date().toISOString(),
    lastInstagramResult: {
      ok: false,
      reason: 'Hidden integration error',
      response: { access_token: 'CANARY-POST-RESULT-TOKEN' }
    },
    logs: [{ client_secret: 'CANARY-POST-LOG-SECRET' }]
  }],
  'account-b': [{
    id: 'post-b', accountId: 'account-b', tiktokOpenId: 'account-b', username: 'account_b',
    status: 'scheduled', originalName: 'account-b-queue.jpg', mediaType: 'photo',
    mediaUrl: '/assets/chanter-logo.png', caption: 'Account B queue', hashtags: '#b',
    privacyLevel: 'SELF_ONLY', scheduledAt: new Date(Date.now() + 60_000).toISOString()
  }]
};

storage.getTikTokAccounts = async () => accounts;
storage.getTikTokAccount = async (userId, accountId) => accounts.find((account) => account.accountId === accountId) || null;
storage.getPosts = async (userId, accountId) => accountId
  ? (postsByAccount[accountId] || [])
  : Object.values(postsByAccount).flat();
storage.getPost = async (userId, id, accountId) => {
  const post = Object.values(postsByAccount).flat().find((item) => item.id === id) || null;
  if (!post || (accountId && post.accountId !== accountId)) return null;
  return post;
};
storage.getSettings = async () => ({ dailyPostTime: '09:00' });
storage.getCounts = async () => ({
  total: 0,
  pending: 0,
  scheduled: 0,
  processing: 0,
  ready: 0,
  posted: 0,
  failed: 0
});
storage.getDashboardJobs = async () => Object.values(postsByAccount).flat();
// Hermetic YouTube truth: this file exercises a TikTok-only deployment, so
// the dashboard payload must not pick up real connected channels.
storage.getYouTubeAccounts = async () => [];
tiktok.getTikTokAuthStatus = async (accountId) => ({
  connected: Boolean(accountId), accountId, open_id: accountId, username: accountId === 'account-b' ? 'account_b' : 'account_a'
});
tiktok.queryCreatorInfo = async (accountId) => ({
  creator_username: accountId === 'account-b' ? 'account_b' : 'account_a',
  privacy_level_options: ['SELF_ONLY']
});
instagram.getInstagramAuthStatus = async () => {
  throw new Error('Instagram status must not be requested while the feature is disabled');
};
const missingInstagramKeys = [
  'META_APP_ID',
  'META_APP_SECRET',
  'META_ACCESS_TOKEN',
  'INSTAGRAM_BUSINESS_ACCOUNT_ID',
  'FACEBOOK_PAGE_ID'
];
instagram.getInstagramHealth = async () => ({
  success: true,
  platform: 'instagram',
  configured: false,
  canPublish: false,
  mode: 'dry-run',
  missing: missingInstagramKeys,
  message: 'Instagram publishing is not configured yet. The app can run in dry-run mode.'
});
instagram.publishInstagramMedia = async () => ({
  ok: false,
  success: false,
  platform: 'instagram',
  code: 'INSTAGRAM_NOT_CONFIGURED',
  message: 'Instagram publishing is not configured. Add the required Meta API keys to enable publishing.',
  missing: missingInstagramKeys,
  mode: 'api',
  published: false,
  reason: 'Instagram publishing is not configured.'
});
let analyzedVideoPath = '';
let musicVideoPath = '';
autoCaption.analyzeVideoForCaption = async (videoPath, draft) => {
  analyzedVideoPath = videoPath;
  assert.equal(draft.caption, 'Manual fallback');
  return {
    caption: 'Generated hook\nGenerated caption',
    hashtags: '#one #two #three #four #five #six #seven #eight',
    generatedCaption: 'Generated caption',
    hook: 'Generated hook',
    hashtagList: ['#one', '#two', '#three', '#four', '#five', '#six', '#seven', '#eight'],
    metadata: { durationSeconds: 5, width: 1080, height: 1920, hasAudio: true },
    transcriptUsed: true,
    transcriptionWarning: '',
    analysisWarning: '',
    provider: 'gemini',
    fallbackUsed: false,
    musicCategory: 'anime-epic',
    musicMood: 'heroic uplifting',
    musicIntensity: 0.78,
    musicTags: ['anime', 'heroic']
  };
};
autoMusic.isAutoMusicConfigured = () => true;
autoMusic.prepareAutoMusic = async ({ videoPath, analysis }) => {
  musicVideoPath = videoPath;
  assert.equal(analysis.musicCategory, 'anime-epic');
  return {
    token: 'signed-prepared-media-token',
    track: { id: 'anime-epic-demo-01', category: 'anime-epic' },
    render: { hasOriginalAudio: true, musicVolume: 0.2, durationSeconds: 5 }
  };
};

const { installCommercialFixture } = require('./helpers/commercial-fixture');
installCommercialFixture(require('../src/commercialService'), storage);
const routes = require('../src/routes');

test('serves the explicit legacy AutoPoster console and private dashboard', async (t) => {
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
  // Defensive isolation: this file runs as its own process (node --test
  // gives every test file a fresh process/module cache), but restore the
  // env vars this file sets on top of whatever the runner provided anyway,
  // so nothing here can ever depend on process-level state surviving past
  // this test.
  const envSnapshot = {
    ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    ENABLE_INSTAGRAM: process.env.ENABLE_INSTAGRAM
  };
  t.after(() => { Object.assign(process.env, envSnapshot); });

  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  const [unauthorizedAutoPoster, unauthorizedDashboard, unauthorizedApi, unauthorizedConnect, unauthorizedCaption] = await Promise.all([
    fetch(`${baseUrl}/private/autoposter`, { redirect: 'manual' }),
    fetch(`${baseUrl}/private/autoposter/dashboard`, { redirect: 'manual' }),
    fetch(`${baseUrl}/api/private/autoposter/dashboard`),
    fetch(`${baseUrl}/connect/tiktok`, { redirect: 'manual' }),
    fetch(`${baseUrl}/api/auto-caption`, { method: 'POST', headers: { Accept: 'application/json' } })
  ]);
  assert.equal(unauthorizedAutoPoster.status, 302);
  assert.match(unauthorizedAutoPoster.headers.get('location'), /^\/admin-login/);
  assert.equal(unauthorizedDashboard.status, 302);
  assert.match(unauthorizedDashboard.headers.get('location'), /^\/admin-login/);
  assert.equal(unauthorizedApi.status, 401);
  assert.deepEqual(await unauthorizedApi.json(), { ok: false, reason: 'Admin authentication required' });
  assert.equal(unauthorizedCaption.status, 401);
  assert.deepEqual(await unauthorizedCaption.json(), { ok: false, reason: 'Admin authentication required' });
  assert.equal(unauthorizedConnect.status, 302);
  assert.match(unauthorizedConnect.headers.get('location'), /^\/admin-login/);

  const instagramHealthResponse = await fetch(`${baseUrl}/api/instagram/health`);
  assert.equal(instagramHealthResponse.status, 200);
  assert.deepEqual(await instagramHealthResponse.json(), {
    success: true,
    platform: 'instagram',
    configured: false,
    canPublish: false,
    mode: 'dry-run',
    missing: missingInstagramKeys,
    message: 'Instagram publishing is not configured yet. The app can run in dry-run mode.'
  });

  const loginPageResponse = await fetch(`${baseUrl}/admin-login`);
  const loginPageHtml = await loginPageResponse.text();
  assert.equal(loginPageResponse.status, 200);
  assert.match(loginPageHtml, /Command Center Access/);
  assert.doesNotMatch(loginPageHtml, /test-admin-password-123/);

  const failedLogin = await fetch(`${baseUrl}/admin-login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: 'incorrect-password', returnTo: '/private/autoposter/legacy' })
  });
  assert.equal(failedLogin.status, 401);
  assert.equal(failedLogin.headers.get('set-cookie'), null);

  const loginResponse = await fetch(`${baseUrl}/admin-login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: 'test-admin-password-123', returnTo: '/private/autoposter/legacy' })
  });
  const adminCookie = String(loginResponse.headers.get('set-cookie') || '').split(';')[0];
  assert.equal(loginResponse.status, 302);
  assert.equal(loginResponse.headers.get('location'), '/private/autoposter/legacy');
  assert.match(adminCookie, /^chanter_admin_session=/);
  assert.match(String(loginResponse.headers.get('set-cookie')), /HttpOnly/i);
  assert.match(String(loginResponse.headers.get('set-cookie')), /SameSite=Lax/i);

  const [autoPosterResponse, dashboardResponse] = await Promise.all([
    fetch(`${baseUrl}/private/autoposter/legacy`, { headers: { Cookie: adminCookie } }),
    fetch(`${baseUrl}/private/autoposter/dashboard`, { headers: { Cookie: adminCookie } })
  ]);
  const [autoPosterHtml, dashboardHtml] = await Promise.all([
    autoPosterResponse.text(),
    dashboardResponse.text()
  ]);

  assert.equal(autoPosterResponse.status, 200);
  // Creation moved to the canonical composer; this page observes work only.
  // Auto Caption and Auto Music went with it — they are intake capabilities.
  assert.doesNotMatch(autoPosterHtml, /Prepare Campaign/);
  assert.doesNotMatch(autoPosterHtml, /data-auto-caption-toggle/);
  assert.doesNotMatch(autoPosterHtml, /data-auto-music-toggle/);
  assert.doesNotMatch(autoPosterHtml, /Turn on Auto Music|Turn on Auto Caption/);
  assert.match(autoPosterHtml, /href="\/platform\/compose"/, 'one creation action, pointing at the composer');
  assert.match(autoPosterHtml, /href="\/private\/autoposter\/dashboard"/);
  assert.match(autoPosterHtml, /account-a-history\.jpg/);
  assert.doesNotMatch(autoPosterHtml, /account-b-queue\.jpg/);
  assert.match(autoPosterHtml, /Connect Another Channel/);
  assert.match(autoPosterHtml, /Release Queue/);
  assert.match(autoPosterHtml, /Publishing Log/);
  // Preflight reviewed the intake form's readiness and left with it; the
  // composer's own Review step is where readiness is stated now.
  assert.doesNotMatch(autoPosterHtml, /data-preflight/);
  assert.doesNotMatch(autoPosterHtml, /Run Preflight/);
  assert.match(autoPosterHtml, /Instagram: Not configured/);
  assert.match(autoPosterHtml, /Dry-run mode active/);
  assert.match(autoPosterHtml, /Add Meta API keys to enable Instagram publishing/);

  // Provider/connected-account foundation: the page shows a truthful
  // provider + readiness summary for the active channel, built from the
  // safe connected-account view — and never leaks a credential.
  assert.match(autoPosterHtml, /data-channel-readiness/);
  assert.match(autoPosterHtml, /Provider: TikTok \(active\)/);
  assert.match(autoPosterHtml, /Ready to publish/);
  assert.doesNotMatch(autoPosterHtml, /CANARY-ACCESS-TOKEN/);
  assert.doesNotMatch(autoPosterHtml, /CANARY-REFRESH-TOKEN/);
  // Part 3 site acceptance (BEFORE CONFIGURATION): YouTube is implemented
  // but this environment has no credentials, so the page must show a
  // truthful "Not configured" state with NO working Connect control and no
  // environment details.
  assert.match(autoPosterHtml, /aria-label="YouTube provider"/);
  assert.match(autoPosterHtml, /Not configured/);
  assert.doesNotMatch(autoPosterHtml, /Connect YouTube/i);
  assert.doesNotMatch(autoPosterHtml, /href="\/connect\/youtube"/);
  assert.doesNotMatch(autoPosterHtml, /YOUTUBE_CLIENT_ID|TOKEN_ENCRYPTION_KEY/);
  // No fake provider integrations: unsupported providers must not appear
  // as connectable channels anywhere on the page.
  assert.doesNotMatch(autoPosterHtml, /Connect LinkedIn/i);
  assert.doesNotMatch(autoPosterHtml, /Connect Instagram/);

  assert.equal(dashboardResponse.status, 200);
  assert.match(dashboardHtml, /Command Center/);

  const dashboardSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'pages', 'AutoPosterDashboard.jsx'),
    'utf8'
  );
  assert.match(dashboardSource, /href="\/private\/autoposter"/);

  const dashboardDataResponse = await fetch(`${baseUrl}/api/private/autoposter/dashboard`, {
    headers: { Cookie: adminCookie }
  });
  const dashboardData = await dashboardDataResponse.json();
  assert.equal(dashboardDataResponse.status, 200);
  assert.equal(dashboardData.selectedAccountId, 'account-a');
  assert.deepEqual(dashboardData.accounts.map((account) => account.id), ['account-a', 'account-b']);
  assert.deepEqual(dashboardData.jobs.map((job) => job.accountId).sort(), ['account-a', 'account-b']);
  assert.deepEqual(dashboardData.accounts.map((account) => account.provider), ['tiktok', 'tiktok']);
  assert.deepEqual(
    dashboardData.accounts.map((account) => account.connectedAccountId),
    ['tiktok:account-a', 'tiktok:account-b']
  );
  assert.doesNotMatch(JSON.stringify(dashboardData), /CANARY-/);

  // Re-assert the "not configured" mock immediately before the call it
  // guards. This assertion must fail closed (503) purely from this test's
  // own setup, never from state left over by anything that ran earlier —
  // in this test or, in principle, in the route layer itself.
  instagram.publishInstagramMedia = async () => ({
    ok: false,
    success: false,
    platform: 'instagram',
    code: 'INSTAGRAM_NOT_CONFIGURED',
    message: 'Instagram publishing is not configured. Add the required Meta API keys to enable publishing.',
    missing: missingInstagramKeys,
    mode: 'api',
    published: false,
    reason: 'Instagram publishing is not configured.'
  });
  const blockedInstagramPublish = await fetch(`${baseUrl}/api/instagram/publish`, {
    method: 'POST',
    headers: {
      Cookie: adminCookie,
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ publishType: 'story', mediaUrl: 'https://cdn.example.com/story.mp4' })
  });
  assert.equal(blockedInstagramPublish.status, 503);
  assert.deepEqual(await blockedInstagramPublish.json(), {
    success: false,
    platform: 'instagram',
    code: 'INSTAGRAM_NOT_CONFIGURED',
    message: 'Instagram publishing is not configured. Add the required Meta API keys to enable publishing.',
    missing: missingInstagramKeys
  });

  const captionBody = new FormData();
  captionBody.append('video', new Blob([Buffer.from('test-video')], { type: 'video/mp4' }), 'sample.mp4');
  captionBody.append('caption', 'Manual fallback');
  captionBody.append('hashtags', '#manual');
  captionBody.append('autoMusic', '1');
  const captionResponse = await fetch(`${baseUrl}/api/auto-caption`, {
    method: 'POST',
    headers: { Cookie: adminCookie, Accept: 'application/json' },
    body: captionBody
  });
  const captionResult = await captionResponse.json();
  assert.equal(captionResponse.status, 200);
  assert.equal(captionResult.caption, 'Generated hook\nGenerated caption');
  assert.equal(captionResult.analysis.frameCount, 5);
  assert.equal(captionResult.analysis.transcriptUsed, true);
  assert.equal(captionResult.analysis.provider, 'gemini');
  assert.equal(captionResult.analysis.fallbackUsed, false);
  assert.equal(captionResult.music.prepared, true);
  assert.equal(captionResult.music.token, 'signed-prepared-media-token');
  assert.equal(captionResult.music.track.category, 'anime-epic');
  assert.ok(analyzedVideoPath);
  assert.equal(musicVideoPath, analyzedVideoPath);
  assert.equal(fs.existsSync(analyzedVideoPath), false);

  let failedVideoPath = '';
  autoCaption.analyzeVideoForCaption = async (videoPath) => {
    failedVideoPath = videoPath;
    const error = new Error('Provider unavailable');
    error.code = 'AI_REQUEST_FAILED';
    throw error;
  };
  const failedCaptionBody = new FormData();
  failedCaptionBody.append('video', new Blob([Buffer.from('test-video')], { type: 'video/mp4' }), 'failure.mp4');
  failedCaptionBody.append('caption', 'Keep this manual caption');
  failedCaptionBody.append('hashtags', '#manual');
  const failedCaptionResponse = await fetch(`${baseUrl}/api/auto-caption`, {
    method: 'POST',
    headers: { Cookie: adminCookie, Accept: 'application/json' },
    body: failedCaptionBody
  });
  const failedCaptionResult = await failedCaptionResponse.json();
  assert.equal(failedCaptionResponse.status, 422);
  assert.equal(failedCaptionResult.fallback.caption, 'Keep this manual caption');
  assert.equal(failedCaptionResult.requiresManualCaption, false);
  assert.match(failedCaptionResult.reason, /manual caption was kept/i);
  assert.ok(failedVideoPath);
  assert.equal(fs.existsSync(failedVideoPath), false);

  const switchResponse = await fetch(`${baseUrl}/private/autoposter/account`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: adminCookie },
    body: new URLSearchParams({ accountId: 'account-b' })
  });
  const accountCookie = String(switchResponse.headers.get('set-cookie') || '').split(';')[0];
  assert.equal(switchResponse.status, 302);
  assert.match(accountCookie, /autoposter_tiktok_account_id=account-b/);

  const accountBResponse = await fetch(`${baseUrl}/private/autoposter/legacy`, {
    headers: { Cookie: `${adminCookie}; ${accountCookie}` }
  });
  const accountBHtml = await accountBResponse.text();
  assert.match(accountBHtml, /account-b-queue\.jpg/);
  assert.doesNotMatch(accountBHtml, /account-a-history\.jpg/);
  // Queue cards render the premium action labels.
  assert.match(accountBHtml, /Publish Now/);
  assert.match(accountBHtml, /Save Campaign/);
  // The unapproved queue job is visibly a draft: approval chip, Approve
  // action, and a disabled Publish Now.
  assert.match(accountBHtml, /Approval required/);
  assert.match(accountBHtml, /\/posts\/post-b\/approve/);
  assert.match(accountBHtml, /Draft — awaiting approval/);

  let savedPatch = null;
  let savedAccountId = null;
  storage.updatePost = async (userId, postId, patch, accountId) => {
    savedPatch = patch;
    savedAccountId = accountId;
    return { id: postId, accountId, ...patch };
  };
  const saveResponse = await fetch(`${baseUrl}/posts/post-b`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: adminCookie },
    body: new URLSearchParams({
      caption: 'Updated TikTok post',
      hashtags: '#updated',
      privacyLevel: 'SELF_ONLY',
      scheduledAt: '',
      timezoneOffsetMinutes: '0',
      accountId: 'account-b'
    })
  });

  assert.equal(saveResponse.status, 302);
  assert.ok(savedPatch);
  assert.equal(savedAccountId, 'account-b');
  assert.equal(Object.hasOwn(savedPatch, 'instagramMediaUrl'), false);

  // ── Approval gate routes ──────────────────────────────────────────────
  const approveCalls = [];
  storage.approvePost = async (userId, postId, meta, accountId) => {
    approveCalls.push({ postId, meta, accountId });
    return { id: postId, approved: true, scheduledAt: null };
  };
  const approveResponse = await fetch(`${baseUrl}/posts/post-a/approve`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: adminCookie }
  });
  assert.equal(approveResponse.status, 302);
  assert.match(decodeURIComponent(approveResponse.headers.get('location')), /Approved\./);
  assert.equal(approveCalls.length, 1);
  assert.equal(approveCalls[0].postId, 'post-a');
  assert.equal(approveCalls[0].meta.approvedBy, 'admin:owner');
  assert.equal(approveCalls[0].accountId, undefined, 'provider-neutral admin action relies on workspace ownership');

  const revokeCalls = [];
  storage.revokePostApproval = async (userId, postId, accountId) => {
    revokeCalls.push({ postId, accountId });
    return { id: postId, approved: false };
  };
  const revokeResponse = await fetch(`${baseUrl}/posts/post-a/unapprove`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: adminCookie }
  });
  assert.equal(revokeResponse.status, 302);
  assert.match(decodeURIComponent(revokeResponse.headers.get('location')), /Approval removed/);
  assert.equal(revokeCalls.length, 1);

  // Publish Now on an unapproved draft is refused before any publish
  // attempt: scheduler.processPost must never be reached.
  const scheduler = require('../src/scheduler');
  const originalProcessPost = scheduler.processPost;
  let processPostCalls = 0;
  scheduler.processPost = async () => { processPostCalls += 1; return { ok: true }; };
  t.after(() => { scheduler.processPost = originalProcessPost; });
  storage.getPost = async (userId, id, accountId) => ({
    id, accountId, status: 'scheduled', approved: false, scheduledAt: null
  });
  const blockedPrepare = await fetch(`${baseUrl}/posts/post-a/prepare`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: adminCookie },
    body: new URLSearchParams({ force: '1' })
  });
  assert.equal(blockedPrepare.status, 302);
  assert.match(decodeURIComponent(blockedPrepare.headers.get('location')), /Approve this post first/);
  assert.equal(processPostCalls, 0);

  // An approved post reaches the (mocked) publish path as before.
  storage.getPost = async (userId, id, accountId) => ({
    id, accountId, status: 'scheduled', approved: true, scheduledAt: null
  });
  const allowedPrepare = await fetch(`${baseUrl}/posts/post-a/prepare`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: adminCookie },
    body: new URLSearchParams({ force: '1' })
  });
  assert.equal(allowedPrepare.status, 302);
  assert.equal(processPostCalls, 1);
});
