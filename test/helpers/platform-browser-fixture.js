'use strict';

// Deterministic, read-only browser fixture for the six Platform shell pages.
// All data sources are local in-memory projections; no provider, cloud,
// scheduler, upload, approval, or publication path is reachable from this
// process. Production auth remains untouched because the replacement occurs
// only in this standalone test process before platformRoutes is loaded.

process.env.ADMIN_PASSWORD = 'local-browser-fixture-password';
process.env.OPENAI_API_KEY = 'local-browser-fixture-key';
process.env.FIREBASE_PROJECT_ID = 'chanter-local-browser-fixture';
process.env.FIREBASE_CLIENT_EMAIL = 'fixture@chanter-local-browser-fixture.invalid';
process.env.FIREBASE_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----\n';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8088';
process.env.RUNTIME_CONTROL_TOKEN = 'local-browser-fixture-control-token';
process.env.PLATFORM_CANONICAL_EXECUTION_ENABLED = 'false';
process.env.PLATFORM_CANONICAL_STAGING_PERSISTENT = 'false';
process.env.OPERATOR_BASE_URL = '';
process.env.ENABLE_INSTAGRAM = 'false';
process.env.YOUTUBE_ENABLED = 'false';
process.env.TIKTOK_CLIENT_KEY = '';
process.env.TIKTOK_CLIENT_SECRET = '';
process.env.YOUTUBE_CLIENT_ID = '';
process.env.YOUTUBE_CLIENT_SECRET = '';
process.env.YOUTUBE_REDIRECT_URI = '';
process.env.TOKEN_ENCRYPTION_KEY = '';
process.env.CLOUDINARY_CLOUD_NAME = '';
process.env.CLOUDINARY_API_KEY = '';
process.env.CLOUDINARY_API_SECRET = '';

const path = require('node:path');
const express = require('express');

const auth = require('../../src/auth');
auth.requireAdminPage = (req, res, next) => next();
auth.requireAdminApi = (req, res, next) => next();
auth.resolveUserId = () => 'local-browser-founder';

const firestoreModule = require('../../src/firestore');
firestoreModule.validateFirebaseConfig = () => true;
firestoreModule.getFirestore = () => ({
  collection: () => ({
    doc: () => ({
      get: async () => ({ exists: false })
    })
  })
});

const batchService = require('../../src/batchService');
const FIXTURE_BATCHES = [
  {
    batchId: 'fixture-review-001',
    userId: 'local-browser-founder',
    workspaceId: 'local-browser-workspace',
    status: 'ready',
    itemCount: 2,
    preparedCount: 2,
    failedCount: 0,
    acceptedCount: 0,
    videoCount: 1,
    destinationCount: 2,
    createdAt: '2026-07-29T08:30:00.000Z',
    updatedAt: '2026-07-29T08:42:00.000Z'
  },
  {
    batchId: 'fixture-pending-002',
    userId: 'local-browser-founder',
    workspaceId: 'local-browser-workspace',
    status: 'completed',
    itemCount: 2,
    preparedCount: 2,
    failedCount: 0,
    acceptedCount: 2,
    videoCount: 1,
    destinationCount: 2,
    createdAt: '2026-07-29T08:10:00.000Z',
    updatedAt: '2026-07-29T09:00:00.000Z'
  },
  {
    batchId: 'fixture-failed-003',
    userId: 'local-browser-founder',
    workspaceId: 'local-browser-workspace',
    status: 'completed',
    itemCount: 2,
    preparedCount: 2,
    failedCount: 0,
    acceptedCount: 2,
    videoCount: 1,
    destinationCount: 2,
    createdAt: '2026-07-29T07:55:00.000Z',
    updatedAt: '2026-07-29T09:12:00.000Z'
  },
  {
    batchId: 'fixture-verified-004',
    userId: 'local-browser-founder',
    workspaceId: 'local-browser-workspace',
    status: 'completed',
    itemCount: 2,
    preparedCount: 2,
    failedCount: 0,
    acceptedCount: 2,
    videoCount: 1,
    destinationCount: 2,
    createdAt: '2026-07-29T07:20:00.000Z',
    updatedAt: '2026-07-29T09:11:00.000Z'
  }
];

function fixtureItem(batchId, index, overrides = {}) {
  return {
    id: `${batchId}-post-${index + 1}`,
    userId: 'local-browser-founder',
    workspaceId: 'local-browser-workspace',
    batchId,
    sourceIndex: 0,
    provider: index === 0 ? 'tiktok' : 'youtube',
    providerSource: 'explicit',
    accountId: index === 0 ? 'fixture-private-account-a' : 'fixture-private-account-b',
    creationSource: '',
    runtimeGraphId: '',
    runtimeMissionId: '',
    runtimeAction: '',
    mediaType: 'video',
    caption: 'Private fixture caption that must never reach the value objective.',
    mediaPath: 'C:\\private\\fixture\\media.mp4',
    scheduledAt: '2026-07-29T09:30:00.000Z',
    status: 'scheduled',
    approved: false,
    approvalState: 'unapproved',
    approvedAt: null,
    approvedBy: '',
    history: [{ event: 'validated', at: '2026-07-29T08:31:00.000Z' }],
    lastResult: null,
    postedAt: null,
    createdAt: '2026-07-29T08:30:00.000Z',
    updatedAt: '2026-07-29T08:42:00.000Z',
    ...overrides
  };
}

function approvedFixtureItem(batchId, index, overrides = {}) {
  const approvedAt = `2026-07-29T08:4${index}:00.000Z`;
  return fixtureItem(batchId, index, {
    approved: true,
    approvalState: 'approved',
    approvedAt,
    approvedBy: 'local-browser-reviewer',
    history: [
      { event: 'validated', at: '2026-07-29T08:31:00.000Z' },
      { event: 'approved', at: approvedAt }
    ],
    updatedAt: approvedAt,
    ...overrides
  });
}

