'use strict';

// P0 multi-account destination chips: connected accounts render as clickable,
// provider-grouped chips on the batch-intake page, one or many can be selected,
// and the selection is what the EXISTING fan-out contract receives.
//
// Two deterministic, fully offline layers:
//   1. The pure grouping helper (src/destinationChips.js) — grouping order,
//      duplicate collapse, selectable flags, selectable count.
//   2. The REAL intake template rendered with EJS — chip markup, provider
//      groups, checkbox semantics, disabled YouTube chip, selected-count
//      element, and the client-side selection contract.
// Layer 3 re-proves, through the REAL batchService, that the exact selected
// destination IDs a chip selection produces fan out to one draft per account.
// No provider endpoint, no network, no Firestore is touched anywhere here.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ejs = require('ejs');
const { createCommercialFixture } = require('./helpers/commercial-fixture');
const mediaPolicy = require('../src/mediaPolicy');
const { postFromDoc } = require('../src/postsMapper');
const {
  createAutoPosterApplicationService,
  createExecutionContext
} = require('../src/autoposterApplicationService');
const { createBatchService } = require('../src/batchService');
const { groupDestinationsByProvider, countSelectableAccounts } = require('../src/destinationChips');

const intakeViewPath = path.join(__dirname, '..', 'src', 'views', 'platform-autoposter.ejs');

// The three accounts named in the task brief.
const CONNECTED = [
  { provider: 'tiktok', providerDisplayName: 'TikTok', accountId: 'account-a', label: '@dailymemeai', publishingReady: true },
  { provider: 'tiktok', providerDisplayName: 'TikTok', accountId: 'account-b', label: '@ai__sphynx', publishingReady: true },
  { provider: 'youtube', providerDisplayName: 'YouTube', accountId: 'UC-chanter', label: '@chantercy', publishingReady: true }
];

const isSelectable = (provider) => provider !== 'youtube';
const unavailableReason = () => 'YouTube requires a title for each video. Assign it during review.';

function groupAll(destinations = CONNECTED) {
  return groupDestinationsByProvider(destinations, { isSelectable, unavailableReason });
}

// ─────────────────────────────────────────────────────────────────────────
// Layer 1: the pure grouping helper.
// ─────────────────────────────────────────────────────────────────────────

test('accounts group by provider in stable order, each carrying provider + handle', () => {
  const groups = groupAll();
  assert.deepEqual(groups.map((group) => group.provider), ['tiktok', 'youtube']);
  assert.deepEqual(groups.map((group) => group.providerDisplayName), ['TikTok', 'YouTube']);

  const tiktok = groups[0];
  assert.equal(tiktok.accounts.length, 2);
  // Every chip knows its own provider AND its own handle — the label the
  // operator reads is "TikTok — @handle".
  for (const account of tiktok.accounts) {
    assert.equal(account.providerDisplayName, 'TikTok');
    assert.match(account.label, /^@/);
  }
  assert.deepEqual(tiktok.accounts.map((account) => account.label), ['@ai__sphynx', '@dailymemeai']);
  assert.deepEqual(groups[1].accounts.map((account) => account.label), ['@chantercy']);
});

test('duplicate destination IDs collapse to exactly one chip', () => {
  const groups = groupAll([...CONNECTED, CONNECTED[0], { ...CONNECTED[0], label: '@dailymemeai' }]);
  const tiktok = groups.find((group) => group.provider === 'tiktok');
  assert.equal(tiktok.accounts.length, 2, 'a repeated account never renders twice');
  assert.equal(new Set(tiktok.accounts.map((account) => account.key)).size, 2);
});

test('selectable flags and the selectable count drive the intake gate, not the raw connected count', () => {
  const groups = groupAll();
  assert.equal(groups.find((group) => group.provider === 'tiktok').selectable, true);
  const youtube = groups.find((group) => group.provider === 'youtube');
  assert.equal(youtube.selectable, false);
  assert.match(youtube.accounts[0].unavailableReason, /requires a title for each video/);
  assert.equal(youtube.accounts[0].publishingReady, true, 'shown as connected, just not choosable here');

  // 3 connected accounts, but only 2 are selectable at intake.
  assert.equal(countSelectableAccounts(groups), 2);
  // A YouTube-only workspace has nothing to fan out at intake.
  assert.equal(countSelectableAccounts(groupAll([CONNECTED[2]])), 0);
  assert.equal(countSelectableAccounts(groupAll([])), 0);
});

