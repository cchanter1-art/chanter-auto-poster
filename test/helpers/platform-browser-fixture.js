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
batchService.listBatches = async () => ({
  batches: [
    {
      batchId: 'fixture-review-001',
      userId: 'local-browser-founder',
      status: 'ready',
      itemCount: 6,
      preparedCount: 6,
      failedCount: 0,
      acceptedCount: 0,
      videoCount: 3,
      destinationCount: 2,
      createdAt: '2026-07-29T08:30:00.000Z',
      updatedAt: '2026-07-29T08:42:00.000Z'
    },
    {
      batchId: 'fixture-running-002',
      userId: 'local-browser-founder',
      status: 'preparing',
      itemCount: 4,
      preparedCount: 2,
      failedCount: 0,
      acceptedCount: 0,
      videoCount: 2,
      destinationCount: 2,
      createdAt: '2026-07-29T08:10:00.000Z',
      updatedAt: '2026-07-29T08:39:00.000Z'
    },
    {
      batchId: 'fixture-failed-003',
      userId: 'local-browser-founder',
      status: 'attention_required',
      itemCount: 2,
      preparedCount: 1,
      failedCount: 1,
      acceptedCount: 0,
      videoCount: 2,
      destinationCount: 1,
      createdAt: '2026-07-29T07:55:00.000Z',
      updatedAt: '2026-07-29T08:15:00.000Z'
    },
    {
      batchId: 'fixture-complete-004',
      userId: 'local-browser-founder',
      status: 'completed',
      itemCount: 3,
      preparedCount: 3,
      failedCount: 0,
      acceptedCount: 3,
      videoCount: 3,
      destinationCount: 1,
      createdAt: '2026-07-29T07:20:00.000Z',
      updatedAt: '2026-07-29T07:50:00.000Z'
    }
  ]
});
batchService.listSeries = async () => ({ series: [] });
batchService.listDestinations = async () => ({ destinations: [] });

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
    externalEffects: 0
  }));
});

function stop() {
  server.close(() => process.exit(0));
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);