function successfulFixtureItem(batchId, index) {
  const dispatchAt = `2026-07-29T09:0${index}:00.000Z`;
  const completedAt = `2026-07-29T09:1${index}:00.000Z`;
  const approved = approvedFixtureItem(batchId, index);
  return {
    ...approved,
    status: 'posted',
    postedAt: completedAt,
    lastResult: { ok: true, mode: 'api', completedAt },
    ...(index === 1 ? { providerVerification: { verifiedAt: completedAt } } : {}),
    history: [
      ...approved.history,
      { event: 'publish_attempt', at: dispatchAt },
      { event: 'posted', at: completedAt }
    ],
    updatedAt: completedAt
  };
}

const FIXTURE_BATCH_ITEMS = new Map([
  ['fixture-review-001', [
    fixtureItem('fixture-review-001', 0),
    fixtureItem('fixture-review-001', 1)
  ]],
  ['fixture-pending-002', [
    approvedFixtureItem('fixture-pending-002', 0, {
      status: 'processing',
      history: [
        { event: 'approved', at: '2026-07-29T08:40:00.000Z' },
        { event: 'publish_attempt', at: '2026-07-29T09:00:00.000Z' }
      ],
      updatedAt: '2026-07-29T09:00:00.000Z'
    }),
    approvedFixtureItem('fixture-pending-002', 1)
  ]],
  ['fixture-failed-003', [
    approvedFixtureItem('fixture-failed-003', 0, {
      status: 'failed',
      lastResult: {
        ok: false,
        mode: 'api',
        code: 'PROVIDER_REFUSED',
        completedAt: '2026-07-29T09:12:00.000Z'
      },
      history: [
        { event: 'approved', at: '2026-07-29T08:40:00.000Z' },
        { event: 'publish_attempt', at: '2026-07-29T09:00:00.000Z' },
        { event: 'failed', at: '2026-07-29T09:12:00.000Z' }
      ],
      updatedAt: '2026-07-29T09:12:00.000Z'
    }),
    successfulFixtureItem('fixture-failed-003', 1)
  ]],
  ['fixture-verified-004', [
    successfulFixtureItem('fixture-verified-004', 0),
    successfulFixtureItem('fixture-verified-004', 1)
  ]]
]);

// An empty work list is a real, reachable state of every shell surface — it is
// what a new workspace sees — so the fixture can serve it on request instead of
// leaving the empty states unverifiable in a browser. Still read-only: this
// removes projections, it never writes or deletes anything.
const EMPTY_WORK = String(process.env.PLATFORM_BROWSER_FIXTURE_EMPTY || '') === '1';

batchService.listBatches = async () => ({ batches: EMPTY_WORK ? [] : FIXTURE_BATCHES });
batchService.getBatchView = async (context, batchId, options = {}) => {
  void context;
  if (options.autoResume !== false) {
    throw new Error('Browser value fixture must remain read-only.');
  }
  const batch = FIXTURE_BATCHES.find((record) => record.batchId === batchId);
  const items = FIXTURE_BATCH_ITEMS.get(batchId);
  if (!batch || !items) throw new Error('Fixture batch not found.');
  return { batch, items };
};
batchService.listSeries = async () => ({ series: [] });

// The composer only renders its form when at least one account is selectable,
// so exercising it in a browser needs one connected destination. It is a local
// invention that exists solely inside this process: no token, no provider
// client, and no write path is reachable from it. Off by default so the shell's
// own "no publishing-ready channel" truth stays the fixture's normal state.
const COMPOSER_DESTINATIONS = String(process.env.PLATFORM_BROWSER_FIXTURE_COMPOSER || '') === '1'
  ? [{
      provider: 'tiktok',
      providerDisplayName: 'TikTok',
      accountId: 'fixture-local-account',
      label: '@fixture.local',
      connected: true,
      publishingReady: true
    }]
  : [];
batchService.listDestinations = async () => ({ destinations: COMPOSER_DESTINATIONS });
batchService.getComposerCapabilities = async () => ({
  planId: 'fixture-local',
  multiAccountPosting: true,
  perAccountOverrides: true,
  maxDestinationsPerPost: 5,
  maxItemsPerDraft: 20,
  advancedScheduling: true,
  schedulingHorizonDays: 90
});

const providers = require('../../src/providers');
const readProviderStatus = providers.getProviderStatus;
providers.getProviderStatus = (providerId) => {
  const status = readProviderStatus(providerId);
  return status ? { ...status, configured: false, available: false } : null;
};

const platformRoutes = require('../../src/platformRoutes');
const app = express();
const root = path.join(__dirname, '..', '..');
app.set('view engine', 'ejs');
app.set('views', path.join(root, 'src', 'views'));
app.use('/platform', express.static(path.join(root, 'public', 'platform')));
app.use(express.urlencoded({ extended: true }));
app.use('/', platformRoutes);
app.use((error, req, res, next) => {
  void next;
  console.error('[platform-browser-fixture]', error && error.stack ? error.stack : error);
  res.status(500).send('Fixture render failed.');
});

const port = Number(process.env.PLATFORM_BROWSER_FIXTURE_PORT || 32147);
const server = app.listen(port, '127.0.0.1', () => {
  console.log(JSON.stringify({
    ready: true,
    url: `http://127.0.0.1:${port}/platform`,
    canonicalExecutionEnabled: false,
    emptyWork: EMPTY_WORK,
    composerDestinations: COMPOSER_DESTINATIONS.length,
    externalEffects: 0
  }));
});

function stop() {
  server.close(() => process.exit(0));
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);