test('malformed and unknown-provider entries are dropped or grouped deterministically', () => {
  const groups = groupAll([
    ...CONNECTED,
    null,
    { provider: '', accountId: 'x' },
    { provider: 'tiktok', accountId: '' },
    { provider: 'somefuture', providerDisplayName: 'SomeFuture', accountId: 'sf-1', label: '@future', publishingReady: true }
  ]);
  // Nothing invalid survives; a future provider still groups (after the known ones).
  assert.deepEqual(groups.map((group) => group.provider), ['tiktok', 'youtube', 'somefuture']);
  assert.equal(groups.find((group) => group.provider === 'somefuture').accounts.length, 1);
});

// ─────────────────────────────────────────────────────────────────────────
// Layer 2: the REAL intake template rendered offline.
// ─────────────────────────────────────────────────────────────────────────

function renderIntake(overrides = {}) {
  const groups = overrides.destinationGroups || groupAll();
  return ejs.render(fs.readFileSync(intakeViewPath, 'utf8'), {
    appName: 'CHANTER',
    destinationGroups: groups,
    selectableCount: overrides.selectableCount !== undefined
      ? overrides.selectableCount
      : countSelectableAccounts(groups),
    accountsError: overrides.accountsError || '',
    batchDefaults: {
      staggerMinutes: 30, staggerMin: 5, staggerMax: 1440, maxItems: 30, maxDestinations: 10
    }
  }, { filename: intakeViewPath });
}

function checkboxesIn(html) {
  return html.match(/<input[^>]*class="destination-checkbox"[^>]*>/g) || [];
}

test('every connected account renders as a chip with provider and handle', () => {
  const html = renderIntake();
  const boxes = checkboxesIn(html);
  assert.equal(boxes.length, 3, 'one chip per connected account');

  // Each chip carries the exact destination identity the fan-out contract uses.
  for (const dest of CONNECTED) {
    assert.ok(
      boxes.some((box) => box.includes(`value="${dest.provider}|${dest.accountId}"`)
        && box.includes(`data-provider="${dest.provider}"`)
        && box.includes(`data-account-id="${dest.accountId}"`)),
      `chip missing for ${dest.provider}|${dest.accountId}`
    );
    assert.ok(html.includes(dest.label), `handle ${dest.label} must be visible`);
  }
  assert.ok(html.includes('>TikTok<'), 'TikTok group heading rendered');
  assert.ok(html.includes('>YouTube<'), 'YouTube group heading rendered');
});

test('chips use checkbox semantics inside provider groups, with no hidden preselection', () => {
  const html = renderIntake();
  const boxes = checkboxesIn(html);
  for (const box of boxes) {
    assert.ok(box.includes('type="checkbox"'), 'chips are real checkboxes (multi-select + keyboard accessible)');
    assert.ok(!/\bchecked\b/.test(box), 'default selection is empty — nothing is preselected');
  }
  // Two provider groups, each declaring which provider it holds.
  assert.ok(html.includes('data-provider="tiktok"'), 'TikTok group present');
  assert.ok(html.includes('data-provider="youtube"'), 'YouTube group present');
  assert.equal((html.match(/class="destination-group"/g) || []).length, 2);
});

test('a non-selectable provider renders visibly disabled and can never be submitted', () => {
  const html = renderIntake();
  const boxes = checkboxesIn(html);
  const youtubeBox = boxes.find((box) => box.includes('data-provider="youtube"'));
  const tiktokBoxes = boxes.filter((box) => box.includes('data-provider="tiktok"'));

  assert.ok(youtubeBox.includes('disabled'), 'YouTube chip is disabled at intake');
  assert.ok(youtubeBox.includes('aria-disabled="true"'), 'disabled state is exposed to assistive tech');
  for (const box of tiktokBoxes) assert.ok(!box.includes('disabled'), 'TikTok chips stay selectable');
  assert.ok(html.includes('destination-chip-disabled'), 'disabled chip is visually distinct');
  assert.match(html, /requires a title for each video/, 'the operator is told why');

  // The client filters disabled boxes out of the selection set entirely.
  assert.match(html, /\.filter\(function \(box\) \{ return !box\.disabled; \}\)/);
});

