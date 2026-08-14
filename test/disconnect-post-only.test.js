'use strict';

// A3 — effectful GET retirement.
//
// Disconnecting a provider account is a state change, but it was reachable as
// `GET /disconnect/tiktok` and `GET /disconnect/instagram`. Two things follow
// from that, and both are why this is a real defect rather than a style point:
//
//   1. csrfOriginCheck exempts GET/HEAD/OPTIONS by design, so the routes that
//      most needed an origin check were the only state-changing routes that
//      never received one.
//   2. A GET is reachable by anything that can cause a navigation — a link, a
//      prefetch, an <img src>, a link scanner — with the admin's own cookie.
//
// This file mounts the REAL middleware stack (attachUser + csrfOriginCheck +
// the router), because the property under test is a property of that stack.
// Asserting it against the router alone would prove nothing about CSRF.

process.env.ADMIN_PASSWORD = 'disconnect-post-only-admin-password';
process.env.OPENAI_API_KEY = 'test-openai-key';
process.env.ENABLE_INSTAGRAM = 'true';
process.env.YOUTUBE_ENABLED = 'false';

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const express = require('express');

const storage = require('../src/storage');
const auth = require('../src/auth');
const { installCommercialFixture } = require('./helpers/commercial-fixture');

const TIKTOK_ACCOUNT = {
  accountId: 'account-a',
  open_id: 'account-a',
  username: 'account_a',
  connected: true,
  connectedAt: '2026-07-01T00:00:00.000Z'
};

// Every mutation this suite guards is recorded rather than performed, so a
// leak shows up as a recorded call instead of as lost state.
const mutations = { tiktok: [], instagram: [] };

storage.getTikTokAccounts = async () => [TIKTOK_ACCOUNT];
storage.getTikTokAccount = async (userId, accountId) =>
  (accountId === TIKTOK_ACCOUNT.accountId ? TIKTOK_ACCOUNT : null);
storage.getCanonicalTikTokAccounts = async () => [TIKTOK_ACCOUNT];
storage.getCanonicalTikTokAccount = async (userId, accountId) =>
  (accountId === TIKTOK_ACCOUNT.accountId ? TIKTOK_ACCOUNT : null);
storage.getPosts = async () => [];
storage.disconnectTikTokAccount = async (userId, accountId) => {
  mutations.tiktok.push({ userId, accountId });
  return true;
};
storage.clearInstagramAuth = async () => {
  mutations.instagram.push({ cleared: true });
  return true;
};

installCommercialFixture(require('../src/commercialService'), storage);
const routes = require('../src/routes');

function startServer() {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'src', 'views'));
  app.use(express.urlencoded({ extended: true }));
  app.use(auth.attachUser);
  // The middleware under test. Present here exactly as server.js mounts it.
  app.use(auth.csrfOriginCheck);
  app.use(routes);
  return new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
}

function adminCookie() {
  return `${auth.ADMIN_SESSION_COOKIE}=${auth.createAdminSessionToken()}`;
}

test('disconnect is POST-only, origin-checked, and unreachable by GET', async (t) => {
  const server = await startServer();
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;
  const cookie = adminCookie();

  for (const route of ['/disconnect/tiktok', '/disconnect/instagram']) {
    mutations.tiktok.length = 0;
    mutations.instagram.length = 0;

    // 1. GET cannot disconnect. The route does not exist as a GET at all, so
    //    there is no handler that has to be trusted to stay harmless.
    const viaGet = await fetch(`${origin}${route}`, {
      headers: { cookie },
      redirect: 'manual'
    });
    assert.equal(viaGet.status, 404, `${route} must not answer GET`);
    assert.deepEqual(mutations.tiktok, [], `${route} GET mutated TikTok state`);
    assert.deepEqual(mutations.instagram, [], `${route} GET mutated Instagram state`);

    // 2. Cross-origin POST is denied by the origin check.
    const crossOrigin = await fetch(`${origin}${route}`, {
      method: 'POST',
      headers: {
        cookie,
        origin: 'https://attacker.example',
        'content-type': 'application/x-www-form-urlencoded'
      },
      body: '',
      redirect: 'manual'
    });
    assert.equal(crossOrigin.status, 403, `${route} accepted a cross-origin POST`);
    assert.deepEqual(mutations.tiktok, [], `${route} cross-origin POST mutated TikTok state`);
    assert.deepEqual(mutations.instagram, [], `${route} cross-origin POST mutated Instagram state`);

    // 3. Same-origin POST succeeds and performs exactly one mutation.
    const sameOrigin = await fetch(`${origin}${route}`, {
      method: 'POST',
      headers: {
        cookie,
        origin,
        'content-type': 'application/x-www-form-urlencoded'
      },
      body: 'returnTo=%2Fplatform',
      redirect: 'manual'
    });
    assert.equal(sameOrigin.status, 302, `${route} same-origin POST must succeed`);

    const performed = route.includes('tiktok') ? mutations.tiktok : mutations.instagram;
    const untouched = route.includes('tiktok') ? mutations.instagram : mutations.tiktok;
    assert.equal(performed.length, 1, `${route} must perform exactly one disconnect`);
    assert.deepEqual(untouched, [], `${route} touched the wrong provider`);
  }
});

test('a missing Origin header is refused rather than trusted', async (t) => {
  const server = await startServer();
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  mutations.tiktok.length = 0;

  // fetch always sets Origin on a cross-origin POST, so the header-less case
  // is exercised with a raw request. A request that carries neither Origin nor
  // Referer is exactly what a non-browser client sends.
  const http = require('node:http');
  const status = await new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/disconnect/tiktok',
      headers: {
        cookie: adminCookie(),
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': '0'
      }
    }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    request.on('error', reject);
    request.end();
  });

  assert.equal(status, 403, 'a POST with no Origin or Referer must be refused');
  assert.deepEqual(mutations.tiktok, [], 'a refused POST must mutate nothing');
});

test('no view offers a state-changing disconnect as a plain link', () => {
  const fs = require('node:fs');
  const viewsDir = path.join(__dirname, '..', 'src', 'views');
  for (const file of fs.readdirSync(viewsDir).filter((name) => name.endsWith('.ejs'))) {
    const source = fs.readFileSync(path.join(viewsDir, file), 'utf8');
    for (const match of source.matchAll(/href="([^"]*\/disconnect\/[^"]*)"/g)) {
      assert.fail(`${file} still links to ${match[1]} as a navigation`);
    }
  }
});
