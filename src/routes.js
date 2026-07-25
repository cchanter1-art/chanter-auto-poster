const express = require('express');
const multer = require('multer');
const fs = require('fs/promises');
const path = require('path');
const { randomUUID } = require('crypto');
const config = require('./config');
const storage = require('./storage');
const applicationService = require('./autoposterApplicationService');
const scheduler = require('./scheduler');
const autoCaption = require('./autoCaption');
const autoMusic = require('./autoMusic');
const tiktok = require('./tiktok');
const instagram = require('./instagram');
const youtube = require('./youtube');
const oauthStateStore = require('./oauthStateStore');
const providers = require('./providers');
const connectedAccounts = require('./connectedAccounts');
const { sanitizePostResult } = require('./postsMapper');
const { DEFAULT_OFFSET_MINUTES } = require('./maxScheduler');
const { summarizeCampaigns, latestCampaignChannelCount } = require('./campaignAccounting');
const clientRoutes = require('./clientRoutes');
const {
  VIDEO_ONLY_UPLOAD_MESSAGE,
  isVideoUploadFile
} = require('./mediaPolicy');
const {
  clearAdminSessionCookie,
  requireAdminApi,
  requireAdminOAuth,
  requireAdminPage,
  resolveUserId,
  safeReturnTo,
  setAdminSessionCookie,
  verifyAdminPassword
} = require('./auth');

const router = express.Router();
const ACTIVE_TIKTOK_ACCOUNT_COOKIE = 'autoposter_tiktok_account_id';
const loginAttempts = new Map();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 5;

const upload = multer({
  storage: multer.diskStorage({
    destination: config.uploadsDir,
    filename: (req, file, callback) => {
      const extension = path.extname(file.originalname || '').toLowerCase() || defaultExtension(file);
      callback(null, `${Date.now()}-${randomUUID()}${extension}`);
    }
  }),
  fileFilter: (req, file, callback) => {
    if (isVideoUploadFile(file)) { callback(null, true); return; }
    const error = new Error(VIDEO_ONLY_UPLOAD_MESSAGE);
    error.status = 400;
    callback(error);
  },
  limits: { files: 100, fileSize: 250 * 1024 * 1024 }
});

// Wraps upload.array so a rejected file (e.g. an image) produces the same
// notice/JSON contract as every other intake validation failure, instead
// of falling through to the generic error middleware.
function uploadCampaignMedia(req, res, next) {
  upload.array('images')(req, res, (error) => {
    if (error) {
      respondWithNotice(req, res, error.message || 'Upload failed.', false);
      return;
    }
    next();
  });
}

const autoCaptionUpload = multer({
  storage: multer.diskStorage({
    destination: config.uploadsDir,
    filename: (req, file, callback) => {
      const extension = path.extname(file.originalname || '').toLowerCase() || defaultExtension(file);
      callback(null, `caption-${Date.now()}-${randomUUID()}${extension}`);
    }
  }),
  fileFilter: (req, file, callback) => {
    const mime = String(file.mimetype || '').toLowerCase();
    const extension = path.extname(file.originalname || '').toLowerCase();
    if (mime.startsWith('video/') || ['.mp4', '.mov', '.webm'].includes(extension)) {
      callback(null, true);
      return;
    }
    callback(new Error('Auto Caption requires an MP4, MOV, or WebM video.'));
  },
  limits: { files: 1, fileSize: 250 * 1024 * 1024 }
});

function defaultExtension(file) {
  const mime = String(file.mimetype || '').toLowerCase();
  if (mime === 'video/mp4') return '.mp4';
  if (mime === 'video/quicktime') return '.mov';
  if (mime === 'video/webm') return '.webm';
  if (mime === 'image/png') return '.png';
  if (mime === 'image/webp') return '.webp';
  return '.jpg';
}

// Firestore calls are async; Express 4 won't forward a rejected promise to
// the error middleware on its own, so every handler that awaits storage/
// tiktok/instagram is wrapped in this instead of being declared directly
// as the route callback.
function asyncRoute(handler) {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}

function websiteContext(req, options = {}) {
  const userId = resolveUserId(req);
  const requestedWorkspaceId = String(
    options.workspaceId
    || (req.commercialContext && req.commercialContext.workspace && req.commercialContext.workspace.workspaceId)
    || req.get('x-chanter-workspace-id')
    || req.query.workspaceId
    || ''
  ).trim();
  return applicationService.createExecutionContext({
    userId,
    actorId: options.actorId || `admin:${userId}`,
    accountId: options.accountId || '',
    source: 'website',
    workspaceId: requestedWorkspaceId,
    commercialContext: options.commercialContext || req.commercialContext || null,
    correlationId: req.get('x-request-id') || req.get('x-correlation-id') || '',
    approval: options.approval || null,
    idempotency: { key: options.idempotencyKey || '' }
  });
}

async function resolveWebsiteCommercialContext(req, options = {}) {
  if (req.commercialContext && !options.workspaceId) {
    return { commercialContext: req.commercialContext, view: req.commercialView };
  }
  const resolved = await applicationService.getPlanUsage(websiteContext(req, options));
  req.commercialContext = resolved.commercialContext;
  req.commercialView = resolved.view;
  return resolved;
}

function requestWorkspaceScope(req) {
  return req.commercialContext ? req.commercialContext.workspaceScope : undefined;
}

// Release Queue view mode: "active" (today's behavior, scoped to the
// currently selected TikTok channel) or "all" (every channel, grouped by
// campaign). Both reads go through the shared listQueue operation.
function resolveQueueView(req, allPosts) {
  const requested = String(req.query.queueView || '').trim().toLowerCase();
  if (requested === 'all' || requested === 'active') return requested;
  // The "active" view is scoped to the active TIKTOK channel, which would
  // hide YouTube jobs entirely — default to the all-channels view whenever
  // any non-TikTok job exists in the queue.
  if ((Array.isArray(allPosts) ? allPosts : []).some((post) => post && post.provider === 'youtube')) return 'all';
  return latestCampaignChannelCount(allPosts) > 1 ? 'all' : 'active';
}

const renderAutoPoster = asyncRoute(async (req, res) => {
  const userId = resolveUserId(req);
  const { view: commercialView } = await resolveWebsiteCommercialContext(req);
  const { accounts, activeAccount } = await resolveTikTokAccountContext(req, res);
  const activeAccountId = activeAccount ? activeAccount.accountId : '';
  const context = websiteContext(req);
  const activeQueue = activeAccountId
    ? await applicationService.listQueue(context, { accountId: activeAccountId, limit: 1000 })
    : { items: [], counts: emptyPostCounts() };
  const allQueue = await applicationService.listQueue(context, { limit: 1000 });
  const activeAccountPosts = activeQueue.items;
  const allPosts = allQueue.items;
  const queueView = resolveQueueView(req, allPosts);
  const posts = queueView === 'all' ? allPosts : activeAccountPosts;
  const tiktokAuthStatus = await tiktok.getTikTokAuthStatus(
    activeAccountId,
    userId,
    requestWorkspaceScope(req)
  );
  const instagramStatus = config.ENABLE_INSTAGRAM
    ? await instagram.getInstagramAuthStatus()
    : null;
  const instagramHealth = await instagram.getInstagramHealth();
  const creatorInfo = tiktokAuthStatus.connected
    ? (await getCreatorInfoSafe(activeAccountId, userId, requestWorkspaceScope(req))) || creatorInfoFromAccount(activeAccount)
    : creatorInfoFromAccount(activeAccount);

  // Refresh stored profile when TikTok reports a renamed handle.
  if (creatorInfo && creatorInfo.creator_username && activeAccount
      && creatorInfo.creator_username !== activeAccount.username) {
    const profile = {
      username: creatorInfo.creator_username,
      displayName: creatorInfo.creator_nickname || '',
      avatarUrl: creatorInfo.creator_avatar_url || ''
    };
    try {
      await storage.updateTikTokAccountProfile(
        userId,
        activeAccount.accountId,
        profile,
        requestWorkspaceScope(req)
      );
    } catch (refreshError) {
      console.warn('[routes] profile refresh after render load failed', refreshError.message);
    }
    activeAccount.username = profile.username;
    activeAccount.displayName = profile.displayName;
    activeAccount.avatarUrl = profile.avatarUrl;
    // activeAccount is a reference into the accounts array, so mutating it
    // updates the Switch Channel dropdown and Target Publishing Channels too.
  }

  // Canonical connected-account/provider readiness for the active channel,
  // resolved through the same shared application service the Agent Runtime
  // uses. The account view is the safe connected-account shape — no tokens.
  let channelReadiness = null;
  if (activeAccount) {
    try {
      const resolved = await applicationService.getConnectedAccount(context, { accountId: activeAccountId });
      const connectedAccount = resolved.account;
      channelReadiness = {
        provider: resolved.provider,
        account: connectedAccount,
        connectionLabel: connectedAccount.connectionStatus === 'connected'
          ? 'Connected'
          : (connectedAccount.connectionStatus === 'reauthorization_required'
              ? 'Reauthorization required'
              : 'Disconnected'),
        publishingLabel: connectedAccount.publishingReady
          ? 'Ready to publish'
          : connectedAccounts.describeReadinessBlocker(connectedAccount.readinessBlockers[0]),
        lastVerifiedAt: connectedAccount.lastVerifiedAt
      };
    } catch (readinessError) {
      console.warn('[routes] connected-account readiness unavailable', readinessError.message);
    }
  }

  // YouTube provider truth for the site: deployment-level status
  // (implemented / configured / available) plus the safe connected-account
  // views. Rendered truthfully in every state — an unconfigured provider
  // shows as unavailable, never as a fake Connect button.
  const youtubeProvider = providers.getProviderStatus(providers.PROVIDER_YOUTUBE);
  let youtubeChannels = [];
  try {
    youtubeChannels = await resolveYouTubeChannelViews(userId, requestWorkspaceScope(req));
  } catch (youtubeError) {
    console.warn('[routes] YouTube channels unavailable', youtubeError.message);
  }

  res.render('index', {
    appName: config.appName,
    posts,
    queueView,
    campaignSummaries: queueView === 'all' ? summarizeCampaigns(posts) : [],
    todayPost: getTodayPost(posts),
    settings: await storage.getSettings(),
    counts: queueView === 'all' ? allQueue.counts : activeQueue.counts,
    notice: req.query.notice || '',
    tiktokConfigured: tiktokAuthStatus.connected,
    tiktokAuthStatus,
    tiktokAccounts: accounts.map(publicTikTokAccount),
    activeTikTokAccount: activeAccount ? publicTikTokAccount(activeAccount) : null,
    channelReadiness,
    youtubeProvider,
    youtubeChannels,
    enableInstagram: config.ENABLE_INSTAGRAM,
    autoCaptionConfigured: autoCaption.hasConfiguredCaptionProvider(),
    autoMusicConfigured: autoMusic.isAutoMusicConfigured(),
    defaultOffsetMinutes: DEFAULT_OFFSET_MINUTES,
    instagramStatus,
    instagramHealth,
    creatorInfo,
    commercialView,
    helpers: viewHelpers
  });
});