test('the page shows a compact selected-account count and a clear-selection control', () => {
  const html = renderIntake();
  assert.ok(html.includes('id="selected-count"'), 'selected count element present');
  assert.ok(html.includes('aria-live="polite"'), 'count updates are announced');
  assert.ok(html.includes('id="clear-destinations"'), 'clear-selection control present');
  assert.equal(selectAllButtons(html).length, 1, 'select-all offered for a multi-account provider');
  // The count is recomputed from the live selection on every update.
  assert.match(html, /selectedCountEl\.textContent = destCount === 0/);
});

// The bare class name also appears in the page script's querySelectorAll, so
// only the rendered BUTTON markup proves whether the control exists.
function selectAllButtons(html) {
  return html.match(/<button[^>]*class="btn btn-quiet select-all-provider"[^>]*>/g) || [];
}

test('select-all renders only for a selectable provider holding more than one account', () => {
  const single = renderIntake({ destinationGroups: groupAll([CONNECTED[0], CONNECTED[2]]) });
  assert.equal(selectAllButtons(single).length, 0, 'a one-account provider needs no select-all');

  const buttons = selectAllButtons(renderIntake());
  assert.equal(buttons.length, 1, 'only TikTok (2 selectable accounts) offers select all');
  assert.ok(buttons[0].includes('data-provider="tiktok"'));
});

test('empty selection blocks submission with an operator-visible message', () => {
  const html = renderIntake();
  // The submit button starts disabled and stays disabled while nothing is chosen.
  assert.match(html, /submitBtn\.disabled = sourceCount === 0 \|\| destCount === 0/);
  assert.match(html, /id="submit-btn" type="submit" class="btn btn-primary" disabled/);
  // …and a keyboard submit with an empty selection explains itself.
  assert.match(html, /Select at least one destination before creating the batch/);
});

test('the form only appears when at least one account is actually selectable', () => {
  const youtubeOnly = renderIntake({ destinationGroups: groupAll([CONNECTED[2]]) });
  assert.ok(!youtubeOnly.includes('id="batch-form"'), 'no intake form without a selectable destination');
  assert.match(youtubeOnly, /No connected, publishing-ready account/);

  assert.ok(renderIntake().includes('id="batch-form"'), 'the form appears when TikTok is selectable');
});

test('destination-chip copy is English-only', () => {
  const html = renderIntake();

  // The exact product strings for this control.
  for (const copy of [
    '>Destinations<',
    'data-none="No accounts selected"',
    '>Select all<',
    '>Clear selection<',
    "'1 account selected'",
    "destCount + ' accounts selected'",
    'Select at least one destination before creating the batch.',
    'YouTube requires a title for each video. Assign it during review.',
    'Up to ' // + maxDestinations + ' destinations per batch.'
  ]) {
    assert.ok(html.includes(copy), `destination-chip copy must include ${copy}`);
  }

  // No Greek anywhere in the chip control markup. The per-destination sound
  // <select> is deliberately excluded: it is pre-existing legacy sound-mode
  // copy that this task only relocated, not chip copy this task introduced.
  const start = html.indexOf('<div class="destination-head">');
  const end = html.indexOf('</div>', html.indexOf('<div class="destination-actions">'));
  assert.ok(start >= 0 && end > start, 'chip region must be locatable');
  const chipRegion = html.slice(start, end).replace(/<select class="destination-sound"[\s\S]*?<\/select>/g, '');
  const greek = chipRegion.match(/[Ͱ-Ͽ]+/g);
  assert.equal(greek, null, `chip control copy must be English-only, found: ${greek}`);

  // The count and validation strings live in the page script, not the markup.
  const script = html.slice(html.indexOf('<script>'));
  const countAndValidation = [
    /selectedCountEl\.dataset\.none/,
    /'1 account selected'/,
    /destCount \+ ' accounts selected'/,
    /showNotice\('Select at least one destination before creating the batch\.', 'error'\)/,
    /showNotice\('Up to ' \+ maxDestinations \+ ' destinations per batch\.', 'error'\)/
  ];
  for (const pattern of countAndValidation) {
    assert.match(script, pattern, `script copy must match ${pattern}`);
  }
});

