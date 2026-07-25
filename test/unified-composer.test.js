'use strict';

// Unified Post Composer + entitlement collapse.
//
// Single and Multi are no longer two products. This file proves the collapse at
// the three boundaries that can actually regress it:
//
//   A. The capability seam (src/composerPolicy.js) — pure, exhaustive over the
//      REAL plan catalog. No plan is invented and no current package loses
//      access it already had.
//   B. The canonical view (src/views/platform-compose.ejs), rendered offline
//      with EJS — one shell for one account and for many, one schedule
//      decision, locked capabilities stated in place, no history.
//   C. The canonical service path (the REAL batchService fan-out) and the REAL
//      router over HTTP — a locked capability is unusable through the API, and
//      legacy routes redirect instead of holding a second implementation.
//
// No provider endpoint, no network, and no Firestore is touched anywhere here.

process.env.ADMIN_PASSWORD = 'test-admin-password-123';
process.env.OPENAI_API_KEY = 'test-openai-key';
process.env.ENABLE_INSTAGRAM = 'false';
process.env.YOUTUBE_ENABLED = 'false';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ejs = require('ejs');
const express = require('express');

const composerPolicy = require('../src/composerPolicy');
const planCatalog = require('../src/planCatalog');
const { createCommercialFixture } = require('./helpers/commercial-fixture');
const mediaPolicy = require('../src/mediaPolicy');
const { postFromDoc } = require('../src/postsMapper');
const {
  createAutoPosterApplicationService,
  createExecutionContext
} = require('../src/autoposterApplicationService');
const { createBatchService } = require('../src/batchService');
const { groupDestinationsByProvider, countSelectableAccounts } = require('../src/destinationChips');

const composerViewPath = path.join(__dirname, '..', 'src', 'views', 'platform-compose.ejs');

// ─────────────────────────────────────────────────────────────────────────
// A. The capability seam.
// ─────────────────────────────────────────────────────────────────────────

function capabilitiesFor(planId, overrides = null) {
  const plan = planCatalog.getPlan(planId);
  return composerPolicy.resolveComposerCapabilities(
    { plan, entitlements: { ...plan.entitlements, ...(overrides || {}) } },
    { maxItems: 30 }
  );
}

test('composer capabilities derive from the real plan catalog, inventing no package', () => {
  // Exhaustive over what the repository actually declares.
  for (const planId of Object.values(planCatalog.PLAN_IDS)) {
    const capability = capabilitiesFor(planId);
    assert.equal(capability.resolved, true, `${planId} must resolve`);
    assert.equal(capability.planId, planId);
    assert.ok(capability.maxDestinationsPerPost >= 1);
    assert.ok(capability.maxItemsPerDraft >= 1);
    // The structural fan-out ceiling can be lowered by a package, never raised.
    assert.ok(
      capability.maxDestinationsPerPost <= composerPolicy.MAX_DESTINATIONS,
      `${planId} must not exceed the structural destination ceiling`
    );
  }
});

test('every package that exists today keeps the access it already had', () => {
  // The compatibility rule, asserted rather than asserted-about: no real plan
  // is narrowed into a single-destination or single-item composer by this seam.
  for (const planId of planCatalog.PUBLIC_PLAN_IDS) {
    const capability = capabilitiesFor(planId);
    assert.equal(capability.multiAccountPosting, true, `${planId} could already select multiple accounts`);
    assert.equal(capability.perAccountOverrides, true, `${planId} could already vary sound per destination`);
    assert.equal(capability.advancedScheduling, true, `${planId} could already spread a batch across days`);
    assert.ok(capability.maxItemsPerDraft > 1, `${planId} could already batch more than one item`);
  }

  // Starter is the tightest real package; its numbers come from the catalog.
  const starter = capabilitiesFor(planCatalog.PLAN_IDS.STARTER);
  assert.equal(starter.maxDestinationsPerPost, 2, 'Starter connectedAccountLimit is 2');
  assert.equal(starter.maxItemsPerDraft, 5, 'Starter batchSizeLimit is 5');
  assert.equal(starter.schedulingHorizonDays, 7);

  // The unmetered legacy plan collapses to the structural ceilings, not to 1.
  const legacy = capabilitiesFor(planCatalog.PLAN_IDS.LEGACY_FULL_ACCESS);
  assert.equal(legacy.maxDestinationsPerPost, composerPolicy.MAX_DESTINATIONS);
  assert.equal(legacy.maxItemsPerDraft, 30);
});