router.get('/admin-login', (req, res) => {
  if (req.isAdmin) {
    res.redirect(safeReturnTo(req.query.returnTo));
    return;
  }
  res.set('Cache-Control', 'no-store');
  res.render('admin-login', {
    appName: config.appName,
    error: '',
    notice: String(req.query.notice || ''),
    returnTo: safeReturnTo(req.query.returnTo)
  });
});

router.post('/admin-login', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const attempt = getLoginAttempt(req.ip);
  const returnTo = safeReturnTo(req.body.returnTo);
  if (attempt.locked) {
    res.status(429).render('admin-login', {
      appName: config.appName,
      error: 'Too many login attempts. Try again in 15 minutes.',
      notice: '',
      returnTo
    });
    return;
  }

  if (!verifyAdminPassword(req.body.password)) {
    recordFailedLogin(req.ip);
    res.status(401).render('admin-login', {
      appName: config.appName,
      error: 'Incorrect admin password.',
      notice: '',
      returnTo
    });
    return;
  }

  loginAttempts.delete(req.ip);
  setAdminSessionCookie(req, res);
  res.redirect(returnTo);
});

router.post('/logout', requireAdminPage, (req, res) => {
  clearAdminSessionCookie(req, res);
  res.clearCookie(ACTIVE_TIKTOK_ACCOUNT_COOKIE);
  res.redirect('/admin-login?notice=You+have+been+logged+out.');
});

router.get('/', requireAdminPage, renderAutoPoster);
router.get('/private/autoposter', requireAdminPage, renderAutoPoster);

router.get('/private/autoposter/dashboard', requireAdminPage, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'autoposter-dashboard', 'dashboard.html'));
});

router.get('/api/private/autoposter/dashboard', requireAdminApi, asyncRoute(async (req, res) => {
  const { view: commercial } = await resolveWebsiteCommercialContext(req);
  const [queue, accountContext, youtubeChannels] = await Promise.all([
    applicationService.listQueue(websiteContext(req), { limit: 1000 }),
    resolveTikTokAccountContext(req, res),
    // TikTok truth must still render when YouTube storage is unreachable.
    resolveYouTubeChannelViews(resolveUserId(req), requestWorkspaceScope(req)).catch((youtubeError) => {
      console.warn('[routes] YouTube channels unavailable for dashboard', youtubeError.message);
      return [];
    })
  ]);
  const jobs = queue.items;
  const { accounts, activeAccount } = accountContext;
  const selectedAccountId = activeAccount ? activeAccount.accountId : '';

  res.set('Cache-Control', 'no-store');
  res.json({
    ok: true,
    accounts: [
      ...accounts.map(publicTikTokAccount),
      ...youtubeChannels.map(publicYouTubeChannel)
    ],
    selectedAccountId,
    jobs,
    commercial,
    appTimeZone: config.appTimeZone
  });
}));

router.get('/health', asyncRoute(async (req, res) => {
  const schedulerHealth = await scheduler.getSchedulerHealth();
  res.json({
    ok: true,
    app: config.appName,
    uptimeSeconds: Math.round(process.uptime()),
    currentTime: new Date().toISOString(),
    appTimeZone: config.appTimeZone,
    scheduler: scheduler.getSchedulerState(),
    schedulerHealth,
    cronTrigger: Boolean(config.cronSecret),
    autoCaptionConfigured: autoCaption.hasConfiguredCaptionProvider(),
    autoMusicConfigured: autoMusic.isAutoMusicConfigured()
  });
}));

router.get('/api/storage/health', asyncRoute(async (req, res) => {
  if (!authorizeCronRequest(req, res, 'debug')) return;

  const result = await storage.checkMediaStorageHealth({ writeTest: req.query.write === '1' });
  res.status(result.ok ? 200 : 503).json(result);
}));

router.get('/api/cron/tick', asyncRoute(runCronTick));

// Compatibility endpoint for existing Render cron jobs during deployment.
router.get('/run-scheduler', asyncRoute(runCronTick));

router.get('/api/debug/jobs', asyncRoute(async (req, res) => {
  if (!authorizeCronRequest(req, res, 'debug')) return;
  const requestedLimit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
  const workspaceId = String(
    req.get('x-chanter-workspace-id') || req.query.workspaceId || ''
  ).trim();
  const queue = await applicationService.listQueue(
    applicationService.createExecutionContext({
      userId: resolveUserId(req),
      actorId: 'cron-debug',
      source: 'internal_worker',
      workspaceId
    }),
    { limit: requestedLimit }
  );
  const jobs = queue.items;
  res.json({
    ok: true,
    scope: queue.scope,
    jobs: jobs.map((job) => ({
      id: job.id,
      status: job.status,
      scheduledAt: job.scheduledAt,
      title: firstNonEmptyLine(job.caption) || job.originalName || job.fileName || 'Untitled',
      privacy: job.privacyLevel,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt
    }))
  });
}));

router.post('/private/autoposter/account', requireAdminPage, asyncRoute(async (req, res) => {
  await resolveWebsiteCommercialContext(req);
  const userId = resolveUserId(req);
  const accountId = String(req.body.accountId || '').trim();
  const account = await storage.getTikTokAccount(userId, accountId, requestWorkspaceScope(req));
  if (!account) {
    redirectWithNotice(res, 'TikTok account not found.');
    return;
  }
  setActiveTikTokAccountCookie(res, account.accountId);
  redirectWithNotice(res, `Active TikTok account changed to ${accountLabel(account)}.`);
}));

// Generates a brand-new client access code for one TikTok account and
// shows it exactly once, in the response body (never in a URL/query
// string, which would leak into browser history and server access logs).
// Only the code's hash is ever persisted — see storage.generateClientAccessCode.
router.post('/private/autoposter/account/:accountId/client-access', requireAdminPage, asyncRoute(async (req, res) => {
  await resolveWebsiteCommercialContext(req);
  const userId = resolveUserId(req);
  const accountId = String(req.params.accountId || '').trim();
  const code = await storage.generateClientAccessCode(userId, accountId, requestWorkspaceScope(req));
  if (!code) {
    redirectWithNotice(res, 'TikTok account not found.');
    return;
  }
  const account = await storage.getTikTokAccount(userId, accountId, requestWorkspaceScope(req));
  res.set('Cache-Control', 'no-store');
  res.render('client-access-generated', {
    appName: config.appName,
    account,
    code,
    accountLabelText: accountLabel(account)
  });
}));

router.post('/private/autoposter/account/:accountId/client-access/revoke', requireAdminPage, asyncRoute(async (req, res) => {
  await resolveWebsiteCommercialContext(req);
  const userId = resolveUserId(req);
  const accountId = String(req.params.accountId || '').trim();
  const revoked = await storage.revokeClientAccessCode(userId, accountId, requestWorkspaceScope(req));
  redirectWithNotice(res, revoked ? 'Client access revoked. The old code no longer works.' : 'TikTok account not found.');
}));

router.get('/connect/tiktok', requireAdminPage, asyncRoute(async (req, res) => {
  if (!config.tiktok.clientKey || !config.tiktok.clientSecret || !config.tiktok.redirectUri) {
    redirectWithNotice(res, 'Add TikTok client key, secret, and redirect URI to .env first.');
    return;
  }
  const authorization = await applicationService.authorizeAccountConnection(
    websiteContext(req),
    { provider: 'tiktok', accountId: '' }
  );
  req.commercialContext = authorization.commercialContext;
  const userId = resolveUserId(req);
  const state = await oauthStateStore.createOAuthState({
    userId,
    provider: 'tiktok',
    returnTo: '/',
    mode: 'connect',
    workspaceId: authorization.commercialContext.workspace.workspaceId
  });
  // Clear only this browser's selected-account state. Existing account
  // records, tokens, jobs, and history remain untouched in Firestore.
  res.clearCookie(ACTIVE_TIKTOK_ACCOUNT_COOKIE);
  res.cookie('tiktok_oauth_state', state, { httpOnly: true, sameSite: 'lax', maxAge: 10 * 60 * 1000 });
  res.redirect(tiktok.buildTikTokAuthUrl(state));
}));

// TikTok's redirect_uri is a single fixed URL (config.tiktok.redirectUri),
// so it's shared by the admin "connect a channel" flow below and the
// client "reconnect my channel" flow in clientRoutes.js. The client flow
// sets its own state cookie before redirecting to TikTok; if that cookie
// is present, this dispatches to the client's isolated handler (which
// enforces its own session + fail-closed account re-check) instead of
// running the admin logic. Everything below this check is the original,
// unmodified admin-only flow.
router.get('/auth/tiktok/callback', asyncRoute(async (req, res) => {
  if (parseCookies(req.headers.cookie)[clientRoutes.CLIENT_OAUTH_STATE_COOKIE]) {
    await clientRoutes.handleTikTokReconnectCallback(req, res);
    return;
  }
  if (!req.isAdmin) {
    res.redirect('/admin-login?notice=Your+admin+session+expired.+Log+in+and+connect+TikTok+again.');
    return;
  }
  const expectedState = parseCookies(req.headers.cookie).tiktok_oauth_state;
  res.clearCookie('tiktok_oauth_state');
  const userId = resolveUserId(req);
  const consumed = await oauthStateStore.consumeOAuthState(String(req.query.state || ''), {
    userId,
    provider: 'tiktok'
  });
  if (req.query.error) {
    redirectWithNotice(res, `TikTok connection failed: ${req.query.error_description || req.query.error}`);
    return;
  }
  if (!req.query.code || !req.query.state || req.query.state !== expectedState || !consumed.ok) {
    redirectWithNotice(res, 'TikTok connection failed: invalid OAuth state.');
    return;
  }
  try {
    await resolveWebsiteCommercialContext(req, { workspaceId: consumed.record.workspaceId });
    const auth = await tiktok.exchangeCodeForToken(String(req.query.code));
    const activation = await applicationService.authorizeAccountConnection(
      websiteContext(req),
      { provider: 'tiktok', accountId: auth.open_id }
    );
    let account = await storage.saveTikTokAccount(
      userId,
      auth,
      {},
      requestWorkspaceScope(req),
      activation.activationContext
    );
    try {
      const profile = await tiktok.queryCreatorInfo(account.accountId, userId, requestWorkspaceScope(req));
      account = await storage.updateTikTokAccountProfile(
        userId,
        account.accountId,
        profile,
        requestWorkspaceScope(req)
      ) || account;
    } catch (profileError) {
      console.warn('[routes] TikTok profile unavailable after OAuth', profileError.message);
    }
    setActiveTikTokAccountCookie(res, account.accountId);
    redirectWithNotice(res, `TikTok account ${accountLabel(account)} connected and selected.`);
  } catch (error) {
    redirectWithNotice(res, `TikTok connection failed: ${error.message}`);
  }
}));

