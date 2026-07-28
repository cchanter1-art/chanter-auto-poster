'use strict';

// Video-only TikTok intake — P0 enforcement at every creation path:
// the admin/campaign /upload (multer filter + URL check), the client
// portal upload, and the mediaPolicy helpers all layers share. Existing
// photo jobs stay viewable and deletable; only creation is guarded (the
// storage chokepoint is covered in test/storage-upload.test.js).

process.env.ADMIN_PASSWORD = 'test-admin-password-123';
process.env.ADMIN_SESSION_SECRET = 'test-admin-session-secret';
process.env.OPENAI_API_KEY = 'test-openai-key';
process.env.ENABLE_INSTAGRAM = 'false';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const express = require('express');

const {
  isVideoUploadFile,
  isVideoMediaUrl,
  VIDEO_ONLY_UPLOAD_MESSAGE,
  VIDEO_ONLY_URL_MESSAGE
} = require('../src/mediaPolicy');
const storage = require('../src/storage');
const tiktok = require('../src/tiktok');
const instagram = require('../src/instagram');
const { attachUser } = require('../src/auth');
const { attachClientSession } = require('../src/clientAuth');

test('mediaPolicy accepts only video uploads and video URLs', () => {
  // Files: MIME and extension must both agree (or the missing one is forgiven).
  assert.equal(isVideoUploadFile({ mimetype: 'video/mp4', originalname: 'clip.mp4' }), true);
  assert.equal(isVideoUploadFile({ mimetype: 'video/quicktime', originalname: 'clip.mov' }), true);
  assert.equal(isVideoUploadFile({ mimetype: 'video/webm', originalname: 'clip.webm' }), true);
  assert.equal(isVideoUploadFile({ mimetype: 'video/mp4', originalname: 'clip' }), true, 'video MIME with no extension is accepted');
  assert.equal(isVideoUploadFile({ mimetype: 'application/octet-stream', originalname: 'clip.mp4' }), true, 'generic MIME with a video extension is accepted');
  assert.equal(isVideoUploadFile({ mimetype: 'image/jpeg', originalname: 'photo.jpg' }), false);
  assert.equal(isVideoUploadFile({ mimetype: 'image/png', originalname: 'photo.mp4' }), false, 'image MIME is rejected even with a video extension');
  assert.equal(isVideoUploadFile({ mimetype: 'video/mp4', originalname: 'photo.png' }), false, 'video MIME with an image extension is a mismatch');
  assert.equal(isVideoUploadFile({ mimetype: 'application/octet-stream', originalname: 'file.bin' }), false);
  assert.equal(isVideoUploadFile({ mimetype: '', originalname: '' }), false);
  assert.equal(isVideoUploadFile(null), false);

  // URLs: the pathname must point directly at a video file.
  assert.equal(isVideoMediaUrl('https://cdn.example.com/clip.mp4'), true);
  assert.equal(isVideoMediaUrl('https://cdn.example.com/clip.MOV?sig=abc'), true, 'query strings and case are tolerated');
  assert.equal(isVideoMediaUrl('https://cdn.example.com/photo.jpg'), false);
  assert.equal(isVideoMediaUrl('https://cdn.example.com/asset'), false, 'extension-less URLs fail closed');
  assert.equal(isVideoMediaUrl('not-a-url'), false);
});

// ── Route-level enforcement ────────────────────────────────────────────────

const accounts = [{
  accountId: 'account-a', id: 'account-a', open_id: 'account-a', userId: 'owner',
  username: 'account_a', displayName: 'Account A', avatarUrl: '', connected: true,
  clientLoginId: 'login-a', clientAccessSecretHash: 'hash-a', clientAccessEnabled: true,
  updatedAt: new Date().toISOString()
}];

const addUploadedPostsCalls = [];
const createdPosts = [];

storage.getTikTokAccounts = async () => accounts;
storage.getTikTokAccount = async (userId, accountId) =>
  accounts.find((account) => account.accountId === accountId) || null;
storage.getPosts = async () => [];
storage.getPost = async (userId, id, accountId) =>
  createdPosts.find((post) => post.id === id && (!accountId || post.accountId === accountId)) || null;
storage.getDashboardJobs = async () => [];
storage.getSettings = async () => ({ dailyPostTime: '09:00' });
storage.getCounts = async () => ({ total: 0, pending: 0, scheduled: 0, processing: 0, ready: 0, posted: 0, failed: 0 });
storage.resolveClientAccount = async (userId, accountId) =>
  accounts.find((account) => account.accountId === accountId) || null;