test('the chip selection is submitted through the existing destinations contract', () => {
  const html = renderIntake();
  // Selection is read off the chips, keeps per-destination sound mode, and is
  // posted as the same JSON `destinations` field the fan-out already consumes.
  assert.match(html, /var row = box\.closest\('\.destination-chip'\)/);
  assert.match(html, /provider: box\.dataset\.provider/);
  assert.match(html, /accountId: box\.dataset\.accountId/);
  assert.match(html, /soundMode: soundSelect \? soundSelect\.value : 'keep_original'/);
  assert.match(html, /data\.append\('destinations', JSON\.stringify\(destinations\)\)/);
  assert.match(html, /fetch\('\/api\/platform\/batches', \{ method: 'POST'/);
});

// ─────────────────────────────────────────────────────────────────────────
// Layer 3: the selection a chip click produces, through the REAL fan-out.
// ─────────────────────────────────────────────────────────────────────────

const BASE_NOW = Date.parse('2026-07-10T10:00:00.000Z');

const TEST_BATCH_CONFIG = {
  batchIntake: {
    maxItems: 10, prepareConcurrency: 2, prepareMaxAttempts: 3, prepareLeaseMinutes: 10,
    staggerDefaultMinutes: 30, staggerMinMinutes: 5, staggerMaxMinutes: 24 * 60,
    safetyBufferMinutes: 10, downloadTimeoutMs: 5_000, maxDownloadBytes: 250 * 1024 * 1024
  }
};

function uploadFile(name) {
  return { path: `/tmp/${name}`, originalname: name, filename: name, mimetype: 'video/mp4', size: 1024 };
}

// Three connected TikTok accounts: the "one media + three selected accounts"
// proof needs three SELECTABLE destinations.
function makeWorld() {
  const tiktokAccounts = ['account-a', 'account-b', 'account-c'].map((accountId, index) => ({
    accountId, open_id: `open-${accountId}`, userId: 'owner', platform: 'tiktok',
    username: ['dailymemeai', 'ai__sphynx', 'third_account'][index], connected: true,
    access_token: 'tt-access', refresh_token: 'tt-refresh', scope: 'user.info.basic,video.publish'
  }));
  const posts = [];
  const batchRecords = new Map();
  let sequence = 0;
  let now = BASE_NOW;

  const storage = {
    async getCanonicalTikTokAccount(userId, accountId) {
      return userId === 'owner' ? (tiktokAccounts.find((a) => a.accountId === accountId) || null) : null;
    },
    async getCanonicalTikTokAccounts(userId) { return userId === 'owner' ? tiktokAccounts : []; },
    async getTikTokAccount(userId, accountId) {
      return userId === 'owner' ? (tiktokAccounts.find((a) => a.accountId === accountId) || null) : null;
    },
    async getYouTubeAccounts() { return []; },
    async getYouTubeAccount() { return null; },
    async getPosts(userId, accountId) {
      return userId === 'owner' ? posts.filter((post) => !accountId || post.accountId === accountId) : [];
    },
    async getPost(userId, id, accountId) {
      if (userId !== 'owner') return null;
      return posts.find((post) => post.id === id && (!accountId || post.accountId === accountId)) || null;
    },
    async addUploadedPosts(userId, files, defaults) {
      const targets = Array.isArray(defaults.accounts) && defaults.accounts.length > 0
        ? defaults.accounts
        : [{ accountId: defaults.accountId, tiktokOpenId: defaults.tiktokOpenId, username: defaults.username, soundMode: defaults.soundMode }];
      const sources = Array.isArray(files) && files.length > 0 ? files : [null];
      const created = [];
      for (const target of targets) {
        for (let sourceIdx = 0; sourceIdx < sources.length; sourceIdx += 1) {
          const file = sources[sourceIdx];
          const post = postFromDoc({
            id: `post-${++sequence}`,
            data: () => ({
              userId, workspaceId: defaults.workspaceId,
              platform: defaults.provider, provider: defaults.provider,
              accountId: target.accountId, tiktokOpenId: target.tiktokOpenId, username: target.username,
              originalName: file ? file.originalname : '', fileName: file ? file.originalname : '',
              mediaType: 'video',
              mediaUrl: `https://cdn.example.com/${target.accountId}/${file ? file.originalname : 'url'}`,
              caption: defaults.caption, hashtags: defaults.hashtags, soundMode: target.soundMode,
              scheduledAt: null, status: 'pending', approvedAt: null, approvedBy: null,
              createdAt: { toDate: () => new Date(now) }, updatedAt: { toDate: () => new Date(now) },
              batchId: defaults.batchId || '',
              batchOrder: defaults.batchId ? created.length : null,
              sourceIndex: defaults.batchId ? sourceIdx : null,
              preparation: defaults.batchId
                ? { status: 'pending', attempts: 0, leaseAt: null, finishedAt: null, provider: '', fallbackUsed: false, error: '' }
                : null
            })
          });
          posts.push(post);
          created.push(post);
        }
      }
      return created;
    },
    async applyBatchSourceSchedule(userId, created, plan) {
      const slotsByIndex = new Map((plan.slots || []).map((slot) => [slot.index, slot]));
      created.forEach((createdPost) => {
        const stored = posts.find((post) => post.id === createdPost.id);
        const slot = slotsByIndex.get(stored.sourceIndex);
        if (!slot) throw new Error(`No schedule slot for source index ${stored.sourceIndex}.`);
        stored.scheduledAt = slot.scheduledAt;
        stored.status = 'scheduled';
      });
      return created.length;
    },
    async updatePost(userId, id, patch, accountId) {
      const post = posts.find((item) => item.id === id && (!accountId || item.accountId === accountId));
      if (!post) return null;
      const {
        provider, platform, accountId: _a, connectedAccountId, tiktokOpenId, username,
        providerMetadata, publishAttemptBudget, sourceIndex, batchId, batchOrder, preparation,
        ...allowed
      } = patch;
      Object.assign(post, allowed);
      if ('scheduledAt' in allowed) post.status = allowed.scheduledAt ? 'scheduled' : 'pending';
      return post;
    },
    async createBatchRecord(record) {
      if (batchRecords.has(record.batchId)) { const e = new Error('already exists'); e.code = 6; throw e; }
      const stored = { ...record, preparedCount: 0, failedCount: 0, acceptedCount: 0, deletedCount: 0,
        createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() };
      batchRecords.set(record.batchId, stored);
      return { ...stored };
    },
    async getBatchRecord(userId, batchId) {
      const record = batchRecords.get(batchId);
      return record && record.userId === userId ? { ...record } : null;
    },
    async listBatchRecords(userId) {
      return [...batchRecords.values()].filter((r) => r.userId === userId).map((r) => ({ ...r }));
    },
    async updateBatchRecord(userId, batchId, patch) {
      const record = batchRecords.get(batchId);
      if (!record || record.userId !== userId) return null;
      Object.assign(record, patch);
      return { ...record };
    },
    async deleteBatchRecord(userId, batchId) { return batchRecords.delete(batchId); },
    async getBatchPosts(userId, batchId) {
      return posts.filter((post) => post.userId === userId && post.batchId === batchId)
        .sort((a, b) => (a.batchOrder ?? 0) - (b.batchOrder ?? 0));
    },
    async claimBatchItemPreparation(userId, postId, options) {
      const post = posts.find((item) => item.id === postId && item.userId === userId);
      if (!post) return { outcome: 'not_found' };
      const preparation = post.preparation || {};
      if (preparation.status === 'succeeded') return { outcome: 'already_succeeded', post };
      if (Number(preparation.attempts || 0) >= options.maxAttempts) return { outcome: 'attempts_exhausted', post };
      post.preparation = { ...preparation, status: 'running', attempts: Number(preparation.attempts || 0) + 1 };
      return { outcome: 'claimed', post: { ...post } };
    },
    async recordBatchItemPreparationResult(userId, postId, result) {
      const post = posts.find((item) => item.id === postId && item.userId === userId);
      if (!post || !post.preparation || post.preparation.status !== 'running') return null;
      if (result.ok) {
        if (result.caption && !String(post.caption || '').trim()) post.caption = result.caption;
        post.preparation = { ...post.preparation, status: 'succeeded', error: '' };
      } else {
        post.preparation = { ...post.preparation, status: 'failed', error: String(result.error || '') };
      }
      return { ok: Boolean(result.ok) };
    }
  };

  const commercial = createCommercialFixture(storage, { planId: 'legacy_full_access' });
  const applicationService = createAutoPosterApplicationService({
    storage, mediaPolicy, commercialService: commercial, now: () => now
  });
  const batchService = createBatchService({
    config: TEST_BATCH_CONFIG, storage,
    autoCaption: { async analyzeVideoForCaption() { return { caption: 'c', hashtags: '#h', provider: 'fake', fallbackUsed: false }; } },
    applicationService, downloadMedia: async () => ({ bytes: 1 }), now: () => now, logger: { warn() {} }
  });

  return { posts, batchService, tiktokAccounts };
}

function websiteContext() {
  return createExecutionContext({ userId: 'owner', actorId: 'admin:owner', source: 'website' });
}

const INTAKE = {
  scheduleMode: 'interval', startDate: '2026-07-11', startTime: '09:00',
  timezoneOffsetMinutes: 0, staggerMinutes: 60
};

// A chip selection is exactly this: the value/data attributes of each checked chip.
function selectionFromChips(accountIds) {
  return accountIds.map((accountId) => ({ provider: 'tiktok', accountId }));
}

test('one media × three selected chips creates exactly three independent drafts', async () => {
  const world = makeWorld();
  const result = await world.batchService.createBatch(websiteContext(), {
    ...INTAKE, intakeKey: 'chips-three',
    destinations: selectionFromChips(['account-a', 'account-b', 'account-c']),
    files: [uploadFile('one.mp4')]
  });

  assert.equal(result.items.length, 3, 'exactly one draft per selected account');
  assert.equal(result.batch.destinationCount, 3);
  assert.equal(result.batch.videoCount, 1);

  // All three drafts reference the SAME canonical source identity…
  assert.equal(new Set(result.items.map((item) => item.sourceIndex)).size, 1);
  assert.equal(new Set(result.items.map((item) => item.scheduledAt)).size, 1);
  // …while each stores its OWN destination account ID.
  assert.deepEqual(
    new Set(result.items.map((item) => item.accountId)),
    new Set(['account-a', 'account-b', 'account-c'])
  );
  assert.equal(new Set(result.items.map((item) => item.id)).size, 3, 'three independent drafts');
  // Nothing published: every draft is an unapproved, merely scheduled post.
  assert.ok(result.items.every((item) => item.approved !== true));
  assert.ok(world.posts.every((post) => post.status === 'scheduled'));
});

test('a chip selection cannot fan out to the same account twice', async () => {
  const world = makeWorld();
  const result = await world.batchService.createBatch(websiteContext(), {
    ...INTAKE, intakeKey: 'chips-dupe',
    // A duplicated destination ID (double-click, stale client state).
    destinations: selectionFromChips(['account-a', 'account-b', 'account-a']),
    files: [uploadFile('one.mp4')]
  });
  assert.equal(result.items.length, 2, 'duplicates normalize to one draft per account');
  assert.deepEqual(new Set(result.items.map((item) => item.accountId)), new Set(['account-a', 'account-b']));
});

test('an empty chip selection is refused before anything is created', async () => {
  const world = makeWorld();
  await assert.rejects(
    world.batchService.createBatch(websiteContext(), {
      ...INTAKE, intakeKey: 'chips-empty', destinations: [], files: [uploadFile('one.mp4')]
    }),
    /at least one connected publishing account/
  );
  assert.equal(world.posts.length, 0, 'no partial batch on validation failure');
});

test('an unknown or disconnected chip value fails closed before creation', async () => {
  const world = makeWorld();
  await assert.rejects(
    world.batchService.createBatch(websiteContext(), {
      ...INTAKE, intakeKey: 'chips-unknown',
      destinations: selectionFromChips(['account-a', 'account-does-not-exist']),
      files: [uploadFile('one.mp4')]
    }),
    /not connected and publishing-ready/
  );
  assert.equal(world.posts.length, 0);

  // A chip that was connected when the page rendered but disconnected since.
  const world2 = makeWorld();
  world2.tiktokAccounts.find((account) => account.accountId === 'account-b').connected = false;
  await assert.rejects(
    world2.batchService.createBatch(websiteContext(), {
      ...INTAKE, intakeKey: 'chips-stale',
      destinations: selectionFromChips(['account-a', 'account-b']),
      files: [uploadFile('one.mp4')]
    }),
    /not connected and publishing-ready/
  );
  assert.equal(world2.posts.length, 0, 'no partial batch when one chip is stale');
});

test('per-destination sound mode stays independent across a multi-chip selection', async () => {
  const world = makeWorld();
  const result = await world.batchService.createBatch(websiteContext(), {
    ...INTAKE, intakeKey: 'chips-sound',
    destinations: [
      { provider: 'tiktok', accountId: 'account-a', soundMode: 'mute' },
      { provider: 'tiktok', accountId: 'account-b', soundMode: 'tiktok_recommended' },
      { provider: 'tiktok', accountId: 'account-c' }
    ],
    files: [uploadFile('one.mp4')]
  });
  const byAccount = new Map(result.items.map((item) => [item.accountId, item]));
  assert.equal(byAccount.get('account-a').soundMode, 'mute');
  assert.equal(byAccount.get('account-b').soundMode, 'tiktok_recommended');
  assert.equal(byAccount.get('account-c').soundMode, 'keep_original', 'unset defaults safely');
});