router.get('/disconnect/tiktok', requireAdminPage, asyncRoute(async (req, res) => {
  await resolveWebsiteCommercialContext(req);
  const userId = resolveUserId(req);
  const { activeAccount } = await resolveTikTokAccountContext(req, res);
  if (!activeAccount) {
    redirectWithNotice(res, 'No TikTok account is selected.');
    return;
  }
  await storage.disconnectTikTokAccount(userId, activeAccount.accountId, requestWorkspaceScope(req));
  res.clearCookie(ACTIVE_TIKTOK_ACCOUNT_COOKIE);
  redirectWithNotice(res, `${accountLabel(activeAccount)} disconnected. Its jobs and history were preserved.`);
}));

// ── YouTube (Provider #2) connection lifecycle ───────────────────────────
// Server-side Google OAuth authorization-code flow with PKCE (S256). The
// OAuth state is a cryptographically random, single-use, short-lived
// SERVER-SIDE record (oauthStateStore) bound to the authenticated admin
// user, the provider, the validated internal return path, the PKCE
// verifier, and — for reauthorize — the intended channel. A browser cookie
// carries the same opaque id as defense in depth. The Client Secret and
// authorization codes never reach views, logs, JSON, or the browser.

const YOUTUBE_OAUTH_STATE_COOKIE = 'youtube_oauth_state';

router.get('/connect/youtube', requireAdminPage, asyncRoute(async (req, res) => {
  const status = youtube.getYouTubeConfigStatus();
  if (!status.configured) {
    redirectWithNotice(res, 'YouTube is not configured on this deployment yet, so connection is disabled.');
    return;
  }
  await resolveWebsiteCommercialContext(req);
  const userId = resolveUserId(req);
  const reauthorizeId = String(req.query.reauthorize || '').trim();
  let mode = 'connect';
  // prompt=consent is requested ONLY when a refresh token must be obtained
  // or restored — never on a normal reconnect that already has one.
  let forceConsent = false;
  if (reauthorizeId) {
    const account = await storage.getYouTubeAccount(userId, reauthorizeId, requestWorkspaceScope(req));
    if (!account) {
      redirectWithNotice(res, 'YouTube channel not found.');
      return;
    }
    mode = 'reauthorize';
    forceConsent = !account.refreshTokenPresent || Boolean(account.reauthorizationRequired);
  } else {
    const accounts = await storage.getYouTubeAccounts(userId, requestWorkspaceScope(req));
    forceConsent = !accounts.some((account) => account.refreshTokenPresent);
  }
  await applicationService.authorizeAccountConnection(
    websiteContext(req),
    { provider: 'youtube', accountId: reauthorizeId }
  );
  const pkce = youtube.createPkcePair();
  const state = await oauthStateStore.createOAuthState({
    userId,
    provider: 'youtube',
    returnTo: safeReturnTo(req.query.returnTo),
    codeVerifier: pkce.verifier,
    mode,
    accountId: reauthorizeId,
    workspaceId: req.commercialContext.workspace.workspaceId
  });
  res.cookie(YOUTUBE_OAUTH_STATE_COOKIE, state, { httpOnly: true, sameSite: 'lax', maxAge: 10 * 60 * 1000 });
  res.redirect(youtube.buildYouTubeAuthUrl(state, { codeChallenge: pkce.challenge, forceConsent }));
}));

router.get('/auth/youtube/callback', requireAdminOAuth, asyncRoute(async (req, res) => {
  const userId = resolveUserId(req);
  const cookieState = parseCookies(req.headers.cookie)[YOUTUBE_OAUTH_STATE_COOKIE] || '';
  res.clearCookie(YOUTUBE_OAUTH_STATE_COOKIE);
  const queryState = String(req.query.state || '');

  // Consume — and thereby permanently invalidate — the server-side state
  // before anything else: whatever happens next, this value is spent.
  // Missing, altered, expired, replayed, and cross-user states all land in
  // the same truthful rejection.
  const consumed = await oauthStateStore.consumeOAuthState(queryState, { userId, provider: 'youtube' });

  if (req.query.error) {
    redirectWithNotice(res, `YouTube connection failed: ${String(req.query.error_description || req.query.error).slice(0, 200)}`);
    return;
  }
  if (!consumed.ok || !cookieState || cookieState !== queryState) {
    redirectWithNotice(res, 'YouTube connection failed: invalid OAuth state.');
    return;
  }
  if (!req.query.code) {
    redirectWithNotice(res, 'YouTube connection failed: Google returned no authorization code.');
    return;
  }
  const record = consumed.record;
  await resolveWebsiteCommercialContext(req, { workspaceId: record.workspaceId });
  const returnTo = safeReturnTo(record.returnTo);

  try {
    const exchanged = await youtube.exchangeCodeForToken(String(req.query.code), record.codeVerifier);
    const channels = await youtube.listMyChannels(exchanged.tokens.access_token);

    if (channels.length === 0) {
      redirectWithNotice(res, 'YouTube connection failed: this Google account has no YouTube channel, so nothing was connected.');
      return;
    }

    if (record.mode === 'reauthorize' && record.accountId) {
      const match = channels.find((channel) => channel.channelId === record.accountId);
      if (!match) {
        redirectWithNotice(res, 'YouTube reauthorization failed: the Google account you authorized does not include the channel being reauthorized. Nothing was changed.');
        return;
      }
      const activation = await applicationService.authorizeAccountConnection(
        websiteContext(req),
        { provider: 'youtube', accountId: match.channelId }
      );
      const finalized = await youtube.finalizeYouTubeConnection({
        userId,
        channel: match,
        tokens: exchanged.tokens,
        meta: exchanged.meta,
        workspaceScope: requestWorkspaceScope(req),
        activationContext: activation.activationContext
      });
      redirectWithYouTubeConnectNotice(res, returnTo, finalized);
      return;
    }

    if (channels.length === 1) {
      const activation = await applicationService.authorizeAccountConnection(
        websiteContext(req),
        { provider: 'youtube', accountId: channels[0].channelId }
      );
      const finalized = await youtube.finalizeYouTubeConnection({
        userId,
        channel: channels[0],
        tokens: exchanged.tokens,
        meta: exchanged.meta,
        workspaceScope: requestWorkspaceScope(req),
        activationContext: activation.activationContext
      });
      redirectWithYouTubeConnectNotice(res, returnTo, finalized);
      return;
    }

    // Multiple channels (brand accounts): park the ENCRYPTED credentials in
    // a short-lived, single-use, server-side selection transaction bound to
    // this user. The follow-up POST may only pick a channel Google actually
    // returned in this authorization.
    const selectionId = await oauthStateStore.createChannelSelection({
      userId,
      provider: 'youtube',
      returnTo,
      mode: record.mode,
      accountId: record.accountId,
      workspaceId: record.workspaceId,
      channels,
      credentialEnvelope: youtube.encryptTokens(exchanged.tokens),
      tokenMeta: exchanged.meta
    });
    res.set('Cache-Control', 'no-store');
    res.render('youtube-select-channel', {
      appName: config.appName,
      selectionId,
      channels
    });
  } catch (error) {
    // Adapter errors are already normalized and safe — never the
    // authorization code, tokens, or a raw Google response body.
    redirectWithNotice(res, `YouTube connection failed: ${error.message}`);
  }
}));

router.post('/connect/youtube/select', requireAdminPage, asyncRoute(async (req, res) => {
  const userId = resolveUserId(req);
  const selectionId = String(req.body.selectionId || '').trim();
  const channelId = String(req.body.channelId || '').trim();
  const consumed = await oauthStateStore.consumeChannelSelection(selectionId, { userId, provider: 'youtube' });
  if (!consumed.ok) {
    redirectWithNotice(res, 'YouTube channel selection expired or was already used. Connect YouTube again.');
    return;
  }
  const record = consumed.record;
  await resolveWebsiteCommercialContext(req, { workspaceId: record.workspaceId });
  const channel = (Array.isArray(record.channels) ? record.channels : [])
    .find((entry) => entry && entry.channelId === channelId);
  if (!channel) {
    redirectWithNotice(res, 'YouTube connection failed: the selected channel was not part of this authorization. Connect YouTube again.');
    return;
  }
  if (record.mode === 'reauthorize' && record.accountId && record.accountId !== channel.channelId) {
    redirectWithNotice(res, 'YouTube reauthorization failed: a different channel cannot replace the one being reauthorized.');
    return;
  }
  let tokens;
  try {
    tokens = youtube.decryptTokens(record.credentialEnvelope);
  } catch (error) {
    redirectWithNotice(res, 'YouTube connection failed: the stored authorization could not be read. Connect YouTube again.');
    return;
  }
  try {
    const activation = await applicationService.authorizeAccountConnection(
      websiteContext(req),
      { provider: 'youtube', accountId: channel.channelId }
    );
    const finalized = await youtube.finalizeYouTubeConnection({
      userId,
      channel,
      tokens,
      meta: record.tokenMeta || {},
      workspaceScope: requestWorkspaceScope(req),
      activationContext: activation.activationContext
    });
    redirectWithYouTubeConnectNotice(res, safeReturnTo(record.returnTo), finalized);
  } catch (error) {
    redirectWithNotice(res, `YouTube connection failed: ${error.message}`);
  }
}));

