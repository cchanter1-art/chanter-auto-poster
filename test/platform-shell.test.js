'use strict';

// CHANTER Platform shell: module registry contract, canonical work-state
// projection, and live route/DOM evidence for the six top-level surfaces
// (Overview, Modules, Work, Approvals, Evidence, System health).
//
// The shell is a read-only projection, so this file fakes exactly one thing —
// the batch list read — and exercises the real router, the real views and the
// real registry over real HTTP. No provider is configured, no network mutation
// is possible, and the storage probe deliberately runs in its unconfigured
// path so the health surface is asserted on its honest "unknown" answer.

process.env.ADMIN_PASSWORD = 'test-admin-password-123';
process.env.OPENAI_API_KEY = 'test-openai-key';
process.env.ENABLE_INSTAGRAM = 'false';
process.env.YOUTUBE_ENABLED = 'false';

const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');

const platformModules = require('../src/platformModules');
const platformStatus = require('../src/platformStatus');
const batchService = require('../src/batchService');

// Auth is destructured inside platformRoutes at require time, so the session
// gate must be replaced before that require — every route under test still
// runs behind requireAdminPage/requireAdminApi in production.
const auth = require('../src/auth');
auth.requireAdminPage = (req, res, next) => next();
auth.requireAdminApi = (req, res, next) => next();
auth.resolveUserId = () => 'owner';

// Hermetic storage probe. Reporting the config as absent drives
// readConnectedHealth down its early-return path, which by contract never calls
// getFirestore — so this file proves the health surface reaches no network at
// all, and the getFirestore trap below fails the run if that ever changes.
const firestoreModule = require('../src/firestore');
firestoreModule.validateFirebaseConfig = () => {
  throw new Error('firebase is deliberately unconfigured for this test');
};
firestoreModule.getFirestore = () => {
  throw new Error('the platform shell must not reach storage during a health read');
};

const platformRoutes = require('../src/platformRoutes');

const { WORK_STATE } = platformStatus;

// One durable batch record per canonical state, in the shape
// storage.batchRecordFromDoc produces.
const BATCH_RECORDS = [
  {
    batchId: 'batch-running-0001', userId: 'owner', status: 'preparing',
    itemCount: 4, preparedCount: 1, failedCount: 0, acceptedCount: 0,
    videoCount: 2, destinationCount: 2, createdAt: '2026-07-24T09:00:00.000Z'
  },
  {
    batchId: 'batch-waiting-0002', userId: 'owner', status: 'ready',
    itemCount: 3, preparedCount: 3, failedCount: 0, acceptedCount: 0,
    videoCount: 3, destinationCount: 1, createdAt: '2026-07-24T10:00:00.000Z'
  },
  {
    batchId: 'batch-failed-0003', userId: 'owner', status: 'attention_required',
    itemCount: 2, preparedCount: 1, failedCount: 1, acceptedCount: 0,
    videoCount: 2, destinationCount: 1, createdAt: '2026-07-24T11:00:00.000Z'
  },
  {
    batchId: 'batch-donee-0004', userId: 'owner', status: 'completed',
    itemCount: 2, preparedCount: 2, failedCount: 0, acceptedCount: 2,
    videoCount: 2, destinationCount: 1, createdAt: '2026-07-24T12:00:00.000Z'
  },
  {
    batchId: 'batch-empty-0005', userId: 'owner', status: 'empty',
    itemCount: 0, preparedCount: 0, failedCount: 0, acceptedCount: 0,
    videoCount: 0, destinationCount: 1, createdAt: '2026-07-24T13:00:00.000Z'
  }
];

// ── Module registry contract ───────────────────────────────────────────────

test('module registry declares AutoPoster as the first customer module', () => {
  const customer = platformModules.listCustomerModules();
  assert.ok(customer.length >= 1);
  assert.equal(customer[0].id, 'autoposter');
  assert.equal(customer[0].href, '/platform/autoposter');
  assert.equal(customer[0].state, platformModules.STATE_ACTIVE);
});