storage.verifyClientAccessCode = async (rawCode) => (rawCode === 'login-a.secret-a' ? accounts[0] : null);
storage.addUploadedPosts = async (userId, files, defaults) => {
  addUploadedPostsCalls.push({ userId, files, defaults });
  // The route mocks skip storage's own temp-file cleanup — remove the
  // multer files here so test runs leave nothing in uploads/.
  (files || []).forEach((file) => { try { fs.unlinkSync(file.path); } catch (error) { /* already gone */ } });
  const created = (files && files.length > 0 ? files : [null]).map((file, index) => ({
    id: `created-${addUploadedPostsCalls.length}-${index}`,
    accountId: defaults.accountId || 'account-a',
    storageFallback: false,
    autoMusicApplied: false,
    duplicateWarning: ''
  }));
  createdPosts.push(...created);
  return created;
};
storage.autoSchedulePosts = async (userId, postIds) => {
  for (const id of postIds) {
    const post = createdPosts.find((item) => item.id === id);
    if (post) {
      post.status = 'scheduled';
      post.scheduledAt = new Date(Date.now() + 86_400_000).toISOString();
    }
  }
  return postIds.length;
};
storage.updatePost = async (userId, id, patch, accountId) => ({ id, accountId, ...patch });
tiktok.getTikTokAuthStatus = async (accountId) => ({ connected: Boolean(accountId), accountId });
tiktok.queryCreatorInfo = async () => ({ creator_username: 'account_a', privacy_level_options: ['SELF_ONLY'] });
instagram.getInstagramHealth = async () => ({
  success: true, platform: 'instagram', configured: true, canPublish: false, mode: 'dry-run', missing: [], message: 'ok'
});

const { installCommercialFixture } = require('./helpers/commercial-fixture');
installCommercialFixture(require('../src/commercialService'), storage);
const clientRoutes = require('../src/clientRoutes');
const routes = require('../src/routes');

function mediaForm(fields, file) {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.append(key, value);
  if (file) body.append(file.field, new Blob([Buffer.from(file.bytes)], { type: file.type }), file.name);
  return body;
}