// Deliberate POST-only disconnect (CSRF-protected by the global
// origin check). Google-side revocation is attempted first, but local
// credentials are removed regardless of the revocation outcome, so a
// failed revocation can never leave a usable stored token behind.
router.post('/disconnect/youtube', requireAdminPage, asyncRoute(async (req, res) => {
  await resolveWebsiteCommercialContext(req);
  const userId = resolveUserId(req);
  const accountId = String(req.body.accountId || '').trim();
  const account = await storage.getYouTubeAccount(userId, accountId, requestWorkspaceScope(req));
  if (!account) {
    redirectWithNotice(res, 'YouTube channel not found.');
    return;
  }

  let revocation = { revoked: false, reason: 'No stored credentials.' };
  const envelope = await storage.getYouTubeAccountCredential(userId, accountId, requestWorkspaceScope(req));
  if (envelope) {
    try {
      const tokens = youtube.decryptTokens(envelope);
      revocation = await youtube.revokeToken(tokens.refresh_token || tokens.access_token);
    } catch (error) {
      revocation = { revoked: false, reason: 'Stored credentials could not be decrypted for revocation.' };
    }
  }
  await storage.disconnectYouTubeAccount(userId, accountId, requestWorkspaceScope(req));
  const label = youtubeChannelLabel(account);
  redirectWithNotice(res, revocation.revoked
    ? `YouTube channel ${label} disconnected and its Google access was revoked. Jobs and history were preserved.`
    : `YouTube channel ${label} disconnected locally, but Google-side revocation did not complete (${revocation.reason || 'unknown reason'}). You can also remove access at myaccount.google.com/permissions.`);
}));

// Safe status lookup for one uploaded video (youtube.readonly). Ownership
// is enforced by the shared getPostStatus operation; the response contains
// normalized safe fields only.
router.get('/api/youtube/posts/:postId/status', requireAdminApi, asyncRoute(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  let post;
  try {
    ({ post } = await applicationService.getPostStatus(websiteContext(req), { postId: req.params.postId }));
  } catch (error) {
    if (error instanceof applicationService.AutoPosterApplicationError) {
      res.status(error.status).json({ ok: false, reason: error.message });
      return;
    }
    throw error;
  }
  if (post.provider !== 'youtube' || !post.publishId) {
    res.status(400).json({ ok: false, reason: 'This job has no YouTube video to look up.' });
    return;
  }
  const status = await youtube.getUploadedVideoStatus({
    userId: resolveUserId(req),
    accountId: post.accountId,
    videoId: post.publishId,
    workspaceScope: requestWorkspaceScope(req)
  });
  res.status(status.ok ? 200 : 400).json(status);
}));

router.get('/auth/instagram/start', requireAdminPage, (req, res) => {
  if (!instagram.hasOAuthConfig()) {
    redirectWithNotice(res, 'Add Meta app ID, app secret, and redirect URI to .env first.');
    return;
  }
  const state = randomUUID();
  res.cookie('instagram_oauth_state', state, { httpOnly: true, sameSite: 'lax', maxAge: 10 * 60 * 1000 });
  res.redirect(instagram.buildInstagramAuthUrl(state));
});

router.get('/auth/instagram/callback', requireAdminOAuth, asyncRoute(async (req, res) => {
  const expectedState = parseCookies(req.headers.cookie).instagram_oauth_state;
  res.clearCookie('instagram_oauth_state');
  if (req.query.error) {
    redirectWithNotice(res, `Instagram connection failed: ${req.query.error_description || req.query.error}`);
    return;
  }
  if (!req.query.code || !req.query.state || req.query.state !== expectedState) {
    redirectWithNotice(res, 'Instagram connection failed: invalid OAuth state.');
    return;
  }
  try {
    const auth = await instagram.exchangeCodeForToken(String(req.query.code));
    await storage.saveInstagramAuth(auth);
    redirectWithNotice(res, 'Instagram connected.');
  } catch (error) {
    redirectWithNotice(res, `Instagram connection failed: ${error.message}`);
  }
}));

router.get('/disconnect/instagram', requireAdminPage, asyncRoute(async (req, res) => {
  await storage.clearInstagramAuth();
  redirectWithNotice(res, 'Instagram disconnected.');
}));

router.get('/api/instagram/health', asyncRoute(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(await instagram.getInstagramHealth());
}));

router.get('/api/instagram/status', requireAdminApi, asyncRoute(async (req, res) => {
  const status = await instagram.getInstagramAuthStatus();
  const containerId = String(req.query.containerId || '').trim();
  if (!containerId) { res.json({ ok: true, instagram: status }); return; }
  try {
    const container = await instagram.getContainerStatus(containerId);
    res.json({ ok: true, instagram: status, container });
  } catch (error) {
    res.status(400).json({ ok: false, instagram: status, reason: error.message, response: error.response || null });
  }
}));

router.post('/api/instagram/publish', requireAdminApi, express.json({ limit: '1mb' }), asyncRoute(async (req, res) => {
  await resolveWebsiteCommercialContext(req);
  const userId = resolveUserId(req);
  const payload = { ...(req.body || {}), postId: String((req.body && req.body.postId) || '').trim(), userId };
  try {
    const result = await instagram.publishInstagramMedia(payload);
    const safeResult = sanitizePostResult(result) || { ok: Boolean(result && result.ok), mode: 'api' };
    await saveInstagramAttempt(userId, payload.postId, safeResult, requestWorkspaceScope(req));
    if (result.code === 'INSTAGRAM_NOT_CONFIGURED' && wantsJson(req)) {
      res.status(503).json({
        success: false,
        platform: 'instagram',
        code: result.code,
        message: result.message,
        missing: result.missing
      });
      return;
    }
    if (wantsJson(req)) { res.status(result.ok ? 200 : 400).json({ ok: result.ok, result: safeResult }); return; }
    redirectWithNotice(res, instagramNotice(result));
  } catch (error) {
    if (error.code === 'INSTAGRAM_NOT_CONFIGURED' && wantsJson(req)) {
      res.status(503).json({
        success: false,
        platform: 'instagram',
        code: error.code,
        message: error.message,
        missing: Array.isArray(error.missing) ? error.missing : []
      });
      return;
    }
    const result = sanitizePostResult({
      ok: false,
      mode: 'api',
      published: false,
      reason: error.message,
      response: error.response || null
    });
    await saveInstagramAttempt(userId, payload.postId, result, requestWorkspaceScope(req));
    if (wantsJson(req)) { res.status(400).json({ ok: false, result }); return; }
    redirectWithNotice(res, `Instagram attempt failed: ${error.message}`);
  }
}));

router.post(
  '/api/auto-caption',
  requireAdminApi,
  autoCaptionUpload.single('video'),
  asyncRoute(async (req, res) => {
    const draft = {
      caption: String(req.body.caption || '').trim(),
      hashtags: String(req.body.hashtags || '').trim()
    };

    if (!req.file) {
      res.status(400).json({
        ok: false,
        reason: 'Choose a video before running Auto Caption.',
        requiresManualCaption: !draft.caption
      });
      return;
    }

    try {
      const result = await autoCaption.analyzeVideoForCaption(req.file.path, draft, {
        filename: req.file.originalname
      });
      const autoMusicRequested = String(req.body.autoMusic || '') === '1';
      let music = {
        requested: autoMusicRequested,
        prepared: false,
        fallbackToOriginal: false,
        token: '',
        track: null
      };

      if (autoMusicRequested) {
        try {
          const preparedMusic = await autoMusic.prepareAutoMusic({
            videoPath: req.file.path,
            originalName: req.file.originalname,
            originalSize: req.file.size,
            userId: resolveUserId(req),
            analysis: {
              metadata: result.metadata,
              musicCategory: result.musicCategory,
              musicMood: result.musicMood,
              musicIntensity: result.musicIntensity,
              musicTags: result.musicTags
            }
          });
          music = {
            requested: true,
            prepared: true,
            fallbackToOriginal: false,
            token: preparedMusic.token,
            track: preparedMusic.track,
            mix: {
              originalAudioKept: preparedMusic.render.hasOriginalAudio,
              musicVolume: preparedMusic.render.musicVolume,
              durationSeconds: preparedMusic.render.durationSeconds
            }
          };
        } catch (error) {
          console.error('[auto-music] preparation failed; original video will be used', {
            code: error.code || 'AUTO_MUSIC_FAILED',
            message: error.message,
            fileName: req.file.originalname
          });
          music = {
            requested: true,
            prepared: false,
            fallbackToOriginal: true,
            token: '',
            track: null,
            reason: 'Background music could not be mixed. The original video will be used.'
          };
        }
      }

      res.json({
        ok: true,
        caption: result.caption,
        hashtags: result.hashtags,
        generatedCaption: result.generatedCaption,
        hook: result.hook,
        hashtagList: result.hashtagList,
        analysis: {
          frameCount: 5,
          transcriptUsed: result.transcriptUsed,
          transcriptionWarning: result.transcriptionWarning || '',
          analysisWarning: result.analysisWarning || '',
          provider: result.provider,
          fallbackUsed: result.fallbackUsed,
          musicCategory: result.musicCategory,
          musicMood: result.musicMood,
          musicIntensity: result.musicIntensity,
          metadata: result.metadata
        },
        music
      });
    } catch (error) {
      console.error('[auto-caption] analysis failed', {
        code: error.code || 'AUTO_CAPTION_FAILED',
        message: error.message,
        fileName: req.file.originalname
      });
      res.status(error.code === 'AUTO_CAPTION_NOT_CONFIGURED' ? 503 : 422).json({
        ok: false,
        code: error.code || 'AUTO_CAPTION_FAILED',
        reason: draft.caption
          ? 'Auto Caption could not analyze this video. Your manual caption was kept.'
          : 'Auto Caption could not analyze this video. Write a caption before scheduling.',
        fallback: draft,
        requiresManualCaption: !draft.caption
      });
    } finally {
      await removeTemporaryUpload(req.file.path);
    }
  })
);