test('unverifiable plan truth degrades to the documented compatibility default', () => {
  const fallback = composerPolicy.resolveComposerCapabilities(null, { maxItems: 30 });
  assert.equal(fallback.resolved, false);
  assert.equal(fallback.reason, composerPolicy.COMPATIBILITY_REASON);
  // Exactly the behaviour the surface had before capabilities existed.
  assert.equal(fallback.maxDestinationsPerPost, composerPolicy.MAX_DESTINATIONS);
  assert.equal(fallback.maxItemsPerDraft, 30);
  assert.equal(fallback.multiAccountPosting, true);
  assert.equal(fallback.advancedScheduling, true);
  assert.equal(fallback.planId, null, 'no plan is claimed when none was verified');
});

test('a single-destination package is a reachable, locked state', () => {
  // Reachable only through an explicit entitlement override — the state the
  // locked presentation exists for.
  const locked = capabilitiesFor(planCatalog.PLAN_IDS.STARTER, { connectedAccountLimit: 1 });
  assert.equal(locked.maxDestinationsPerPost, 1);
  assert.equal(locked.multiAccountPosting, false);
  assert.equal(locked.perAccountOverrides, false, 'per-account variation is meaningless at one destination');
});

test('the submission check refuses exactly what the package locks', () => {
  const starter = capabilitiesFor(planCatalog.PLAN_IDS.STARTER);
  assert.equal(
    composerPolicy.checkComposerSubmission(starter, { destinationCount: 2, itemCount: 5 }).allowed,
    true
  );

  const overLimit = composerPolicy.checkComposerSubmission(starter, { destinationCount: 3, itemCount: 1 });
  assert.equal(overLimit.allowed, false);
  assert.equal(overLimit.code, 'destination_limit_reached');
  assert.equal(overLimit.limit, 2);
  assert.equal(overLimit.current, 3);

  const tooManyItems = composerPolicy.checkComposerSubmission(starter, { destinationCount: 1, itemCount: 6 });
  assert.equal(tooManyItems.allowed, false);
  assert.equal(tooManyItems.code, 'draft_size_limit_reached');

  const locked = capabilitiesFor(planCatalog.PLAN_IDS.STARTER, { connectedAccountLimit: 1 });
  const multiLocked = composerPolicy.checkComposerSubmission(locked, { destinationCount: 2, itemCount: 1 });
  assert.equal(multiLocked.allowed, false);
  assert.equal(multiLocked.code, 'multi_account_locked');
});

test('per-account variation is gated with multi-account posting, by derivation', () => {
  // The two capabilities are deliberately the same fact today. Asserting the
  // equivalence over the whole reachable space is what stops a future change
  // from silently splitting them without also adding the server rule that a
  // split would then require.
  for (const planId of Object.values(planCatalog.PLAN_IDS)) {
    for (const connectedAccountLimit of [null, 1, 2, 5, 20]) {
      const capability = capabilitiesFor(planId, { connectedAccountLimit });
      assert.equal(
        capability.perAccountOverrides,
        capability.multiAccountPosting,
        `${planId}/${connectedAccountLimit}: variation must follow multi-account posting`
      );
    }
  }

  // Consequence: a package without variation caps destinations at one, so the
  // destination rule is what refuses a varied submission. There is no separate
  // override rule to enforce, and therefore no unreachable branch pretending
  // to enforce one.
  const locked = capabilitiesFor(planCatalog.PLAN_IDS.STARTER, { connectedAccountLimit: 1 });
  assert.equal(locked.perAccountOverrides, false);
  assert.equal(
    composerPolicy.checkComposerSubmission(locked, { destinationCount: 2, itemCount: 1 }).code,
    'multi_account_locked'
  );
});

