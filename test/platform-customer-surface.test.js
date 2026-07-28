'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ejs = require('ejs');

const repoRoot = path.join(__dirname, '..');
const composerView = path.join(repoRoot, 'src', 'views', 'platform-compose.ejs');

function renderComposer() {
  return ejs.render(fs.readFileSync(composerView, 'utf8'), {
    appName: 'CHANTER',
    active: 'compose',
    destinationGroups: [
      {
        provider: 'tiktok',
        providerDisplayName: 'TikTok',
        selectable: true,
        accounts: [
          {
            provider: 'tiktok',
            providerDisplayName: 'TikTok',
            accountId: 'account-a',
            label: '@chanter',
            selectable: true,
            unavailableReason: ''
          },
          {
            provider: 'tiktok',
            providerDisplayName: 'TikTok',
            accountId: 'account-b',
            label: '@chanter.daily',
            selectable: true,
            unavailableReason: ''
          }
        ]
      }
    ],
    selectableCount: 2,
    accountsError: '',
    capabilities: {
      multiAccountPosting: true,
      perAccountOverrides: true,
      maxDestinationsPerPost: 5,
      maxItemsPerDraft: 20,
      advancedScheduling: true
    },
    autoCaptionConfigured: true,
    autoMusicConfigured: true,
    composeDefaults: {
      maxItems: 20,
      safetyBufferMinutes: 10,
      maxDailyOccurrences: 90,
      maxRecurringJobs: 500,
      schedulingHorizonDays: 90
    }
  }, { filename: composerView });
}

function stripMarkup(markup) {
  return markup
    .replace(/<[^>]+>/g, ' ')
    .replace(/&middot;|&times;|&rarr;|&check;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

test('the initial customer screen has one dominant action and four module destinations', () => {
  const html = renderComposer();
  const navStart = html.indexOf('<nav class="platform-nav customer-nav"');
  const nav = html.slice(navStart, html.indexOf('</nav>', navStart));

  assert.equal((nav.match(/class="platform-nav-link/g) || []).length, 4);
  for (const destination of ['Compose', 'Queue', 'Accounts', 'Activity']) {
    assert.ok(nav.includes(`>${destination}</a>`), `${destination} stays reachable`);
  }
  for (const forbidden of ['Overview', 'Modules', 'Approvals', 'Evidence', 'System health', 'Classic console']) {
    assert.doesNotMatch(nav, new RegExp(forbidden, 'i'));
  }

  const uploadStart = html.indexOf('<section class="customer-upload"');
  const uploadEnd = html.indexOf('</section>', uploadStart);
  const upload = html.slice(uploadStart, uploadEnd);
  assert.match(upload, /<button id="dropzone" class="upload-button" type="button">/);
  assert.equal((upload.match(/<span class="upload-label">Upload<\/span>/g) || []).length, 1);
  assert.doesNotMatch(upload, /<details[^>]*\sopen/);

  const headerStart = html.indexOf('<header class="platform-header">');
  const headerEnd = html.indexOf('</nav>', navStart) + '</nav>'.length;
  const initialCopy = stripMarkup(
    html.slice(headerStart, headerEnd)
      .replace(/<span class="sr-only"[\s\S]*?<\/span>/g, '')
      .concat(' Upload Use a link')
  );
  assert.ok(initialCopy.split(/\s+/).length <= 50, `persistent copy is ${initialCopy.split(/\s+/).length} words`);
});

test('upload reveals only the action-first scheduling controls', () => {
  const html = renderComposer();
  assert.match(html, /id="compose-workflow" class="customer-workflow hidden"/);
  assert.match(html, /id="asset-count" aria-live="polite">0 selected/);
  assert.match(html, /<input id="startDate" type="date">/);
  assert.match(html, /<input id="startTime" type="time">/);
  assert.match(html, /<textarea id="caption"/);
  assert.match(html, /id="select-all-assets"[^>]*aria-pressed="true">Select All</);
  assert.match(html, /id="submit-btn" type="submit" class="btn btn-primary" disabled>Go</);
  assert.match(html, /id="review-list" class="review-list sr-only"/, 'verbose readiness stays non-visual');
  assert.match(html, /assetSelection\[fileKey\(file\)\] = true/, 'uploaded assets default selected');
  assert.match(html, /classList\.toggle\('has-files', selectedFiles\.length > 0\)/, 'URL input stays editable when it is the active source');
  assert.match(html, /selectedSourceFiles\(\)\.forEach\(function \(file\) \{ data\.append\('videos', file\); \}\)/);
});

test('secondary capability is preserved behind one options disclosure', () => {
  const html = renderComposer();
  assert.equal((html.match(/id="customer-options"/g) || []).length, 1);
  assert.match(html, /<summary>\s*<span>Options<\/span>/);
  for (const control of [
    'id="destination-list"',
    'id="hashtags"',
    'id="shared-sound"',
    'id="auto-music"',
    'id="per-account-toggle"',
    'id="advanced-schedule"',
    'id="repeat-daily"',
    'id="youtube-fields"'
  ]) {
    assert.ok(html.includes(control), `${control} remains reachable`);
  }
  assert.doesNotMatch(html, /<details id="customer-options"[^>]*\sopen/);
});

test('canonical acceptance collapses to a compact success and errors expose one recovery action', () => {
  const html = renderComposer();
  assert.match(html, /fetch\('\/api\/platform\/batches', \{ method: 'POST'/);
  assert.match(html, /payload && payload\.ok && \(acceptedCommand \|\| payload\.batch \|\| payload\.series\)/);
  assert.match(html, /form\.classList\.add\('hidden'\)/);
  assert.match(html, /success\.classList\.remove\('hidden'\)/);
  assert.match(html, /<strong id="success-message" tabindex="-1">✓ Scheduled<\/strong>/);
  assert.match(html, />View Queue<\/a>/);
  assert.match(html, /showNotice\('Could not schedule '/);
  assert.match(html, /review\.textContent = 'Review'/);
  assert.doesNotMatch(html, /window\.location\.href/);
  assert.doesNotMatch(html, /\/api\/instagram\/publish|\/posts\/[^']*\/prepare/);
});

test('Queue, Accounts and Activity anchors exist on the preserved secondary console', () => {
  const consoleView = fs.readFileSync(path.join(repoRoot, 'src', 'views', 'index.ejs'), 'utf8');
  assert.match(consoleView, /id="accounts"/);
  assert.match(consoleView, /id="queue"/);
  assert.match(consoleView, /id="activity"/);
});