// DEPRECATED COMPATIBILITY ADAPTER.
//
// The customer UI that posted here is gone: creation lives at
// /platform/compose. This route is retained rather than deleted because it is
// still a live, exercised API contract (video-only media policy, multi-channel
// fan-out, Max Scheduler offsets, recurring-daily series, duplicate-submit and
// unknown-result handling), and because recurring-daily has no composer
// equivalent yet — deleting it would remove working behaviour, not dead code.
//
// It is an adapter, not a second implementation: it resolves accounts, projects
// the multipart body onto applicationService.schedulePost, and formats the
// reply. Entitlements, idempotency, validation, scheduling and the human
// approval gate are all schedulePost's, identical to the canonical path.
//
// Never redirect a POST here — a redirect would silently drop the body.
//
// Provider selection lives in the multipart body, which only exists after
// multer runs — so the account gate happens inside the handler. TikTok
// keeps its existing connected-account requirement and message; YouTube
// targets one connected channel supplied by the caller.
router.post('/upload', requireAdminPage, uploadCampaignMedia, asyncRoute(async (req, res) => {
  // RFC 8594-style signal: honest to machine callers without breaking any of
  // them. The canonical surface is named so a caller knows where to go.
  res.set('Deprecation', 'true');
  res.set('Link', '</platform/compose>; rel="successor-version"');
  await resolveWebsiteCommercialContext(req);
  const userId = resolveUserId(req);
  const files = req.files || [];
  const provider = String(req.body.provider || '').trim().toLowerCase() || 'tiktok';

  const rejectIntake = async (message) => {
    for (const file of files) await removeTemporaryUpload(file.path);
    respondWithNotice(req, res, message, false);
  };

  let account = null;
  if (provider === 'tiktok') {
    const { activeAccount } = await resolveTikTokAccountContext(req, res);
    if (!activeAccount || !activeAccount.connected) {
      await rejectIntake('Select and connect a TikTok account before changing its queue.');
      return;
    }
    account = activeAccount;
  }

  const youtubeChannelId = String(req.body.youtubeChannelId || '').trim();
  if (provider === 'youtube' && !youtubeChannelId) {
    await rejectIntake('Select a connected YouTube channel before scheduling a YouTube upload.');
    return;
  }

  const publicMediaUrl = String(req.body.publicMediaUrl || req.body.publicImageUrl || '').trim();
  const requestedChannelIds = normalizeTargetChannelIds(req.body.targetChannels);
  const startDate = String(req.body.startDate || '').trim();
  const startTime = String(req.body.startTime || '').trim();
  const endDate = String(req.body.endDate || '').trim();
  const repeatMode = String(req.body.repeatMode || 'once').trim().toLowerCase();
  const approveSeries = repeatMode === 'daily' && String(req.body.approveSeries || '').trim() === '1';
  const preparedMedia = resolvePreparedMedia(req.body.autoMusicToken, userId, files);
  const contextAccountId = provider === 'youtube' ? youtubeChannelId : account.accountId;
  let result;
  try {
    result = await applicationService.schedulePost(
      websiteContext(req, {
        accountId: contextAccountId,
        approval: approveSeries ? { approvedBy: `admin:${userId}` } : null
      }),
      {
        provider,
        accountIds: provider === 'youtube'
          ? [youtubeChannelId]
          : (requestedChannelIds.length > 0 ? requestedChannelIds : [account.accountId]),
        files,
        mediaUrl: publicMediaUrl,
        caption: req.body.caption,
        hashtags: req.body.hashtags,
        preparedMedia,
        // Provider-specific metadata: YouTube requires an explicit title
        // (never silently mapped from the TikTok caption); privacy and
        // subscriber notifications are locked server-side.
        youtube: provider === 'youtube'
          ? {
              title: String(req.body.youtubeTitle || ''),
              description: String(req.body.youtubeDescription || '')
            }
          : undefined,
        schedule: repeatMode === 'daily'
          ? {
              mode: 'recurring_daily',
              startDate,
              endDate,
              startTime,
              timezoneName: req.body.timezoneName,
              timezoneOffsetMinutes: req.body.timezoneOffsetMinutes,
              offsetMinutes: req.body.offsetMinutes
            }
          : ((startDate || startTime)
              ? {
                  mode: 'max',
                  startDate,
                  startTime,
                  timezoneName: req.body.timezoneName,
                  timezoneOffsetMinutes: req.body.timezoneOffsetMinutes,
                  offsetMinutes: req.body.offsetMinutes
                }
              : { mode: 'automatic' })
      }
    );
  } catch (error) {
    if (error instanceof applicationService.AutoPosterApplicationError) {
      for (const file of files) await removeTemporaryUpload(file.path);
      if (preparedMedia && preparedMedia.file && preparedMedia.file.path) {
        await removeTemporaryUpload(preparedMedia.file.path);
      }
      const details = error.details && typeof error.details === 'object' ? error.details : {};
      const createdPostIds = Array.isArray(details.createdPostIds)
        ? details.createdPostIds.map((id) => String(id || '').trim()).filter(Boolean)
        : [];
      const createdPostId = String(details.createdPostId || createdPostIds[0] || '').trim();
      respondWithNotice(req, res, error.message, false, {
        status: error.status,
        code: error.code,
        resultUnknown: error.status >= 500 && Boolean(createdPostId || createdPostIds.length),
        createdPostId,
        createdPostIds,
        reasonCode: details.reasonCode,
        limit: details.limit,
        current: details.current,
        remaining: details.remaining,
        planId: details.planId,
        workspaceId: details.workspaceId
      });
      return;
    }
    throw error;
  }

  const created = result.posts;
  const scheduledCount = result.scheduledCount;
  const targetAccounts = result.accounts;
  const useMaxScheduler = result.schedule.mode === 'max';
  const useRecurringDaily = result.schedule.mode === 'recurring_daily';
  const maxSchedulePlan = result.schedule.plan || null;

  const usedFallback = created.some((post) => post.storageFallback);
  const sourceNotice = usedFallback ? ' Upload failed, so the public URL was used instead.' : '';
  const musicNotice = created.some((post) => post.autoMusicApplied)
    ? ' Background music was added.'
    : (req.body.autoMusicToken ? ' Music could not be added, so the original video was used.' : '');
  const channelNotice = targetAccounts.length > 1
    ? ` across ${targetAccounts.length} channels`
    : ` for ${provider === 'youtube' ? youtubeChannelLabel(targetAccounts[0]) : accountLabel(targetAccounts[0])}`;
  const youtubeNotice = provider === 'youtube'
    ? ' YouTube uploads are locked to Private with subscriber notifications disabled.'
    : '';
  const scheduleNotice = useRecurringDaily
    ? ` Daily through ${maxSchedulePlan.series.endDate}: ${maxSchedulePlan.occurrenceCount} ${maxSchedulePlan.occurrenceCount === 1 ? 'day' : 'days'}, ${maxSchedulePlan.jobCount} total release jobs. Other posts can still be added between these releases.`
    : (useMaxScheduler
        ? ` First post at ${viewHelpers.formatDateTime(maxSchedulePlan.baseAt)}, ${maxSchedulePlan.offsetMinutes}m apart per channel.`
        : '');
  const duplicateCount = created.filter((post) => post.duplicateWarning).length;
  const duplicateNotice = duplicateCount > 0
    ? ` ${duplicateCount} flagged as ${duplicateCount === 1 ? 'a possible duplicate' : 'possible duplicates'} — check the warnings below.`
    : '';
  const approvalNotice = useRecurringDaily && approveSeries
    ? `${scheduledCount} scheduled and approved together as one daily series.`
    : `${scheduledCount} scheduled as ${scheduledCount === 1 ? 'a draft' : 'drafts'} — review and approve in the Release Queue before anything publishes.`;
  respondWithNotice(req, res, `Created ${created.length} ${created.length === 1 ? 'post' : 'posts'}${channelNotice}. ${approvalNotice}${youtubeNotice}${scheduleNotice}${sourceNotice}${musicNotice}${duplicateNotice}`);
}));

router.post('/settings', requireAdminPage, asyncRoute(async (req, res) => {
  const dailyPostTime = String(req.body.dailyPostTime || '').trim();
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(dailyPostTime)) { redirectWithNotice(res, 'Use a valid daily posting time.'); return; }
  await storage.saveSettings({ dailyPostTime });
  redirectWithNotice(res, `Posting time set to ${dailyPostTime}.`);
}));

router.post('/schedule', requireConnectedTikTokAccount, asyncRoute(async (req, res) => {
  const result = await applicationService.rescheduleQueue(
    websiteContext(req, { accountId: req.activeTikTokAccount.accountId }),
    { accountId: req.activeTikTokAccount.accountId }
  );
  redirectWithNotice(res, `Scheduled ${result.count}.`);
}));

// ── Updated post save — now captures interaction settings & content disclosure ──
router.post('/posts/:id', requireCommercialWorkspacePage, asyncRoute(async (req, res) => {
  const scopeAccountId = String(req.body.accountId || '').trim() || undefined;
  const publicMediaUrl = String(req.body.publicMediaUrl || req.body.publicImageUrl || '').trim();
  if (publicMediaUrl && !isPublicHttpsUrl(publicMediaUrl)) {
    redirectWithNotice(res, 'Public Media URL must be a valid HTTPS URL.');
    return;
  }

  // Interaction ability: checkbox presence means enabled
  const allowComment    = req.body.allowComment    === '1';
  const allowDuet       = req.body.allowDuet       === '1';
  const allowStitch     = req.body.allowStitch      === '1';

  // Content disclosure
  const contentDisclosure = req.body.contentDisclosure === '1';
  const yourBrand         = contentDisclosure && req.body.yourBrand      === '1';
  const brandedContent    = contentDisclosure && req.body.brandedContent === '1';

  const postPatch = {
    caption:            String(req.body.caption            || '').trim(),
    hashtags:           String(req.body.hashtags           || '').trim(),
    publicMediaUrl,
    publicImageUrl:     publicMediaUrl,
    privacyLevel:       String(req.body.privacyLevel       || config.tiktok.privacyLevel || 'SELF_ONLY').trim() || 'SELF_ONLY',
    // TikTok Direct Post API — interaction ability
    disableComment:  !allowComment,
    disableDuet:     !allowDuet,
    disableStitch:   !allowStitch,
    // Content disclosure
    contentDisclosure,
    yourBrand,
    brandedContent
  };

  if (config.ENABLE_INSTAGRAM) {
    postPatch.instagramMediaUrl = String(req.body.instagramMediaUrl || '').trim();
  }

  try {
    await applicationService.updatePost(
      websiteContext(req, { accountId: scopeAccountId }),
      {
        postId: req.params.id,
        accountId: scopeAccountId,
        patch: postPatch,
        scheduleInput: {
          value: req.body.scheduledAt,
          timezoneOffsetMinutes: req.body.timezoneOffsetMinutes
        },
        historyEvent: { event: 'edited', detail: 'Caption, schedule, or settings updated in the Release Queue.' }
      }
    );
    redirectWithNotice(res, 'Saved.');
  } catch (error) {
    if (error instanceof applicationService.AutoPosterApplicationError) {
      redirectWithNotice(res, error.message);
      return;
    }
    throw error;
  }
}));

