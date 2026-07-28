const express = require('express');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const routes = require('./routes');
const clientRoutes = require('./clientRoutes');
const platformRoutes = require('./platformRoutes');
const runtimeControlRoutes = require('./runtimeControlRoutes');
const {
  createOperationalHistoryArchiveRouter
} = require('./operationalHistoryArchiveRoutes');
const storage = require('./storage');
const { attachUser, csrfOriginCheck, requireAdminPage, validateAdminConfig } = require('./auth');
const { attachClientSession } = require('./clientAuth');
const { validateFirebaseConfig } = require('./firestore');
const { configureCloudinary } = require('./cloudinary');
const { safeDiagnosticText } = require('./forbiddenMaterial');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);

app.use(express.urlencoded({ extended: true }));
// Agent Runtime control surface: authenticated by a dedicated service token
// (never cookies), so it mounts before the cookie/CSRF middleware — CSRF
// protects cookie sessions and would wrongly reject server-to-server calls.
app.use('/api/runtime', runtimeControlRoutes);
app.use(attachUser);
app.use(attachClientSession);
app.use(csrfOriginCheck);
app.use(
  '/autoposter-dashboard',
  requireAdminPage,
  express.static(path.join(__dirname, '..', 'public', 'autoposter-dashboard'))
);
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/uploads', requireAdminPage, express.static(config.uploadsDir));
// Client portal routes are mounted before the admin router so their more
// specific /client/* paths never fall through to admin-only middleware.
app.use('/', clientRoutes);
// Founder-only, emulator-only operational archive controls. This router
// derives owner scope from the signed admin session and never accepts a
// production Firestore project.
app.use('/', createOperationalHistoryArchiveRouter());
// CHANTER Platform shell + AutoPoster batch module (Greek-first customer
// surface). Same admin session/CSRF protections as the classic console.
app.use('/', platformRoutes);
app.use('/', routes);

app.use((error, req, res, next) => {
  if (!error) {
    next();
    return;
  }

  console.error('[server] request error', String(error.code || 'UNEXPECTED_REQUEST_ERROR'));

  const message = safeDiagnosticText(error.message || 'Unexpected server error', {
    protectedValues: [config.runtimeControl && config.runtimeControl.token]
  });
  const wantsJson =
    String(req.path || '').startsWith('/api/') ||
    String(req.headers.accept || '').toLowerCase().includes('application/json') ||
    String(req.headers['content-type'] || '').toLowerCase().includes('application/json');

  if (wantsJson) {
    res.status(error.status || 500).json({
      ok: false,
      reason: message
    });
    return;
  }

  res.redirect(`/private/autoposter?notice=${encodeURIComponent(message)}`);
});

async function start() {
  validateAdminConfig();
  fs.mkdirSync(config.uploadsDir, { recursive: true });
  // Fail fast and loud if Firebase credentials are missing/bad, instead of
  // booting a "healthy-looking" server that 500s on the first real request.
  validateFirebaseConfig();
  configureCloudinary();

  // Warn about missing optional secrets without blocking startup.
  if (typeof config.validateSecrets === 'function') {
    const warnings = config.validateSecrets();
    for (const warning of warnings) {
      console.warn(`[config] ${warning}`);
    }
  }

  await storage.ensureStorage();
  app.listen(config.port, () => {
    console.log(`${config.appName} running at http://localhost:${config.port}`);
    console.log('[scheduler] persistent mode enabled; invoke GET /api/cron/tick every minute');
  });
}

start().catch((error) => {
  console.error('[server] failed to start:', error);
  process.exit(1);
});

module.exports = app;
