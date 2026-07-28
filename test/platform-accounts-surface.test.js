'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ejs = require('ejs');

const repoRoot = path.join(__dirname, '..');
const accountsView = path.join(repoRoot, 'src', 'views', 'platform-accounts.ejs');

function model(overrides = {}) {
  return {
    appName: 'CHANTER',
    active: 'accounts',
    notice: '',
    tiktokAccounts: [
      { accountId: 'account-a', username: 'chanter', displayName: 'CHANTER', connected: true, clientAccessEnabled: true },
      { accountId: 'account-b', username: 'chanter.daily', displayName: 'CHANTER Daily', connected: true, clientAccessEnabled: false }
    ],
    activeTikTokAccount: {
      accountId: 'account-a',
      username: 'chanter',
      displayName: 'CHANTER',
      connected: true,
      clientAccessEnabled: true
    },
    channelReadiness: {
      connectionLabel: 'Connected',
      publishingLabel: 'Ready',
      lastVerifiedAt: '2026-07-28T09:00:00.000Z'
    },
    youtubeProvider: { configured: true, available: true },
    youtubeChannels: [{
      accountId: 'youtube-a',
      displayName: 'CHANTER Studio',
      connectionStatus: 'connected',
      publishingReady: true
    }],
    enableInstagram: false,
    instagramStatus: null,
    commercialView: {
      plan: { displayName: 'Creator' },
      usage: {
        scheduledPosts: { used: 12 },
        connectedAccounts: { used: 3 }
      }
    },
    helpers: { formatDateTime: () => 'Jul 28, 2026' },
    ...overrides
  };
}

function render(overrides) {
  return ejs.render(fs.readFileSync(accountsView, 'utf8'), model(overrides), { filename: accountsView });
}

function visibleDefaultCopy(html) {
  const cardStart = html.indexOf('<section class="accounts-card"');
  const manageStart = html.indexOf('<details class="account-manage">', cardStart);
  return html.slice(cardStart, manageStart)
    .replace(/<div class="account-action-panel">[\s\S]*?<\/div>\s*<\/details>/g, '')
    .replace(/<form class="account-action-panel"[\s\S]*?<\/form>\s*<\/details>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

test('default Accounts surface stays within four actions and 35 words', () => {
  const html = render();
  assert.equal((html.match(/account-primary-action/g) || []).length, 4);
  const words = visibleDefaultCopy(html).split(/\s+/);
  assert.ok(words.length <= 35, `persistent copy is ${words.length} words`);
  assert.doesNotMatch(html, /<details class="account-(?:action|manage)"[^>]*\sopen/);
});

test('default surface omits technical and internal dashboard clutter', () => {
  const html = render();
  const defaultSurface = html.slice(0, html.indexOf('<details class="account-manage">'));
  for (const forbidden of [
    'Legacy Full Access', 'INTERNAL', 'server-side', 'dry-run',
    'Release Queue', 'Scheduled posts', 'Active providers', 'Verified Jul'
  ]) {
    assert.doesNotMatch(defaultSurface, new RegExp(forbidden, 'i'));
  }
});

test('current account and a non-color connection signal are visible', () => {
  const html = render();
  assert.match(html, /<h1 id="accounts-heading">@chanter<\/h1>/);
  assert.match(html, /connection-signal is-connected/);
  assert.match(html, /<span aria-hidden="true"><\/span>Connected/);
});

test('Switch preserves the existing account-selection endpoint', () => {
  const html = render();
  assert.match(html, /<summary>Switch<\/summary>/);
  assert.match(html, /action="\/private\/autoposter\/account" method="post"/);
  assert.match(html, /name="returnTo" value="\/platform\/autoposter\/accounts"/);
  assert.match(html, /<option value="account-b"/);
});

test('Add Account preserves TikTok and YouTube connection entry points', () => {
  const html = render();
  assert.match(html, /<summary>Add Account<\/summary>/);
  assert.match(html, /href="\/connect\/tiktok\?new=1&amp;returnTo=/);
  assert.match(html, /href="\/connect\/youtube\?returnTo=/);
});

test('Client Access preserves generation and revoke actions', () => {
  const html = render();
  assert.match(html, /action="\/private\/autoposter\/account\/account-a\/client-access" method="post"/);
  assert.match(html, />Client Access<\/button>/);
  assert.match(html, /action="\/private\/autoposter\/account\/account-a\/client-access\/revoke"/);
});

test('provider and destructive controls remain behind Manage', () => {
  const html = render();
  const manageStart = html.indexOf('<details class="account-manage">');
  assert.ok(manageStart > 0);
  for (const control of ['Remove TikTok', 'Disconnect', 'Private uploads', '<h2>Settings</h2>']) {
    assert.ok(html.indexOf(control) > manageStart, `${control} stays behind Manage`);
  }
});

test('Done returns directly to the clean Composer', () => {
  const html = render();
  assert.match(html, /class="account-action-button account-primary-action is-done" href="\/platform\/autoposter\/compose">Done<\/a>/);
});

test('no-account state makes Add Account the single dominant action and mobile CSS prevents overflow', () => {
  const html = render({ activeTikTokAccount: null, tiktokAccounts: [], youtubeChannels: [] });
  const emptyStart = html.indexOf('<section class="accounts-empty"');
  const empty = html.slice(emptyStart, html.indexOf('</section>', emptyStart));
  assert.equal((empty.match(/account-action-primary/g) || []).length, 1);
  assert.match(empty, /<summary>Add Account<\/summary>/);
  const css = fs.readFileSync(path.join(repoRoot, 'public', 'platform', 'platform.css'), 'utf8');
  assert.match(css, /\.customer-accounts \{[^}]*overflow-x: clip/);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*\.accounts-actions \{ grid-template-columns: repeat\(2/);
});

test('the live customer navigation and routes keep Accounts inside the AutoPoster module', () => {
  const nav = fs.readFileSync(path.join(repoRoot, 'src', 'views', '_platform-nav.ejs'), 'utf8');
  const routes = fs.readFileSync(path.join(repoRoot, 'src', 'routes.js'), 'utf8');
  assert.match(nav, /href: '\/platform\/autoposter\/accounts', label: 'Accounts'/);
  assert.match(routes, /router\.get\('\/platform\/autoposter\/accounts', requireAdminPage, renderAutoPoster\)/);
  assert.match(routes, /req\.path === '\/platform\/autoposter\/accounts' \? 'platform-accounts' : 'index'/);
  assert.match(routes, /router\.get\('\/private\/autoposter\/accounts'[\s\S]*?res\.redirect\(302, '\/platform\/autoposter\/accounts'\)/);
});