router.post('/posts/:id/move', requireCommercialWorkspacePage, asyncRoute(async (req, res) => {
  const userId = resolveUserId(req);
  const scopeAccountId = String(req.body.accountId || '').trim() || undefined;
  const { post } = await applicationService.getPostStatus(
    websiteContext(req, { accountId: scopeAccountId }),
    { postId: req.params.id, accountId: scopeAccountId }
  );
  const moved = await storage.movePost(
    userId,
    req.params.id,
    req.body.direction,
    post.accountId,
    requestWorkspaceScope(req)
  );
  redirectWithNotice(res, moved ? 'Moved.' : 'Could not move item.');
}));

// ── Approval gate: the explicit human review actions ──
// Approving is the only way a job becomes publishable; scheduler.claimPost
// refuses unapproved jobs on every worker path, so these two routes are
// the entire surface area a human uses to open or close the gate.
router.post('/posts/:id/approve', requireCommercialWorkspacePage, asyncRoute(async (req, res) => {
  const userId = resolveUserId(req);
  const scopeAccountId = String(req.body.accountId || '').trim() || undefined;
  const result = await applicationService.approvePost(
    websiteContext(req, { accountId: scopeAccountId, approval: { approvedBy: `admin:${userId}` } }),
    { postId: req.params.id, accountId: scopeAccountId }
  );
  const approved = result.post;
  if (!approved) {
    redirectWithNotice(res, 'Could not approve this post. It may be posting, already posted, or not in this channel.');
    return;
  }
  redirectWithNotice(res, approved.scheduledAt
    ? `Approved. It will post at ${viewHelpers.formatDateTime(approved.scheduledAt)}.`
    : 'Approved. Set a posting time or use Publish Now to release it.');
}));

router.post('/posts/:id/unapprove', requireCommercialWorkspacePage, asyncRoute(async (req, res) => {
  const scopeAccountId = String(req.body.accountId || '').trim() || undefined;
  const result = await applicationService.revokeApproval(
    websiteContext(req, { accountId: scopeAccountId }),
    { postId: req.params.id, accountId: scopeAccountId }
  );
  redirectWithNotice(res, result.ok
    ? 'Approval removed. This post is blocked from publishing until you approve it again.'
    : 'Could not change approval. The post may be posting, already posted, or not in this channel.');
}));

router.post('/posts/:id/prepare', requireCommercialWorkspacePage, asyncRoute(async (req, res) => {
  const scopeAccountId = String(req.body.accountId || '').trim() || undefined;
  let post;
  try {
    ({ post } = await applicationService.getPostStatus(
      websiteContext(req, { accountId: scopeAccountId }),
      { postId: req.params.id, accountId: scopeAccountId }
    ));
  } catch (error) {
    if (error instanceof applicationService.AutoPosterApplicationError) {
      redirectWithNotice(res, error.message);
      return;
    }
    throw error;
  }

  // Fail closed before any publish attempt: unapproved drafts can never be
  // published, even by the manual Publish Now action. (scheduler.claimPost
  // enforces the same gate transactionally — this check just gives the
  // operator a clear message instead of a generic skip.)
  if (!post.approved) {
    redirectWithNotice(res, 'Approve this post first — drafts are blocked from publishing until a human approves them.');
    return;
  }

  const forcePostNow = String(req.body.force || '') === '1';
  const scheduledAt = post.scheduledAt ? new Date(post.scheduledAt) : null;

  if (!forcePostNow && scheduledAt && scheduledAt.getTime() > Date.now()) {
    redirectWithNotice(res, `Scheduled for ${viewHelpers.formatDateTime(post.scheduledAt)}. It will post automatically at that time.`);
    return;
  }

  // Routes through the same claim-then-publish transaction the automatic
  // scheduler uses (force: true just skips the "is it due yet" check) —
  // so a double-click here can't trigger a double-publish either.
  const result = await scheduler.processPost(req.params.id, { force: true });
  if (result.ok) { redirectWithNotice(res, post.provider === 'youtube' ? 'Uploaded to YouTube as a private video. Check the status below to confirm.' : 'Posted. Check the status below to confirm.'); return; }
  if (result.mode === 'manual') { redirectWithNotice(res, 'Needs attention — see the note on this post below.'); return; }
  if (result.mode === 'skipped') { redirectWithNotice(res, 'Already posting — give it a moment and check the status below.'); return; }
  redirectWithNotice(res, `Needs attention: ${result.reason || 'The provider could not post this.'}`);
}));

router.post('/posts/:id/posted', requireCommercialWorkspacePage, asyncRoute(async (req, res) => {
  const scopeAccountId = String(req.body.accountId || '').trim() || undefined;
  try {
    await applicationService.markPostManually(
      websiteContext(req, { accountId: scopeAccountId }),
      { postId: req.params.id, accountId: scopeAccountId }
    );
    redirectWithNotice(res, 'Marked posted.');
  } catch (error) {
    if (error instanceof applicationService.AutoPosterApplicationError) {
      redirectWithNotice(res, error.message);
      return;
    }
    throw error;
  }
}));

router.post('/posts/:id/pending', requireCommercialWorkspacePage, asyncRoute(async (req, res) => {
  const scopeAccountId = String(req.body.accountId || '').trim() || undefined;
  try {
    const result = await applicationService.retryPost(
      websiteContext(req, { accountId: scopeAccountId }),
      { postId: req.params.id, accountId: scopeAccountId }
    );
    redirectWithNotice(res, result.post && result.post.scheduledAt ? 'Back to schedule.' : 'Back to pending.');
  } catch (error) {
    if (error instanceof applicationService.AutoPosterApplicationError) {
      redirectWithNotice(res, error.message);
      return;
    }
    throw error;
  }
}));

// Delete is deliberately NOT scoped to the active channel: the Release
// Queue's "All Channels" view and the Publishing Log render this form for
// posts on every channel this admin owns (including legacy jobs with no
// channel assignment), and all of them must be deletable from where they
// are shown. Ownership is still enforced by the shared delete operation.
router.post('/posts/:id/delete', requireCommercialWorkspacePage, asyncRoute(async (req, res) => {
  const result = await applicationService.deletePost(websiteContext(req), { postId: req.params.id });
  redirectWithNotice(res, result.deleted
    ? 'Deleted.'
    : 'Delete failed — this post could not be found in your account. It was not removed; refresh to see the current queue.');
}));