test('image intake is refused on every creation path; video intake passes', async (t) => {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'src', 'views'));
  app.use(express.urlencoded({ extended: true }));
  app.use(attachUser);
  app.use(attachClientSession);
  app.use('/', clientRoutes);
  app.use('/', routes);

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
    body: new URLSearchParams({ password: 'test-admin-password-123', returnTo: '/private/autoposter/legacy' })
  });
  const adminCookie = String(loginResponse.headers.get('set-cookie') || '').split(';')[0];
  assert.match(adminCookie, /^chanter_admin_session=/);

  // ── The console no longer picks files at all ─────────────────────────────
  // The video-only RULE is server-side and unchanged (proven below); what left
  // this page is the picker, along with the rest of the intake form.
  const intakeHtml = await (await fetch(`${baseUrl}/private/autoposter/legacy`, { headers: { Cookie: adminCookie } })).text();
  assert.doesNotMatch(intakeHtml, /<input[^>]*type="file"/, 'no file picker remains on the dashboard');
  assert.doesNotMatch(intakeHtml, /accept="video/);
  assert.doesNotMatch(intakeHtml, /accept="image/);

  // ── Admin: image file is refused (server-side MIME check) ────────────────
  const imageUpload = await fetch(`${baseUrl}/upload`, {
    method: 'POST', redirect: 'manual', headers: { Cookie: adminCookie },
    body: mediaForm({ caption: 'Image try' }, { field: 'images', bytes: 'png-bytes', type: 'image/png', name: 'photo.png' })
  });
  assert.equal(imageUpload.status, 302);
  assert.match(decodeURIComponent(imageUpload.headers.get('location')), /video-only/i);
  assert.equal(addUploadedPostsCalls.length, 0);

  // The XHR (Fast Schedule) variant gets truthful inline JSON.
  const imageUploadJson = await fetch(`${baseUrl}/upload`, {
    method: 'POST', redirect: 'manual', headers: { Cookie: adminCookie, Accept: 'application/json' },
    body: mediaForm({ caption: 'Image try' }, { field: 'images', bytes: 'png-bytes', type: 'image/png', name: 'photo.png' })
  });
  assert.equal(imageUploadJson.status, 400);
  const imagePayload = await imageUploadJson.json();
  assert.equal(imagePayload.ok, false);
  assert.equal(imagePayload.notice, VIDEO_ONLY_UPLOAD_MESSAGE);
  assert.equal(addUploadedPostsCalls.length, 0);

  // ── Admin: MIME/extension mismatch is refused (extension check) ──────────
  const mismatchUpload = await fetch(`${baseUrl}/upload`, {
    method: 'POST', redirect: 'manual', headers: { Cookie: adminCookie },
    body: mediaForm({ caption: 'Mismatch' }, { field: 'images', bytes: 'bytes', type: 'video/mp4', name: 'photo.png' })
  });
  assert.equal(mismatchUpload.status, 302);
  assert.match(decodeURIComponent(mismatchUpload.headers.get('location')), /video-only/i);
  assert.equal(addUploadedPostsCalls.length, 0);

  // ── Admin: image public URL is refused; video URL is accepted ────────────
  const imageUrlUpload = await fetch(`${baseUrl}/upload`, {
    method: 'POST', redirect: 'manual', headers: { Cookie: adminCookie },
    body: mediaForm({ caption: 'URL try', publicMediaUrl: 'https://cdn.example.com/photo.jpg' })
  });
  assert.equal(imageUrlUpload.status, 302);
  assert.equal(decodeURIComponent(imageUrlUpload.headers.get('location')), `/private/autoposter/legacy?notice=${VIDEO_ONLY_URL_MESSAGE}`);
  assert.equal(addUploadedPostsCalls.length, 0);

  const videoUrlUpload = await fetch(`${baseUrl}/upload`, {
    method: 'POST', redirect: 'manual', headers: { Cookie: adminCookie },
    body: mediaForm({ caption: 'Video URL', publicMediaUrl: 'https://cdn.example.com/clip.mp4' })
  });
  assert.equal(videoUrlUpload.status, 302);
  assert.match(String(videoUrlUpload.headers.get('location')), /Created\+1\+post|Created%201%20post/);
  assert.equal(addUploadedPostsCalls.length, 1);

  // ── Admin: video file is accepted ────────────────────────────────────────
  const videoUpload = await fetch(`${baseUrl}/upload`, {
    method: 'POST', redirect: 'manual', headers: { Cookie: adminCookie },
    body: mediaForm({ caption: 'Video file' }, { field: 'images', bytes: 'mp4-bytes', type: 'video/mp4', name: 'clip.mp4' })
  });
  assert.equal(videoUpload.status, 302);
  assert.match(String(videoUpload.headers.get('location')), /Created\+1\+post|Created%201%20post/);
  assert.equal(addUploadedPostsCalls.length, 2);
  assert.equal(addUploadedPostsCalls[1].files.length, 1);
  assert.equal(addUploadedPostsCalls[1].files[0].originalname, 'clip.mp4');

  // ── Client portal ────────────────────────────────────────────────────────
  const clientLogin = await fetch(`${baseUrl}/client/autoposter/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ accessCode: 'login-a.secret-a' })
  });
  const clientCookie = String(clientLogin.headers.get('set-cookie') || '').split(';')[0];
  assert.match(clientCookie, /^chanter_client_session=/);

  const portalHtml = await (await fetch(`${baseUrl}/client/autoposter`, { headers: { Cookie: clientCookie } })).text();
  assert.match(portalHtml, /accept="video\/mp4,video\/quicktime,video\/webm"/);
  assert.doesNotMatch(portalHtml, /accept="image/);

  // Image file: refused with a truthful notice on the CLIENT portal (never
  // bounced to the admin surface).
  const clientImageUpload = await fetch(`${baseUrl}/client/autoposter/upload`, {
    method: 'POST', redirect: 'manual', headers: { Cookie: clientCookie },
    body: mediaForm({ caption: 'Client image' }, { field: 'media', bytes: 'png-bytes', type: 'image/png', name: 'photo.png' })
  });
  assert.equal(clientImageUpload.status, 302);
  const clientImageLocation = decodeURIComponent(clientImageUpload.headers.get('location'));
  assert.match(clientImageLocation, /^\/client\/autoposter\?notice=/);
  assert.match(clientImageLocation, /video-only/i);
  assert.equal(addUploadedPostsCalls.length, 2);

  // Image public URL: refused.
  const clientImageUrl = await fetch(`${baseUrl}/client/autoposter/upload`, {
    method: 'POST', redirect: 'manual', headers: { Cookie: clientCookie },
    body: mediaForm({ caption: 'Client URL', publicMediaUrl: 'https://cdn.example.com/photo.jpg' })
  });
  assert.equal(clientImageUrl.status, 302);
  assert.match(decodeURIComponent(clientImageUrl.headers.get('location')), /video-only/i);
  assert.equal(addUploadedPostsCalls.length, 2);

  // Video file: accepted and self-approved as before.
  const clientVideoUpload = await fetch(`${baseUrl}/client/autoposter/upload`, {
    method: 'POST', redirect: 'manual', headers: { Cookie: clientCookie },
    body: mediaForm({ caption: 'Client video' }, { field: 'media', bytes: 'mp4-bytes', type: 'video/mp4', name: 'clip.mp4' })
  });
  assert.equal(clientVideoUpload.status, 302);
  assert.match(decodeURIComponent(clientVideoUpload.headers.get('location')), /Post scheduled/);
  assert.equal(addUploadedPostsCalls.length, 3);
  assert.equal(addUploadedPostsCalls[2].defaults.selfApprove.approvedBy, 'client:@account_a');
});