test('module registry is broader than AutoPoster and has unique ids', () => {
  const all = platformModules.listModules();
  assert.ok(all.length > 2, 'the platform must declare more than the AutoPoster surfaces');
  assert.ok(platformModules.listInternalModules().length > 0);
  const ids = all.map((module) => module.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('internal modules expose no route from the customer surface', () => {
  for (const module of platformModules.listInternalModules()) {
    assert.equal(module.href, null, `${module.id} must not be linkable from the platform UI`);
    assert.equal(module.surface, platformModules.SURFACE_INTERNAL);
  }
});

test('every customer module points at a platform-owned route', () => {
  for (const module of platformModules.listCustomerModules()) {
    assert.match(module.href, /^\/(platform|private)\//);
  }
});

// ── Canonical work-state projection ────────────────────────────────────────

test('AutoPoster batch statuses project onto canonical platform states', () => {
  const byId = Object.fromEntries(
    BATCH_RECORDS.map((record) => [record.batchId, platformStatus.projectAutoPosterBatch(record)])
  );
  assert.equal(byId['batch-running-0001'].state, WORK_STATE.RUNNING);
  assert.equal(byId['batch-waiting-0002'].state, WORK_STATE.WAITING_APPROVAL);
  assert.equal(byId['batch-failed-0003'].state, WORK_STATE.FAILED);
  assert.equal(byId['batch-donee-0004'].state, WORK_STATE.COMPLETED);
  assert.equal(byId['batch-empty-0005'].state, WORK_STATE.IDLE);
});

test('attention_required without a failed preparation still waits on a human', () => {
  const fixable = platformStatus.projectAutoPosterBatch({
    batchId: 'batch-fixable', status: 'attention_required',
    itemCount: 2, preparedCount: 2, failedCount: 0, acceptedCount: 0
  });
  assert.equal(fixable.state, WORK_STATE.WAITING_APPROVAL);
  assert.equal(fixable.needsApproval, true);
});

test('unknown module status never claims work is running', () => {
  const unknown = platformStatus.projectAutoPosterBatch({ batchId: 'x', status: 'teleported' });
  assert.equal(unknown.state, WORK_STATE.IDLE);
  assert.match(unknown.stateReason, /teleported/);
});

test('approval is only claimed when a human actually has something to accept', () => {
  const nothingLeft = platformStatus.projectAutoPosterBatch({
    batchId: 'batch-none', status: 'ready', itemCount: 2, acceptedCount: 2
  });
  assert.equal(nothingLeft.counts.awaiting, 0);
  assert.equal(nothingLeft.needsApproval, false);
});

test('work summary counts states and sorting lifts approvals to the top', () => {
  const items = platformStatus.sortWork(BATCH_RECORDS.map(platformStatus.projectAutoPosterBatch));
  assert.equal(items[0].state, WORK_STATE.WAITING_APPROVAL);
  const summary = platformStatus.summarizeWork(items);
  assert.equal(summary.total, 5);
  assert.equal(summary.running, 1);
  assert.equal(summary.awaitingApproval, 1);
  assert.equal(summary.failed, 1);
});

test('every canonical state has a presentation and a paused slot exists', () => {
  for (const state of Object.values(WORK_STATE)) {
    const view = platformStatus.presentation(state);
    assert.ok(view.label && view.labelEn && view.chip, `${state} must be presentable`);
  }
  assert.ok(platformStatus.WORK_STATE_ORDER.includes(WORK_STATE.PAUSED));
});

// ── Live route and DOM evidence ────────────────────────────────────────────

function startServer() {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', require('node:path').join(__dirname, '..', 'src', 'views'));
  app.use(express.urlencoded({ extended: true }));
  app.use('/', platformRoutes);
  return new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
}

// Anything a shell page links to must be a customer-owned platform path. This
// is the machine-checked half of the customer/internal separation.
const ALLOWED_HREF_PREFIXES = ['/platform', '/private/autoposter'];

function hrefsIn(html) {
  return Array.from(html.matchAll(/href="([^"]+)"/g))
    .map((match) => match[1])
    .filter((href) => !href.endsWith('.css'));
}

test('platform shell serves six canonical surfaces with separated boundaries', async (t) => {
  const originalListBatches = batchService.listBatches;
  batchService.listBatches = async () => ({ batches: BATCH_RECORDS });
  const server = await startServer();
  t.after(() => {
    batchService.listBatches = originalListBatches;
    server.close();
  });

  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const paths = ['/platform', '/platform/modules', '/platform/work', '/platform/approvals', '/platform/evidence', '/platform/health'];
  const pages = {};
  for (const path of paths) {
    const response = await fetch(`${baseUrl}${path}`);
    assert.equal(response.status, 200, `${path} must render`);
    pages[path] = await response.text();
  }

  // 1. Canonical navigation is present and identical on every surface.
  for (const [path, html] of Object.entries(pages)) {
    for (const navId of ['overview', 'modules', 'work', 'approvals', 'evidence', 'health']) {
      assert.ok(html.includes(`data-nav="${navId}"`), `${path} is missing nav item ${navId}`);
    }
  }

  // 2. Each surface marks itself active exactly once.
  const activeById = {
    '/platform': 'overview',
    '/platform/modules': 'modules',
    '/platform/work': 'work',
    '/platform/approvals': 'approvals',
    '/platform/evidence': 'evidence',
    '/platform/health': 'health'
  };
  for (const [path, navId] of Object.entries(activeById)) {
    const marks = pages[path].match(/aria-current="page"/g) || [];
    assert.equal(marks.length, 1, `${path} must mark exactly one active nav item`);
    assert.match(pages[path], new RegExp(`data-nav="${navId}"[^>]*aria-current="page"`));
  }

  // 3. The platform is visibly broader than AutoPoster, and AutoPoster is a
  //    module inside it rather than the shell itself.
  assert.ok(pages['/platform'].includes('data-module="autoposter"'));
  assert.ok(pages['/platform/modules'].includes('data-module="operator"'));
  assert.ok(pages['/platform/modules'].includes('data-module="agent-runtime"'));
  assert.ok(pages['/platform'].includes('CHANTER Platform'));

  // 4. Internal modules are declared but carry no link and no control.
  const internalBlock = pages['/platform/modules'].split('data-testid="internal-modules"')[1] || '';
  assert.ok(internalBlock.includes('data-surface="internal"'));
  const internalCards = internalBlock.split('</div>\n      </div>')[0] || internalBlock;
  assert.ok(!/data-surface="internal"[^]*?href=/.test(internalCards), 'internal modules must not be linkable');

  // 5. No shell surface links anywhere outside the customer platform.
  for (const [path, html] of Object.entries(pages)) {
    for (const href of hrefsIn(html)) {
      assert.ok(
        ALLOWED_HREF_PREFIXES.some((prefix) => href.startsWith(prefix)),
        `${path} links outside the customer surface: ${href}`
      );
    }
  }

  // 6. Work surface renders every canonical state it was given.
  for (const state of [WORK_STATE.RUNNING, WORK_STATE.WAITING_APPROVAL, WORK_STATE.FAILED, WORK_STATE.COMPLETED, WORK_STATE.IDLE]) {
    assert.ok(pages['/platform/work'].includes(`data-state="${state}"`), `work surface is missing ${state}`);
  }

  // 7. Approvals shows only what a human must accept, and routes into the
  //    owning module's review page rather than approving anything itself.
  assert.ok(pages['/platform/approvals'].includes('data-work="batch-waiting-0002"'));
  assert.ok(!pages['/platform/approvals'].includes('data-work="batch-donee-0004"'));
  assert.ok(pages['/platform/approvals'].includes('/platform/autoposter/batches/batch-waiting-0002'));

  // 8. Evidence indexes every work record with its prepared/failed/accepted tally.
  for (const record of BATCH_RECORDS) {
    assert.ok(pages['/platform/evidence'].includes(`data-work="${record.batchId}"`));
  }

  // 9. Health reports the unconfigured storage probe honestly as unknown
  //    rather than as healthy, and states the approval guarantee.
  assert.ok(pages['/platform/health'].includes('data-health="storage"'));
  assert.ok(pages['/platform/health'].includes('Άγνωστη'));
  assert.ok(!pages['/platform/health'].includes('Προσβάσιμη</span>'));
  assert.ok(pages['/platform/health'].includes('data-health="approval"'));
});

test('platform shell APIs are read-only projections of the same truth', async (t) => {
  const originalListBatches = batchService.listBatches;
  batchService.listBatches = async () => ({ batches: BATCH_RECORDS });
  const server = await startServer();
  t.after(() => {
    batchService.listBatches = originalListBatches;
    server.close();
  });

  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  const modules = await (await fetch(`${baseUrl}/api/platform/modules`)).json();
  assert.equal(modules.ok, true);
  assert.equal(modules.modules[0].id, 'autoposter');
  for (const module of modules.modules.filter((entry) => entry.surface === 'internal')) {
    assert.equal(module.href, null);
  }

  const work = await (await fetch(`${baseUrl}/api/platform/work`)).json();
  assert.equal(work.ok, true);
  assert.equal(work.summary.total, 5);
  assert.equal(work.summary.awaitingApproval, 1);
  assert.equal(work.items[0].state, WORK_STATE.WAITING_APPROVAL);

  const health = await (await fetch(`${baseUrl}/api/platform/health`)).json();
  assert.equal(health.publishing.humanApprovalRequired, true);
  assert.equal(health.storage.provider, 'firestore');
  assert.ok(health.modules.internal > 0);
  assert.ok(health.observedAt);
});

test('an unreachable store degrades the shell instead of breaking or faking it', async (t) => {
  const originalListBatches = batchService.listBatches;
  batchService.listBatches = async () => {
    throw new Error('storage offline for test');
  };
  const server = await startServer();
  t.after(() => {
    batchService.listBatches = originalListBatches;
    server.close();
  });

  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  for (const path of ['/platform', '/platform/work', '/platform/approvals', '/platform/evidence', '/platform/health']) {
    const response = await fetch(`${baseUrl}${path}`);
    assert.equal(response.status, 200, `${path} must degrade, not 500`);
  }

  const workPage = await (await fetch(`${baseUrl}/platform/work`)).text();
  assert.ok(workPage.includes('data-testid="work-error"'));
  assert.ok(workPage.includes('storage offline for test'));

  const healthPage = await (await fetch(`${baseUrl}/platform/health`)).text();
  assert.ok(healthPage.includes('Άγνωστες'), 'unreadable work must not render as zero healthy work');

  const workApi = await (await fetch(`${baseUrl}/api/platform/work`)).json();
  assert.equal(workApi.ok, false);
  assert.equal(workApi.items.length, 0);
  assert.match(workApi.reason, /storage offline/);
});