// Bulk deletion for the Mark/Delete Marked queue controls. Selection is
// purely client-side (no persistent "marked" state); this endpoint reports
// per-post truth so the UI removes only confirmed deletions and keeps
// failures visible. The batch operation reuses the same owner-scoped
// individual delete operation.
router.post('/api/posts/delete-marked', requireAdminApi, express.json({ limit: '64kb' }), asyncRoute(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const rawIds = Array.isArray(req.body && req.body.ids) ? req.body.ids : [];
  try {
    const result = await applicationService.deleteMarkedPosts(websiteContext(req), { postIds: rawIds });
    res.json(result);
  } catch (error) {
    if (error instanceof applicationService.AutoPosterApplicationError) {
      res.status(error.status).json({ ok: false, reason: error.message, deleted: [], failed: [] });
      return;
    }
    throw error;
  }
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

function normalizeTargetChannelIds(value) {
  // Checkbox groups arrive as a string for one selection and an array for
  // several; normalize to a de-duplicated list of non-empty ids.
  const raw = Array.isArray(value) ? value : (value ? [value] : []);
  return [...new Set(raw.map((id) => String(id || '').trim()).filter(Boolean))];
}

function requireConnectedTikTokAccount(req, res, next) {
  if (!req.isAdmin) {
    requireAdminPage(req, res, next);
    return;
  }
  resolveTikTokAccountContext(req, res)
    .then(({ activeAccount }) => {
      if (!activeAccount || !activeAccount.connected) {
        redirectWithNotice(res, 'Select and connect a TikTok account before changing its queue.');
        return;
      }
      req.activeTikTokAccount = activeAccount;
      next();
    })
    .catch(next);
}

function getLoginAttempt(ip, now = Date.now()) {
  const key = String(ip || 'unknown');
  const attempt = loginAttempts.get(key);
  if (!attempt || now - attempt.startedAt >= LOGIN_WINDOW_MS) {
    loginAttempts.delete(key);
    return { locked: false, count: 0 };
  }
  return { locked: attempt.count >= LOGIN_MAX_ATTEMPTS, count: attempt.count };
}

function recordFailedLogin(ip, now = Date.now()) {
  const key = String(ip || 'unknown');
  const current = loginAttempts.get(key);
  if (!current || now - current.startedAt >= LOGIN_WINDOW_MS) {
    loginAttempts.set(key, { count: 1, startedAt: now });
    return;
  }
  current.count += 1;
}

async function resolveTikTokAccountContext(req, res) {
  await resolveWebsiteCommercialContext(req);
  const userId = resolveUserId(req);
  const accounts = await storage.getTikTokAccounts(userId, requestWorkspaceScope(req));
  const selectedId = parseCookies(req.headers.cookie)[ACTIVE_TIKTOK_ACCOUNT_COOKIE] || '';
  const activeAccount = accounts.find((account) => account.accountId === selectedId)
    || accounts.find((account) => account.connected)
    || accounts[0]
    || null;

  if (activeAccount && activeAccount.accountId !== selectedId) {
    setActiveTikTokAccountCookie(res, activeAccount.accountId);
  }
  return { accounts, activeAccount };
}

function setActiveTikTokAccountCookie(res, accountId) {
  res.cookie(ACTIVE_TIKTOK_ACCOUNT_COOKIE, accountId, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 365 * 24 * 60 * 60 * 1000
  });
}

function publicTikTokAccount(account) {
  return {
    id: account.accountId,
    accountId: account.accountId,
    open_id: account.open_id,
    tiktokOpenId: account.open_id,
    platform: 'tiktok',
    provider: 'tiktok',
    connectedAccountId: connectedAccounts.connectionId('tiktok', account.accountId),
    providerAccountId: account.open_id || account.accountId,
    username: account.username || '',
    displayName: account.displayName || '',
    avatarUrl: account.avatarUrl || '',
    connected: Boolean(account.connected),
    clientAccessEnabled: Boolean(account.clientAccessEnabled)
  };
}

// Safe Command Center shape for one YouTube channel, parallel to
// publicTikTokAccount. Built only from the allowlisted connected-account
// view (see resolveYouTubeChannelViews), so token presence metadata and
// credentials can never pass through.
function publicYouTubeChannel(view) {
  return {
    id: view.accountId,
    accountId: view.accountId,
    platform: 'youtube',
    provider: 'youtube',
    connectedAccountId: view.connectionId,
    providerAccountId: view.providerAccountId,
    username: view.username || '',
    displayName: view.displayName || '',
    avatarUrl: view.avatarUrl || '',
    connected: view.connectionStatus === 'connected',
    connectionStatus: view.connectionStatus,
    publishingReady: Boolean(view.publishingReady),
    clientAccessEnabled: Boolean(view.clientAccessEnabled)
  };
}

function creatorInfoFromAccount(account) {
  if (!account) return null;
  return {
    creator_username: account.username || '',
    creator_nickname: account.displayName || '',
    creator_avatar_url: account.avatarUrl || '',
    privacy_level_options: []
  };
}

function accountLabel(account) {
  if (!account) return 'TikTok account';
  if (account.username) return `@${account.username}`;
  if (account.displayName) return account.displayName;
  return `TikTok ${String(account.accountId || '').slice(0, 8)}`;
}

function youtubeChannelLabel(account) {
  if (!account) return 'YouTube channel';
  const handle = String(account.username || '').trim();
  if (handle) return handle.startsWith('@') ? handle : `@${handle}`;
  if (account.displayName) return account.displayName;
  return `YouTube ${String(account.accountId || '').slice(0, 8)}`;
}

function redirectWithYouTubeConnectNotice(res, returnTo, finalized) {
  const label = youtubeChannelLabel(finalized.account);
  const notice = finalized.refreshTokenPresent
    ? `YouTube channel ${label} connected.`
    : `YouTube channel ${label} connected, but Google did not grant offline access, so publishing stays blocked. Use Reauthorize to grant it.`;
  const separator = returnTo.includes('?') ? '&' : '?';
  res.redirect(`${returnTo}${separator}notice=${encodeURIComponent(notice)}`);
}

// The safe connected-account view (plus display labels) for every owned
// YouTube channel. Never raw account records — the view shape excludes
// credentials by construction.
async function resolveYouTubeChannelViews(userId, workspaceScope) {
  const accounts = await storage.getYouTubeAccounts(userId, workspaceScope);
  const views = [];
  for (const account of accounts) {
    try {
      const view = connectedAccounts.toConnectedAccount(account);
      views.push({
        ...view,
        label: youtubeChannelLabel(account),
        connectionLabel: view.connectionStatus === 'connected'
          ? 'Connected'
          : (view.connectionStatus === 'reauthorization_required' ? 'Reauthorization required' : 'Disconnected'),
        publishingLabel: view.publishingReady
          ? 'Ready to publish (private uploads only)'
          : connectedAccounts.describeReadinessBlocker(view.readinessBlockers[0])
      });
    } catch (error) {
      console.warn('[routes] YouTube connected-account view unavailable', error.message);
    }
  }
  return views;
}

function emptyPostCounts() {
  return { total: 0, pending: 0, scheduled: 0, processing: 0, ready: 0, posted: 0, failed: 0 };
}

function redirectWithNotice(res, notice) {
  res.redirect(`/private/autoposter?notice=${encodeURIComponent(notice)}`);
}

// Fast Schedule intake: the campaign form submits over XHR with
// `Accept: application/json` so the page can show inline progress and a
// result without discarding form state. Plain HTML form posts (the no-JS
// fallback) keep the redirect-with-notice behavior unchanged.
function respondWithNotice(req, res, notice, ok = true, options = {}) {
  if (req.accepts(['html', 'json']) === 'json') {
    const status = Number.isInteger(options.status) && options.status >= 100 && options.status <= 599
      ? options.status
      : (ok ? 200 : 400);
    const payload = { ok, notice };
    if (options.code) payload.code = String(options.code);
    if (options.reasonCode) payload.reasonCode = String(options.reasonCode);
    for (const field of ['limit', 'current', 'remaining']) {
      if (options[field] === null || Number.isFinite(options[field])) payload[field] = options[field];
    }
    if (options.planId) payload.planId = String(options.planId);
    if (options.workspaceId) payload.workspaceId = String(options.workspaceId);
    if (options.resultUnknown) payload.resultUnknown = true;
    if (options.createdPostId) payload.createdPostId = String(options.createdPostId);
    if (Array.isArray(options.createdPostIds) && options.createdPostIds.length > 0) {
      payload.createdPostIds = options.createdPostIds.map((id) => String(id));
    }
    res.status(status).json(payload);
    return;
  }
  redirectWithNotice(res, notice);
}

async function removeTemporaryUpload(filePath) {
  if (!filePath) return;
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('[auto-caption] could not remove temporary upload:', error.message);
    }
  }
}

function resolvePreparedMedia(token, userId, files) {
  if (!token) return null;
  for (const file of files) {
    try {
      const prepared = autoMusic.verifyPreparedMediaToken(token, { userId, file });
      if (prepared) return prepared;
    } catch (error) {
      console.warn('[auto-music] prepared media verification failed; using original upload', {
        code: error.code || 'PREPARED_MEDIA_INVALID'
      });
      return null;
    }
  }
  console.warn('[auto-music] prepared media token was invalid or expired; using original upload');
  return null;
}

async function runCronTick(req, res) {
  if (!authorizeCronRequest(req, res, 'cron')) return;
  const result = await scheduler.runSchedulerTick();
  res.status(result.ok ? 200 : 500).json(result);
}

function authorizeCronRequest(req, res, purpose) {
  if (!config.cronSecret) {
    res.status(503).json({ ok: false, reason: 'CRON_SECRET is not configured' });
    return false;
  }
  const suppliedSecret = req.get('x-cron-secret') || req.query.secret;
  if (suppliedSecret !== config.cronSecret) {
    res.status(403).json({ ok: false, reason: `Invalid ${purpose} secret` });
    return false;
  }
  return true;
}

function firstNonEmptyLine(value) {
  return String(value || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';
}

async function getCreatorInfoSafe(accountId, userId, workspaceScope) {
  try { return await tiktok.queryCreatorInfo(accountId, userId, workspaceScope); }
  catch (error) { console.warn('[routes] TikTok creator info unavailable', error.message); return null; }
}

function parseCookies(header) {
  return String(header || '').split(';').map(p => p.trim()).filter(Boolean)
    .reduce((cookies, part) => {
      const sep = part.indexOf('=');
      if (sep === -1) return cookies;
      cookies[decodeURIComponent(part.slice(0, sep))] = decodeURIComponent(part.slice(sep + 1));
      return cookies;
    }, {});
}

function isPublicHttpsUrl(value) {
  try {
    return new URL(value).protocol === 'https:';
  } catch (error) {
    return false;
  }
}

function getTodayPost(posts) {
  const today = new Date();
  const start = new Date(today); start.setHours(0, 0, 0, 0);
  const end = new Date(start); end.setDate(end.getDate() + 1);
  const scheduledToday = p => {
    if (!p.scheduledAt) return false;
    const s = new Date(p.scheduledAt);
    return s >= start && s < end;
  };
  return posts.find(p => p.status === 'ready')
    || posts.find(p => scheduledToday(p) && p.status !== 'posted')
    || posts.find(p => scheduledToday(p))
    || null;
}

// ── View helpers ──────────────────────────────────────────────────────────────
// Unchanged from before: these all operate on plain post objects that have
// already been resolved (awaited) before rendering, so none of them need
// to be async themselves.

const viewHelpers = {
  mediaType(post) { return getPostMediaType(post); },
  mediaPath(post) { return getPostMediaPath(post); },
  mediaLabel(post) { return getPostMediaType(post) === 'video' ? 'Video' : 'Image'; },
  mediaOpenLabel(post) { return getPostMediaType(post) === 'video' ? 'Open video' : 'Open image'; },
  mediaWorkflowLabel(post) { return getPostMediaType(post) === 'video' ? 'Video + original audio' : 'Photo source'; },
  publicUrlNote(post) { return getPostMediaType(post) === 'video' ? 'Not needed for video uploads.' : 'HTTPS source for photo API publishing.'; },
  hasLocalMedia(post) { return Boolean(getPostMediaPath(post)); },
  hasPublishablePhotoSource(post) {
    if (getPostMediaType(post) !== 'photo') return true;
    return Boolean(tiktok.getPublicImageUrl(post));
  },
  postResult(post) { return buildPostResultView(post); },
  resultDebugJson(post) { return getDebugJson(post); },
  instagramPostResult(post) { return buildInstagramPostResultView(post); },
  instagramResultDebugJson(post) { return getInstagramDebugJson(post); },
  formatDateTime(value) {
    if (!value) return 'Not scheduled';
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
  },
  formatTime(value) {
    if (!value) return 'No time';
    return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(value));
  },
  dateTimeInput(value) {
    if (!value) return '';
    const date = new Date(value);
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 16);
  },
  fullCaption(post) { return tiktok.buildCaption(post); },
  statusLabel(status) { return statusLabel(status); }
};

function getPostMediaType(post) {
  const mediaType = String((post && post.mediaType) || '').toLowerCase();
  if (mediaType === 'video') return 'video';
  const fileName = String((post && (post.fileName || post.mediaPath || post.videoPath)) || '').toLowerCase();
  if (['.mp4', '.mov', '.webm'].some(ext => fileName.endsWith(ext))) return 'video';
  return 'photo';
}

function getPostMediaPath(post) {
  if (!post) return '';
  if (getPostMediaType(post) === 'video') return post.mediaUrl || post.videoPath || post.mediaPath || post.publicMediaUrl || post.imagePath || '';
  return post.mediaUrl || post.imagePath || post.mediaPath || post.publicMediaUrl || post.publicImageUrl || '';
}