test('package rules live in one seam, not scattered through UI or business logic', () => {
  // The canonical seam is the only module allowed to name a plan. If a plan id
  // ever appears in a template, a route, or the batch service, this fails.
  const planIds = Object.values(planCatalog.PLAN_IDS);
  const shared = [
    path.join(__dirname, '..', 'src', 'views', 'platform-compose.ejs'),
    path.join(__dirname, '..', 'src', 'platformRoutes.js'),
    path.join(__dirname, '..', 'src', 'batchService.js')
  ];
  for (const file of shared) {
    const source = fs.readFileSync(file, 'utf8');
    for (const planId of planIds) {
      assert.ok(
        !source.includes(`'${planId}'`) && !source.includes(`"${planId}"`),
        `${path.basename(file)} must not compare plan ids directly (found ${planId})`
      );
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────
// B. The canonical view, rendered offline.
// ─────────────────────────────────────────────────────────────────────────

const CONNECTED = [
  { provider: 'tiktok', providerDisplayName: 'TikTok', accountId: 'account-a', label: '@dailymemeai', publishingReady: true },
  { provider: 'tiktok', providerDisplayName: 'TikTok', accountId: 'account-b', label: '@ai__sphynx', publishingReady: true }
];

function renderComposer(overrides = {}) {
  const groups = groupDestinationsByProvider(overrides.destinations || CONNECTED, {
    isSelectable: (provider) => provider !== 'youtube',
    unavailableReason: () => 'YouTube requires a title for each video. Assign it during review.'
  });
  return ejs.render(fs.readFileSync(composerViewPath, 'utf8'), {
    appName: 'CHANTER',
    active: 'compose',
    destinationGroups: groups,
    selectableCount: countSelectableAccounts(groups),
    accountsError: '',
    capabilities: overrides.capabilities || capabilitiesFor(planCatalog.PLAN_IDS.CREATOR),
    composeDefaults: { maxItems: 30, safetyBufferMinutes: 10 }
  }, { filename: composerViewPath });
}

test('one shell renders the whole flow, with no Single/Multi mode selector', () => {
  const html = renderComposer();

  // The six canonical steps, in order, in one page.
  for (const step of ['upload', 'accounts', 'caption', 'schedule', 'review']) {
    assert.ok(html.includes(`data-section="${step}"`), `step ${step} renders`);
    assert.ok(html.includes(`data-step="${step}"`), `step ${step} appears on the rail`);
  }
  assert.equal((html.match(/id="compose-form"/g) || []).length, 1, 'exactly one composer form');

  // No mode vocabulary anywhere — this is the regression that would rebuild the
  // two-product split by the back door.
  for (const forbidden of [/single\s*post/i, /multi\s*post/i, /μεμονωμ/i, /μαζικ/i, /data-mode="single"/i]) {
    assert.doesNotMatch(html, forbidden, `composer must not mention ${forbidden}`);
  }
});

test('one account and many accounts use the same control, same form, same endpoint', () => {
  const many = renderComposer();
  const one = renderComposer({
    capabilities: capabilitiesFor(planCatalog.PLAN_IDS.STARTER, { connectedAccountLimit: 1 })
  });

  // Same submission path in both cases — there is no second endpoint.
  for (const html of [one, many]) {
    assert.match(html, /fetch\('\/api\/platform\/batches', \{ method: 'POST'/);
    assert.equal((html.match(/<form id="compose-form">/g) || []).length, 1);
  }

  // The only difference is the selection control's arity.
  assert.match(many, /type="checkbox"\s+name="destination"/);
  assert.match(one, /type="radio"\s+name="destination"/);
});

test('a locked capability is one quiet line in place, never a separate interface', () => {
  const locked = renderComposer({
    capabilities: capabilitiesFor(planCatalog.PLAN_IDS.STARTER, { connectedAccountLimit: 1 })
  });
  assert.match(locked, /Multiple accounts<span class="lock-reason">Locked by your package<\/span>/);
  // No upsell flow: no pricing/billing/checkout/upgrade destination is offered.
  for (const forbidden of [/href="[^"]*(pricing|billing|checkout|upgrade|plans)/i, /<dialog/i]) {
    assert.doesNotMatch(locked, forbidden, `locked state must not open ${forbidden}`);
  }

  // An entitled package shows no lock line at all.
  assert.doesNotMatch(renderComposer(), /class="lock-line">Multiple accounts/);
});

test('per-account variation appears only for an entitled package', () => {
  const entitled = renderComposer();
  assert.ok(entitled.includes('id="per-account-toggle"'), 'entitled packages can opt in');
  assert.match(entitled, /Anything left blank inherits the main caption/, 'inheritance is explicit');

  const locked = renderComposer({
    capabilities: capabilitiesFor(planCatalog.PLAN_IDS.STARTER, { connectedAccountLimit: 1 })
  });
  assert.ok(!locked.includes('id="per-account-toggle"'), 'locked packages get no override control');
  assert.ok(locked.includes('id="per-account-locked"'), 'and are told why, in place');
});

test('the customer makes exactly one scheduling decision', () => {
  const html = renderComposer();

  // Publish-soonest or one date + one time. Nothing else is asked.
  assert.match(html, /name="when" value="soonest"/);
  assert.match(html, /name="when" value="at"/);
  assert.equal((html.match(/<input id="startDate" type="date">/g) || []).length, 1, 'one date field');
  assert.equal((html.match(/<input id="startTime" type="time">/g) || []).length, 1, 'one time field');

  // The provider-delay control is gone from the normal flow: spacing between
  // releases is computed server-side from the one base time.
  assert.doesNotMatch(html, /id="staggerMinutes"/, 'no user-facing stagger field');
  assert.doesNotMatch(html, /offsetMinutes/, 'no minutes-between-channels field');
  assert.doesNotMatch(html, /Minutes between channels/i);
  assert.doesNotMatch(html, /data\.append\('staggerMinutes'/, 'stagger is never submitted');

  // No per-account time entry anywhere.
  assert.doesNotMatch(html, /per-account-row[\s\S]{0,400}type="time"/);

  // Advanced multi-day scheduling exists but stays collapsed behind a summary.
  assert.match(html, /<details id="advanced-schedule"/);
  assert.doesNotMatch(html, /<details id="advanced-schedule"[^>]*\sopen/, 'advanced scheduling is closed by default');
});

test('advanced scheduling disappears entirely for a package that cannot use it', () => {
  const html = renderComposer({
    capabilities: capabilitiesFor(planCatalog.PLAN_IDS.STARTER, { batchSizeLimit: 1 })
  });
  assert.doesNotMatch(html, /id="advanced-schedule"/);
});

test('the composer creates work and never reports on it', () => {
  const html = renderComposer();
  // History, runs, evidence and operational detail belong to the dashboard.
  for (const forbidden of [
    /Recent batches/i,
    /Πρόσφατες παρτίδες/,
    /id="batch-list"/,
    /fetch\('\/api\/platform\/batches',\s*\{\s*headers/,
    /publish history/i,
    /retry/i
  ]) {
    assert.doesNotMatch(html, forbidden, `composer must not surface ${forbidden}`);
  }
  // The only status it shows is the current draft's readiness.
  assert.ok(html.includes('id="review-list"'));
});

test('the review step is a concise, deterministic readiness statement', () => {
  const html = renderComposer();
  assert.match(html, /'✔ ' : '· '/, 'each review line is a checkmark or an open item');
  // Every canonical step reports into the review list.
  assert.match(html, /uploadOk && accountsOk && captionOk && scheduleOk/);
  assert.match(html, /submitBtn\.disabled = !ready/, 'acceptance is impossible until ready');
});

// ─────────────────────────────────────────────────────────────────────────
// C. The canonical service path and the real router.
// ─────────────────────────────────────────────────────────────────────────

const BASE_NOW = Date.parse('2026-07-10T10:00:00.000Z');

const TEST_BATCH_CONFIG = {
  batchIntake: {
    maxItems: 30, prepareConcurrency: 2, prepareMaxAttempts: 3, prepareLeaseMinutes: 10,
    staggerDefaultMinutes: 30, staggerMinMinutes: 5, staggerMaxMinutes: 24 * 60,
    safetyBufferMinutes: 10, downloadTimeoutMs: 5_000, maxDownloadBytes: 250 * 1024 * 1024
  }
};

function uploadFile(name) {
  return { path: `/tmp/${name}`, originalname: name, filename: name, mimetype: 'video/mp4', size: 1024 };
}

function makeWorld({ planId = 'legacy_full_access', entitlements = null } = {}) {
  const tiktokAccounts = ['account-a', 'account-b', 'account-c'].map((accountId, index) => ({
    accountId, open_id: `open-${accountId}`, userId: 'owner', platform: 'tiktok',
    username: ['dailymemeai', 'ai__sphynx', 'third_account'][index], connected: true,
    access_token: 'tt-access', refresh_token: 'tt-refresh', scope: 'user.info.basic,video.publish'
  }));
  const posts = [];
  const batchRecords = new Map();
  let sequence = 0;
  const now = BASE_NOW;

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

  const commercial = createCommercialFixture(storage, { planId });
  if (entitlements) {
    // The one way a package can be narrower than its catalog entry: an explicit
    // entitlement override on the subscription.
    const original = commercial.resolveContext;
    commercial.resolveContext = async (input) => {
      const context = await original(input);
      return { ...context, entitlements: { ...context.entitlements, ...entitlements } };
    };
  }
  const applicationService = createAutoPosterApplicationService({
    storage, mediaPolicy, commercialService: commercial, now: () => now
  });
  const batchService = createBatchService({
    config: TEST_BATCH_CONFIG, storage,
    autoCaption: { async analyzeVideoForCaption() { return { caption: 'c', hashtags: '#h', provider: 'fake', fallbackUsed: false }; } },
    applicationService, downloadMedia: async () => ({ bytes: 1 }), now: () => now, logger: { warn() {} }
  });

  return { posts, batchService };
}

function websiteContext() {
  return createExecutionContext({ userId: 'owner', actorId: 'admin:owner', source: 'website' });
}

// Exactly what the composer submits: one base date, one base time, no stagger.
const COMPOSED = {
  scheduleMode: 'interval', startDate: '2026-07-11', startTime: '09:00', timezoneOffsetMinutes: 0
};

test('one account and many accounts travel the identical canonical command path', async () => {
  const world = makeWorld();

  const single = await world.batchService.createBatch(websiteContext(), {
    ...COMPOSED, intakeKey: 'one-account',
    destinations: [{ provider: 'tiktok', accountId: 'account-a' }],
    files: [uploadFile('one.mp4')]
  });
  const multi = await world.batchService.createBatch(websiteContext(), {
    ...COMPOSED, intakeKey: 'many-accounts',
    destinations: [
      { provider: 'tiktok', accountId: 'account-a' },
      { provider: 'tiktok', accountId: 'account-b' },
      { provider: 'tiktok', accountId: 'account-c' }
    ],
    files: [uploadFile('one.mp4')]
  });

  assert.equal(single.items.length, 1);
  assert.equal(multi.items.length, 3);

  // Same record shape, same draft semantics, same approval gate — the only
  // difference between them is the destination count.
  for (const result of [single, multi]) {
    assert.equal(result.replayed, false);
    assert.ok(result.items.every((item) => item.approved !== true), 'nothing is pre-approved');
    assert.ok(result.items.every((item) => item.status === 'scheduled'));
    assert.ok(result.items.every((item) => item.batchId === result.batch.batchId));
  }
  assert.equal(single.batch.destinationCount, 1);
  assert.equal(multi.batch.destinationCount, 3);
});

test('the composer caption reaches the drafts instead of being discarded', async () => {
  const world = makeWorld();
  const result = await world.batchService.createBatch(websiteContext(), {
    ...COMPOSED, intakeKey: 'with-caption',
    destinations: [
      { provider: 'tiktok', accountId: 'account-a' },
      { provider: 'tiktok', accountId: 'account-b' }
    ],
    caption: 'one main caption',
    hashtags: '#chanter',
    files: [uploadFile('one.mp4')]
  });

  // One main caption, inherited by every selected destination.
  assert.equal(result.items.length, 2);
  for (const item of result.items) {
    assert.equal(item.caption, 'one main caption');
    assert.equal(item.hashtags, '#chanter');
  }
});

test('one base time governs the whole draft; spacing is internal', async () => {
  const world = makeWorld();
  const result = await world.batchService.createBatch(websiteContext(), {
    ...COMPOSED, intakeKey: 'one-time',
    destinations: [{ provider: 'tiktok', accountId: 'account-a' }],
    files: [uploadFile('a.mp4'), uploadFile('b.mp4'), uploadFile('c.mp4')]
  });

  const times = result.items
    .slice()
    .sort((left, right) => left.sourceIndex - right.sourceIndex)
    .map((item) => Date.parse(item.scheduledAt));

  // The user's base time is honoured exactly — internal staggering never moves it.
  assert.equal(new Date(times[0]).toISOString(), '2026-07-11T09:00:00.000Z');
  // …and the spacing is the server's default, which the user never entered.
  const stagger = TEST_BATCH_CONFIG.batchIntake.staggerDefaultMinutes * 60_000;
  assert.equal(times[1] - times[0], stagger);
  assert.equal(times[2] - times[1], stagger);
  assert.equal(result.batch.staggerMinutes, TEST_BATCH_CONFIG.batchIntake.staggerDefaultMinutes);
});

test('the base time is interpreted in the customer timezone, not the server one', async () => {
  const world = makeWorld();
  const result = await world.batchService.createBatch(websiteContext(), {
    scheduleMode: 'interval', startDate: '2026-07-11', startTime: '09:00',
    // UTC+3: 09:00 local is 06:00Z.
    timezoneOffsetMinutes: -180,
    intakeKey: 'tz',
    destinations: [{ provider: 'tiktok', accountId: 'account-a' }],
    files: [uploadFile('a.mp4')]
  });
  assert.equal(new Date(result.items[0].scheduledAt).toISOString(), '2026-07-11T06:00:00.000Z');
});

test('a locked multi-account package cannot fan out through the API', async () => {
  const world = makeWorld({ planId: 'starter', entitlements: { connectedAccountLimit: 1 } });

  await assert.rejects(
    world.batchService.createBatch(websiteContext(), {
      ...COMPOSED, intakeKey: 'locked-multi',
      destinations: [
        { provider: 'tiktok', accountId: 'account-a' },
        { provider: 'tiktok', accountId: 'account-b' }
      ],
      files: [uploadFile('one.mp4')]
    }),
    (error) => {
      assert.equal(error.name, 'BatchServiceError');
      assert.equal(error.code, 'multi_account_locked');
      assert.equal(error.status, 403);
      return true;
    }
  );
  // Refused before anything durable exists.
  assert.equal(world.posts.length, 0, 'no draft is created by a refused submission');

  // The same package can still post to one account — it is not blocked, only bounded.
  const allowed = await world.batchService.createBatch(websiteContext(), {
    ...COMPOSED, intakeKey: 'locked-single',
    destinations: [{ provider: 'tiktok', accountId: 'account-a' }],
    files: [uploadFile('one.mp4')]
  });
  assert.equal(allowed.items.length, 1);
});

test('the package destination limit is enforced server-side, not by the disabled control', async () => {
  // Starter allows 2 destinations; a client that ignores the UI still cannot post 3.
  const world = makeWorld({ planId: 'starter' });
  await assert.rejects(
    world.batchService.createBatch(websiteContext(), {
      ...COMPOSED, intakeKey: 'over-limit',
      destinations: [
        { provider: 'tiktok', accountId: 'account-a' },
        { provider: 'tiktok', accountId: 'account-b' },
        { provider: 'tiktok', accountId: 'account-c' }
      ],
      files: [uploadFile('one.mp4')]
    }),
    (error) => {
      assert.equal(error.code, 'destination_limit_reached');
      assert.equal(error.details.limit, 2);
      assert.equal(error.details.current, 3);
      return true;
    }
  );
  assert.equal(world.posts.length, 0);
});

test('a varied selection is refused for a package without per-account variation', async () => {
  const world = makeWorld({ planId: 'starter', entitlements: { connectedAccountLimit: 1 } });

  // Varying sound needs two destinations, which this package does not have —
  // so the destination rule is what refuses it. Asserting the CODE keeps this
  // test honest about which rule actually fired.
  await assert.rejects(
    world.batchService.createBatch(websiteContext(), {
      ...COMPOSED, intakeKey: 'locked-varied',
      destinations: [
        { provider: 'tiktok', accountId: 'account-a', soundMode: 'mute' },
        { provider: 'tiktok', accountId: 'account-b', soundMode: 'keep_original' }
      ],
      files: [uploadFile('one.mp4')]
    }),
    (error) => {
      assert.equal(error.code, 'multi_account_locked');
      assert.match(error.message, /locked by your package/i);
      return true;
    }
  );
  assert.equal(world.posts.length, 0);

  // One shared sound value is NOT per-account variation, and still works.
  const shared = await world.batchService.createBatch(websiteContext(), {
    ...COMPOSED, intakeKey: 'shared-sound',
    destinations: [{ provider: 'tiktok', accountId: 'account-a', soundMode: 'mute' }],
    files: [uploadFile('one.mp4')]
  });
  assert.equal(shared.items.length, 1);
  assert.equal(shared.items[0].soundMode, 'mute');
});

test('an entitled package keeps independent per-account variation', async () => {
  const world = makeWorld({ planId: 'studio' });
  const result = await world.batchService.createBatch(websiteContext(), {
    ...COMPOSED, intakeKey: 'varied-ok',
    destinations: [
      { provider: 'tiktok', accountId: 'account-a', soundMode: 'mute' },
      { provider: 'tiktok', accountId: 'account-b', soundMode: 'tiktok_recommended' }
    ],
    files: [uploadFile('one.mp4')]
  });
  const byAccount = new Map(result.items.map((item) => [item.accountId, item]));
  assert.equal(byAccount.get('account-a').soundMode, 'mute');
  assert.equal(byAccount.get('account-b').soundMode, 'tiktok_recommended');
});

test('re-submitting the same composed draft restores it instead of duplicating it', async () => {
  const world = makeWorld();
  const first = await world.batchService.createBatch(websiteContext(), {
    ...COMPOSED, intakeKey: 'restore-me',
    destinations: [{ provider: 'tiktok', accountId: 'account-a' }],
    files: [uploadFile('one.mp4')]
  });
  const replay = await world.batchService.createBatch(websiteContext(), {
    ...COMPOSED, intakeKey: 'restore-me',
    destinations: [{ provider: 'tiktok', accountId: 'account-a' }],
    files: [uploadFile('one.mp4')]
  });

  assert.equal(replay.replayed, true, 'the durable draft is restored, not recreated');
  assert.equal(replay.batch.batchId, first.batch.batchId);
  assert.equal(world.posts.length, 1, 'no second copy of the work');
});

// ─────────────────────────────────────────────────────────────────────────
// D. The real router: canonical route, legacy redirects, navigation.
// ─────────────────────────────────────────────────────────────────────────

const auth = require('../src/auth');
auth.requireAdminPage = (req, res, next) => next();
auth.requireAdminApi = (req, res, next) => next();
auth.resolveUserId = () => 'owner';

const firestoreModule = require('../src/firestore');
firestoreModule.validateFirebaseConfig = () => {
  throw new Error('firebase is deliberately unconfigured for this test');
};

const realBatchService = require('../src/batchService');
const platformRoutes = require('../src/platformRoutes');

function startServer() {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'src', 'views'));
  app.use(express.urlencoded({ extended: true }));
  app.use('/', platformRoutes);
  return new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
}

async function withServer(t, run) {
  const originalListDestinations = realBatchService.listDestinations;
  const originalCapabilities = realBatchService.getComposerCapabilities;
  const originalListBatches = realBatchService.listBatches;
  realBatchService.listDestinations = async () => ({ destinations: CONNECTED });
  realBatchService.getComposerCapabilities = async () => capabilitiesFor(planCatalog.PLAN_IDS.CREATOR);
  realBatchService.listBatches = async () => ({ batches: [] });
  const server = await startServer();
  t.after(() => {
    realBatchService.listDestinations = originalListDestinations;
    realBatchService.getComposerCapabilities = originalCapabilities;
    realBatchService.listBatches = originalListBatches;
    server.close();
  });
  const { port } = server.address();
  await run(`http://127.0.0.1:${port}`);
}

test('the canonical composer route serves the one composer', async (t) => {
  await withServer(t, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/platform/compose`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.ok(html.includes('id="compose-form"'), 'the canonical composer renders');
    assert.ok(html.includes('data-section="upload"'));
    assert.ok(html.includes('data-section="review"'));
  });
});

test('legacy posting routes redirect to the canonical composer and hold no implementation', async (t) => {
  await withServer(t, async (baseUrl) => {
    const legacyModule = await fetch(`${baseUrl}/platform/autoposter`, { redirect: 'manual' });
    assert.equal(legacyModule.status, 302);
    assert.equal(legacyModule.headers.get('location'), '/platform/compose');

    const legacyReview = await fetch(`${baseUrl}/platform/autoposter/batches/batch-abc-123`, { redirect: 'manual' });
    assert.equal(legacyReview.status, 302);
    assert.equal(legacyReview.headers.get('location'), '/platform/compose/batch-abc-123');

    // A saved link is not a dead end: following it lands on the canonical page.
    const followed = await fetch(`${baseUrl}/platform/autoposter`);
    assert.equal(followed.status, 200);
    assert.ok((await followed.text()).includes('id="compose-form"'));
  });

  // The second composer implementation is gone, not merely unlinked.
  assert.equal(
    fs.existsSync(path.join(__dirname, '..', 'src', 'views', 'platform-autoposter.ejs')),
    false,
    'the superseded bulk-intake view must not survive as a second implementation'
  );
});

test('primary navigation offers exactly one way to create content', async (t) => {
  await withServer(t, async (baseUrl) => {
    const html = await (await fetch(`${baseUrl}/platform`)).text();
    const nav = html.slice(html.indexOf('<nav class="platform-nav"'), html.indexOf('</nav>', html.indexOf('<nav class="platform-nav"')));

    assert.equal((nav.match(/href="\/platform\/compose"/g) || []).length, 1, 'one composer entry');
    assert.doesNotMatch(nav, /\/platform\/autoposter/, 'the legacy posting entry is gone from the nav');
    assert.match(nav, /data-nav="compose"/);
  });
});

test('history stays on the dashboard surfaces and out of the composer', async (t) => {
  await withServer(t, async (baseUrl) => {
    const composer = await (await fetch(`${baseUrl}/platform/compose`)).text();
    assert.ok(!composer.includes('id="batch-list"'), 'no history list inside the composer');
    assert.doesNotMatch(composer, /Recent batches/i);

    // …and the operational surfaces that own it are still reachable and intact.
    const work = await fetch(`${baseUrl}/platform/work`);
    assert.equal(work.status, 200);
    const evidence = await fetch(`${baseUrl}/platform/evidence`);
    assert.equal(evidence.status, 200);
    // The console that owns connected channels, the release queue and publish
    // history is still declared as a customer surface.
    const modules = await (await fetch(`${baseUrl}/api/platform/modules`)).json();
    const queue = modules.modules.find((module) => module.id === 'publishing-queue');
    assert.equal(queue.href, '/private/autoposter');
    assert.match(queue.summary, /release queue, publish history/);
  });
});