function buildPostResultView(post) {
  if (post && post.provider === 'youtube') return buildYouTubePostResultView(post);
  const lastResult = post && post.lastResult ? post.lastResult : null;
  const responseSource = lastResult ? lastResult.response || lastResult : null;
  const metadata = getPublishMetadata(responseSource);
  const shareUrl = getFirstValue(responseSource, ['share_url','shareUrl','post_url','postUrl','permalink','public_url','publicUrl']);
  const publishId = getFirstValue(responseSource, ['publish_id','publishId']);
  const status = String((post && post.status) || 'pending').toLowerCase();
  const isApiAccepted = Boolean(lastResult && lastResult.ok && lastResult.mode === 'api');
  const debugJson = getDebugJson(post);

  let stateLabel = 'Scheduled', tone = 'scheduled';
  let message = post && post.scheduledAt ? `Scheduled for ${viewHelpers.formatDateTime(post.scheduledAt)}.` : 'Ready to schedule.';

  // NOTE: the Firestore status value is "processing" now (was "publishing"
  // in the old file-based storage). tone/stateLabel are left as
  // "publishing" below on purpose — that string only drives the CSS class,
  // which the view already expects, so styling stays identical to before.
  if (status === 'processing') {
    stateLabel = 'Publishing'; tone = 'publishing';
    message = 'Posting to TikTok — this can take a moment for larger videos.';
  } else if (status === 'failed' || (lastResult && lastResult.ok === false && lastResult.mode !== 'manual')) {
    stateLabel = 'Failed'; tone = 'failed';
    const rawReason = (lastResult && lastResult.reason) || '';
    const fullJson = lastResult ? JSON.stringify(lastResult) : '';
    const isUnaudited = rawReason.includes('unaudited_client_can_only_post_to_private_accounts') || rawReason.includes('403') || fullJson.includes('unaudited_client_can_only_post_to_private_accounts');
    message = isUnaudited
      ? 'TikTok needs this account set to private until app review is complete.'
      : rawReason || "TikTok couldn't post this. Try again.";
  } else if (status === 'ready' || (lastResult && lastResult.mode === 'manual' && status !== 'posted')) {
    stateLabel = 'Needs manual verification'; tone = 'verification';
    message = (lastResult && lastResult.reason) || 'Check the media, then confirm it inside TikTok.';
  } else if (status === 'posted' && isApiAccepted) {
    stateLabel = shareUrl ? 'Posted verified' : 'API accepted';
    tone = shareUrl ? 'accepted' : 'verification';
    message = shareUrl
      ? 'TikTok confirmed this post is live.'
      : "TikTok accepted this post. Confirm it's live inside the app.";
  } else if (status === 'posted') {
    stateLabel = 'Posted manually'; tone = 'accepted';
    message = (lastResult && lastResult.reason) || 'Marked as posted.';
  }

  return { stateLabel, tone, message, metadata, shareUrl, publishId, debugJson, hasDebug: Boolean(debugJson), hasAttempt: Boolean(lastResult), statusCheckAvailable: false };
}

// Truthful YouTube state rendering: uploads are private-only, subscriber
// notifications are disabled, ambiguous outcomes stay visibly ambiguous,
// and "uploaded" is never presented as "processed" or "published".
function buildYouTubePostResultView(post) {
  const lastResult = post && post.lastResult ? post.lastResult : null;
  const status = String((post && post.status) || 'pending').toLowerCase();
  const videoId = String((post && post.publishId) || '').trim();
  const debugJson = getDebugJson(post);
  const meta = (post && post.providerMetadata && post.providerMetadata.youtube) || null;

  const metadata = [];
  if (videoId) metadata.push({ label: 'YouTube video ID', value: videoId, isUrl: false });
  metadata.push({ label: 'Privacy', value: 'Private (locked)', isUrl: false });
  metadata.push({ label: 'Subscriber notifications', value: 'Disabled', isUrl: false });
  if (post && post.providerStatus) metadata.push({ label: 'Provider status', value: post.providerStatus, isUrl: false });
  const uploadStatus = lastResult && lastResult.response && lastResult.response.upload_status;
  if (uploadStatus) metadata.push({ label: 'Upload status', value: String(uploadStatus), isUrl: false });

  // Studio link carries no credentials; the video is private, so only the
  // channel owner can open it.
  const shareUrl = videoId ? `https://studio.youtube.com/video/${encodeURIComponent(videoId)}/edit` : '';

  let stateLabel = 'Scheduled';
  let tone = 'scheduled';
  let message = post && post.scheduledAt
    ? `Scheduled for ${viewHelpers.formatDateTime(post.scheduledAt)}. Uploads privately when due.`
    : 'Ready to schedule. Uploads privately when due.';

  if (status === 'processing') {
    stateLabel = 'Uploading'; tone = 'publishing';
    message = 'Uploading to YouTube as a private video — this can take a moment for larger files.';
  } else if (status === 'outcome_unknown') {
    stateLabel = 'Outcome unknown'; tone = 'failed';
    message = `${(lastResult && lastResult.reason) || 'YouTube did not return a definitive result.'} Check YouTube Studio before retrying — a blind retry could create a duplicate upload.`;
  } else if (status === 'failed' || (lastResult && lastResult.ok === false && lastResult.mode !== 'manual')) {
    stateLabel = 'Failed'; tone = 'failed';
    message = (lastResult && lastResult.reason) || 'YouTube could not store this video. Review and retry.';
  } else if (status === 'posted' && videoId) {
    stateLabel = 'Uploaded private'; tone = 'accepted';
    message = 'YouTube stored this video as Private with subscriber notifications disabled. Upload success does not mean processing is complete — check Studio for processing state.';
  } else if (status === 'posted') {
    stateLabel = 'Posted manually'; tone = 'accepted';
    message = (lastResult && lastResult.reason) || 'Marked as posted.';
  }

  if (meta && meta.title) {
    metadata.push({ label: 'Title', value: meta.title, isUrl: false });
  }

  return { stateLabel, tone, message, metadata, shareUrl, publishId: videoId, debugJson, hasDebug: Boolean(debugJson), hasAttempt: Boolean(lastResult), statusCheckAvailable: Boolean(videoId) };
}

function buildInstagramPostResultView(post) {
  const lastResult = post && post.lastInstagramResult ? post.lastInstagramResult : null;
  const debugJson = getInstagramDebugJson(post);
  if (!lastResult) return { stateLabel: 'No Instagram test', tone: 'scheduled', message: '', metadata: [], debugJson, hasDebug: false, hasAttempt: false };

  const metadata = getPublishMetadata(lastResult.response || lastResult);
  let stateLabel = 'Instagram tested', tone = 'verification', message = lastResult.reason || 'Instagram container created in test mode.';

  if (!lastResult.ok) {
    stateLabel = 'Instagram failed'; tone = lastResult.mode === 'manual' ? 'verification' : 'failed';
    message = lastResult.reason || 'Instagram rejected the request.';
  } else if (lastResult.published) {
    stateLabel = 'Instagram published'; tone = 'accepted';
    message = lastResult.reason || 'Instagram accepted the publish request.';
  }

  return { stateLabel, tone, message, metadata, debugJson, hasDebug: Boolean(debugJson), hasAttempt: true };
}

function getPublishMetadata(source) {
  if (!source) return [];
  const rows = [
    ['Publish ID', getFirstValue(source, ['publish_id','publishId'])],
    ['Post ID', getFirstValue(source, ['post_id','postId','item_id','itemId','video_id','videoId'])],
    ['Share URL', getFirstValue(source, ['share_url','shareUrl','post_url','postUrl','permalink','public_url','publicUrl'])],
    ['Status', getFirstValue(source, ['status','publish_status','publishStatus'])],
    ['Log ID', getFirstValue(source, ['log_id','logId'])]
  ];
  return rows.filter(r => r[1] !== undefined && r[1] !== null && String(r[1]).trim() !== '')
    .map(([label, value]) => ({ label, value: formatMetadataValue(value), isUrl: isHttpUrl(value) }));
}

function getFirstValue(source, keys) {
  const found = findValuesByKeys(source, new Set(keys.map(k => k.toLowerCase())));
  return found.length > 0 ? found[0] : '';
}

function findValuesByKeys(value, keySet, found = []) {
  if (!value || typeof value !== 'object') return found;
  if (Array.isArray(value)) { value.forEach(i => findValuesByKeys(i, keySet, found)); return found; }
  Object.entries(value).forEach(([k, v]) => {
    if (keySet.has(k.toLowerCase())) found.push(v);
    if (v && typeof v === 'object') findValuesByKeys(v, keySet, found);
  });
  return found;
}

function formatMetadataValue(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function isHttpUrl(value) {
  try { const u = new URL(String(value)); return u.protocol === 'http:' || u.protocol === 'https:'; }
  catch { return false; }
}

function getDebugJson(post) {
  const result = sanitizePostResult(post && post.lastResult);
  return result ? JSON.stringify(result, null, 2) : '';
}
function getInstagramDebugJson(post) {
  const result = sanitizePostResult(post && post.lastInstagramResult);
  return result ? JSON.stringify(result, null, 2) : '';
}

function statusLabel(status) {
  const labels = { pending: 'Unscheduled', scheduled: 'Scheduled', processing: 'Publishing', ready: 'Needs manual verification', posted: 'Posted', failed: 'Failed', outcome_unknown: 'Outcome unknown — reconcile' };
  const v = String(status || 'pending').toLowerCase();
  return labels[v] || `${v.charAt(0).toUpperCase()}${v.slice(1)}`;
}

async function saveInstagramAttempt(userId, postId, result, workspaceScope) {
  if (!postId) return;
  const post = await storage.getPost(userId, postId, undefined, workspaceScope);
  if (!post) return;
  await storage.updatePost(
    userId,
    postId,
    { lastInstagramResult: sanitizePostResult({ ...result, completedAt: new Date().toISOString() }) },
    undefined,
    undefined,
    workspaceScope
  );
}

// Queue-item management is provider-neutral. Resolve the authenticated
// workspace first, then let the shared application service verify the post
// and optional submitted account scope. A valid YouTube-only workspace must
// never need a TikTok connection just to manage its own queue.
function requireCommercialWorkspacePage(req, res, next) {
  if (!req.isAdmin) {
    requireAdminPage(req, res, next);
    return;
  }
  resolveWebsiteCommercialContext(req).then(() => next()).catch(next);
}

function instagramNotice(result) {
  if (result.code === 'INSTAGRAM_NOT_CONFIGURED') return result.message;
  if (result.ok && result.published) return 'Instagram accepted the publish request.';
  if (result.ok) return 'Instagram dry-run completed. No public publish was attempted.';
  if (result.mode === 'manual') return result.reason || 'Instagram needs a public media URL before testing.';
  return `Instagram attempt failed: ${result.reason || 'Unknown error'}`;
}

function wantsJson(req) {
  const accept = String(req.headers.accept || '').toLowerCase();
  const ct = String(req.headers['content-type'] || '').toLowerCase();
  return accept.includes('application/json') || ct.includes('application/json');
}

module.exports = router;
