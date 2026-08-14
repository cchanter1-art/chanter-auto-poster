const path = require('path');
require('dotenv').config();

const rootDir = path.resolve(__dirname, '..');
const port = Number(process.env.PORT || 3000);
const ENABLE_INSTAGRAM = envFlag('ENABLE_INSTAGRAM', false);
const metaGraphVersion = process.env.META_GRAPH_VERSION || process.env.INSTAGRAM_GRAPH_VERSION || 'v24.0';
const firebasePrivateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n').trim() || '';
const requestedAiProvider = String(process.env.AI_PROVIDER || 'gemini').trim().toLowerCase();
const aiProvider = ['gemini', 'openai', 'qwen'].includes(requestedAiProvider)
  ? requestedAiProvider
  : 'gemini';

function envFlag(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase());
}

function envInverseFlag(name, fallback = true) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(raw).trim().toLowerCase());
}

module.exports = {
  ENABLE_INSTAGRAM,
  appName: 'CHANTER AutoPoster',
  port,
  rootDir,
  // NOTE: the running app no longer reads these — Firestore is the source
  // of truth now. They're kept only so src/migrate-to-firestore.js can
  // find your old local data on its one-time run.
  dataDir: path.join(rootDir, 'data'),
  uploadsDir: path.join(rootDir, 'uploads'),
  postsFile: path.join(rootDir, 'data', 'posts.json'),
  settingsFile: path.join(rootDir, 'data', 'settings.json'),
  tiktokAuthFile: path.join(rootDir, 'data', 'tiktok_auth.json'),
  instagramAuthFile: path.join(rootDir, 'data', 'instagram_auth.json'),
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''),
  cronSecret: process.env.CRON_SECRET || '',
  adminPassword: process.env.ADMIN_PASSWORD || '',
  adminSessionSecret: process.env.ADMIN_SESSION_SECRET || '',
  adminSessionHours: Math.max(1, Number(process.env.ADMIN_SESSION_HOURS || 12)),
  appUrl: (process.env.APP_URL || '').replace(/\/+$/, ''),
  appTimeZone: process.env.APP_TIME_ZONE || process.env.TZ || 'UTC',

  // Placeholder identity until real auth exists (see src/auth.js). Every
  // Firestore post document is tagged with this userId today, so the
  // multi-user plumbing (queries, ownership checks, security rules) is
  // already in place and just needs a real value plugged in later.
  defaultUserId: process.env.APP_DEFAULT_USER_ID || 'owner',

  // Agent Runtime control surface (src/runtimeControlRoutes.js). No token
  // means the /api/runtime/* routes refuse every request (fail closed).
  runtimeControl: {
    token: process.env.RUNTIME_CONTROL_TOKEN || ''
  },

  // Operator mission graphs as a read-only Platform work provider
  // (src/platformOperatorProvider.js). Off unless a base URL is set: Operator
  // is a local-first internal service on 127.0.0.1, so a deployed AutoPoster
  // leaves this empty and registers no Operator provider at all. Reads are GET
  // only and can never move Operator state.
  operatorWork: {
    baseUrl: (process.env.OPERATOR_BASE_URL || '').trim(),
    timeoutMs: Math.max(250, Number(process.env.OPERATOR_WORK_TIMEOUT_MS || 2500))
  },

  // Canonical customer execution path. The legacy composer path remains the
  // default until this explicit gate is enabled. Writes use two different
  // Operator capabilities: submission may persist a command/graph, while
  // execution requires the stronger control token. Staged-media references
  // are signed with their own secret and never fall back to an admin/session
  // credential.
  canonicalExecution: {
    enabled: envFlag('PLATFORM_CANONICAL_EXECUTION_ENABLED', false),
    operatorBaseUrl: (process.env.OPERATOR_BASE_URL || '').trim(),
    submitToken: process.env.OPERATOR_MISSION_SUBMIT_TOKEN || '',
    controlToken: process.env.OPERATOR_CONTROL_TOKEN || '',
    mediaReferenceSecret: process.env.PLATFORM_CANONICAL_MEDIA_REFERENCE_SECRET || '',
    // Upload commands may only be activated when this path is mounted on a
    // persistent single-instance/shared volume. A process-local or ephemeral
    // deploy cannot honestly retain accepted media across restart.
    persistentStagingAcknowledged: envFlag('PLATFORM_CANONICAL_STAGING_PERSISTENT', false),
    timeoutMs: Math.max(500, Number(process.env.OPERATOR_COMMAND_TIMEOUT_MS || 10_000)),
    stagedMediaDir: path.join(rootDir, 'uploads', 'canonical-staged')
  },

  scheduler: {
    // How long a post is allowed to sit in "processing" before the
    // watchdog assumes the worker crashed and reclaims it.
    staleLockMinutes: Number(process.env.SCHEDULER_STALE_LOCK_MINUTES || 20),
    // After this many claim attempts, stop retrying and mark it failed
    // instead of looping forever on a poison-pill post.
    maxClaimAttempts: Number(
      process.env.SCHEDULER_MAX_CLAIM_ATTEMPTS || process.env.SCHEDULER_MAX_ATTEMPTS || 5
    )
  },

  // Platform batch intake (src/batchService.js). Preparation runs with
  // bounded parallelism and per-item leases so an interrupted batch can
  // resume without double work; every bound fails closed to its default.
  batchIntake: {
    maxItems: Math.min(100, Math.max(1, Number(process.env.BATCH_MAX_ITEMS || 30))),
    prepareConcurrency: Math.min(4, Math.max(1, Number(process.env.BATCH_PREPARE_CONCURRENCY || 2))),
    prepareMaxAttempts: Math.min(5, Math.max(1, Number(process.env.BATCH_PREPARE_MAX_ATTEMPTS || 3))),
    prepareLeaseMinutes: Math.max(2, Number(process.env.BATCH_PREPARE_LEASE_MINUTES || 10)),
    staggerDefaultMinutes: Math.max(5, Number(process.env.BATCH_STAGGER_DEFAULT_MINUTES || 30)),
    staggerMinMinutes: Math.max(1, Number(process.env.BATCH_STAGGER_MIN_MINUTES || 5)),
    staggerMaxMinutes: Math.min(24 * 60, Math.max(5, Number(process.env.BATCH_STAGGER_MAX_MINUTES || 24 * 60))),
    // Accepted items must stay at least this far in the future so an
    // approval can never trigger an immediate publish.
    safetyBufferMinutes: Math.max(5, Number(process.env.BATCH_SAFETY_BUFFER_MINUTES || 10)),
    downloadTimeoutMs: Math.max(30_000, Number(process.env.BATCH_DOWNLOAD_TIMEOUT_MS || 120_000)),
    maxDownloadBytes: Number(process.env.BATCH_MAX_DOWNLOAD_BYTES || 250 * 1024 * 1024)
  },

  firebase: {
    projectId: process.env.FIREBASE_PROJECT_ID || process.env.VITE_FIREBASE_PROJECT_ID || '',
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL || '',
    privateKey: firebasePrivateKey
  },

  cloudinary: {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME || '',
    apiKey: process.env.CLOUDINARY_API_KEY || '',
    apiSecret: process.env.CLOUDINARY_API_SECRET || '',
    uploadAttempts: Number(process.env.CLOUDINARY_UPLOAD_ATTEMPTS || 3),
    retryBaseMs: Number(process.env.CLOUDINARY_RETRY_BASE_MS || 500),
    folder: process.env.CLOUDINARY_FOLDER || 'chanter-auto-poster/uploads'
  },

  autoCaption: {
    aiProvider,
    geminiApiKey: process.env.GEMINI_API_KEY || '',
    geminiBaseUrl: (process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, ''),
    geminiModel: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    openAiApiKey: process.env.OPENAI_API_KEY || '',
    openAiBaseUrl: (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
    captionModel: process.env.OPENAI_CAPTION_MODEL || 'gpt-5.5',
    transcriptionModel: process.env.OPENAI_TRANSCRIPTION_MODEL || 'gpt-4o-mini-transcribe',
    qwenApiKey: process.env.QWEN_API_KEY || '',
    qwenBaseUrl: (process.env.QWEN_BASE_URL || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1').replace(/\/+$/, ''),
    qwenModel: process.env.QWEN_MODEL || 'qwen-vl-max',
    ffmpegPath: process.env.FFMPEG_PATH || '',
    ffprobePath: process.env.FFPROBE_PATH || '',
    ffmpegTimeoutMs: Math.max(10_000, Number(process.env.AUTO_CAPTION_FFMPEG_TIMEOUT_MS || 120_000)),
    requestTimeoutMs: Math.max(10_000, Number(process.env.AUTO_CAPTION_REQUEST_TIMEOUT_MS || 120_000)),
    maxAudioSeconds: Math.max(0, Number(process.env.AUTO_CAPTION_MAX_AUDIO_SECONDS || 600)),
    maxTranscriptChars: Math.max(1_000, Number(process.env.AUTO_CAPTION_MAX_TRANSCRIPT_CHARS || 12_000))
  },

  autoMusic: {
    libraryDir: path.join(rootDir, 'music-library'),
    catalogPath: path.join(rootDir, 'music-library', 'musicCatalog.json'),
    backgroundVolume: Math.min(0.25, Math.max(0.15, Number(process.env.AUTO_MUSIC_BACKGROUND_VOLUME || 0.2))),
    fadeSeconds: Math.max(0.1, Number(process.env.AUTO_MUSIC_FADE_SECONDS || 0.8)),
    renderTimeoutMs: Math.max(30_000, Number(process.env.AUTO_MUSIC_RENDER_TIMEOUT_MS || 10 * 60_000)),
    tokenTtlMs: Math.max(60_000, Number(process.env.AUTO_MUSIC_TOKEN_TTL_MINUTES || 30) * 60_000),
    tokenSecret:
      process.env.AUTO_MUSIC_TOKEN_SECRET ||
      process.env.ADMIN_SESSION_SECRET ||
      process.env.ADMIN_PASSWORD ||
      ''
  },

  mediaPreview: {
    previewDir: path.join(rootDir, 'uploads', 'previews'),
    manifestDir: path.join(rootDir, 'uploads', 'previews', 'manifests'),
    tokenTtlMs: Math.max(60_000, Number(process.env.MEDIA_PREVIEW_TOKEN_TTL_MINUTES || 60) * 60_000),
    fadeSeconds: Math.max(0.1, Number(process.env.MEDIA_PREVIEW_FADE_SECONDS || 0.5)),
    renderTimeoutMs: Math.max(30_000, Number(process.env.MEDIA_PREVIEW_RENDER_TIMEOUT_MS || 5 * 60_000)),
    maxUploadBytes: Math.min(25 * 1024 * 1024, Math.max(1024, Number(process.env.MEDIA_PREVIEW_MAX_UPLOAD_BYTES || 25 * 1024 * 1024))),
    tokenSecret:
      process.env.MEDIA_PREVIEW_TOKEN_SECRET ||
      process.env.AUTO_MUSIC_TOKEN_SECRET ||
      process.env.ADMIN_SESSION_SECRET ||
      ''
  },

  tiktok: {
    clientKey: process.env.TIKTOK_CLIENT_KEY || '',
    clientSecret: process.env.TIKTOK_CLIENT_SECRET || '',
    redirectUri:
      process.env.TIKTOK_REDIRECT_URI || `http://localhost:${port}/auth/tiktok/callback`,
    scopes: process.env.TIKTOK_SCOPES || 'user.info.basic,video.publish',
    authUrl: 'https://www.tiktok.com/v2/auth/authorize/',
    tokenUrl: 'https://open.tiktokapis.com/v2/oauth/token/',
    contentPostInitUrl:
      process.env.TIKTOK_CONTENT_POST_INIT_URL ||
      'https://open.tiktokapis.com/v2/post/publish/content/init/',
    privacyLevel: process.env.TIKTOK_PRIVACY_LEVEL || 'SELF_ONLY',
    requestTimeoutMs: Number(process.env.TIKTOK_REQUEST_TIMEOUT_MS || 30_000),
    uploadTimeoutMs: Number(process.env.TIKTOK_UPLOAD_TIMEOUT_MS || 15 * 60_000)
  },
  youtube: {
    // Feature flag: allows deliberately disabling the provider even when
    // credentials exist. Defaults on so configuration alone activates it.
    enabled: envInverseFlag('YOUTUBE_ENABLED', true),
    clientId: process.env.YOUTUBE_CLIENT_ID || '',
    clientSecret: process.env.YOUTUBE_CLIENT_SECRET || '',
    redirectUri:
      process.env.YOUTUBE_REDIRECT_URI || `http://localhost:${port}/auth/youtube/callback`,
    // Least privilege: youtube.upload authorizes videos.insert only;
    // youtube.readonly is the narrow read scope for channels.list (mine=true)
    // and own-video status lookup. Do not add youtube / youtube.force-ssl /
    // youtubepartner here.
    scopes:
      process.env.YOUTUBE_SCOPES ||
      'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly',
    // Google endpoints. Overridable only so automated tests can point the
    // OAuth/token/API calls at controlled local fakes — never override in
    // production.
    authUrl: process.env.YOUTUBE_OAUTH_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: process.env.YOUTUBE_OAUTH_TOKEN_URL || 'https://oauth2.googleapis.com/token',
    revokeUrl: process.env.YOUTUBE_OAUTH_REVOKE_URL || 'https://oauth2.googleapis.com/revoke',
    apiBaseUrl: (process.env.YOUTUBE_API_BASE_URL || 'https://www.googleapis.com/youtube/v3').replace(/\/+$/, ''),
    uploadBaseUrl: (process.env.YOUTUBE_UPLOAD_BASE_URL || 'https://www.googleapis.com/upload/youtube/v3').replace(/\/+$/, ''),
    // Safety policy: subscriber notifications are always disabled, and every
    // upload is private unless a job EXPLICITLY requests otherwise.
    // privateOnly is the deployment-level ceiling on that request: while it
    // is on (the default), a job asking for public visibility is refused
    // before the provider is touched. Turning it off authorizes the public
    // path to exist — it never makes any job public by itself.
    privateOnly: envInverseFlag('YOUTUBE_PRIVATE_ONLY', true),
    requestTimeoutMs: Number(process.env.YOUTUBE_REQUEST_TIMEOUT_MS || 30_000),
    uploadTimeoutMs: Number(process.env.YOUTUBE_UPLOAD_TIMEOUT_MS || 15 * 60_000),
    // Matches the product's 250 MB intake limit (multer fileSize).
    maxVideoBytes: Number(process.env.YOUTUBE_MAX_VIDEO_BYTES || 250 * 1024 * 1024)
  },

  // Versioned authenticated-encryption keys for provider OAuth credentials
  // (see src/tokenVault.js). Key 1 is the current write key. New versions
  // are added as TOKEN_ENCRYPTION_KEY_V2, V3, ... without breaking records
  // encrypted under older keys.
  tokenEncryption: {
    keys: {
      1: process.env.TOKEN_ENCRYPTION_KEY || ''
    },
    writeKeyVersion: 1
  },

  instagram: {
    appId: process.env.META_APP_ID || process.env.INSTAGRAM_APP_ID || '',
    appSecret: process.env.META_APP_SECRET || process.env.INSTAGRAM_APP_SECRET || '',
    redirectUri:
      process.env.META_REDIRECT_URI ||
      process.env.INSTAGRAM_REDIRECT_URI ||
      `http://localhost:${port}/auth/instagram/callback`,
    scopes:
      process.env.INSTAGRAM_SCOPES ||
      'instagram_basic,instagram_content_publish,pages_show_list,pages_read_engagement',
    graphVersion: metaGraphVersion,
    authUrl:
      process.env.META_AUTH_URL ||
      `https://www.facebook.com/${metaGraphVersion}/dialog/oauth`,
    graphBaseUrl: (process.env.META_GRAPH_BASE_URL || 'https://graph.facebook.com').replace(/\/+$/, ''),
    accessToken: process.env.META_ACCESS_TOKEN || process.env.INSTAGRAM_ACCESS_TOKEN || '',
    instagramBusinessAccountId: process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID || '',
    facebookPageId: process.env.FACEBOOK_PAGE_ID || '',
    testMode: envInverseFlag('INSTAGRAM_TEST_MODE', true),
    publishEnabled: envFlag('INSTAGRAM_PUBLISH_ENABLED', false)
  }
};

/**
 * Validates that critical secrets are present at startup.
 * Called from server.js after config is loaded.
 * Returns an array of warning messages for missing optional config;
 * throws for truly required config (handled by auth.js and firestore.js).
 */
function validateSecrets() {
  const warnings = [];

  if (!cronSecret) {
    warnings.push('CRON_SECRET is not set — /api/cron/tick will reject all external requests');
  }
  if (!adminSessionSecret) {
    warnings.push('ADMIN_SESSION_SECRET is not set — deriving from ADMIN_PASSWORD (less secure, set a separate secret)');
  }
  if (!firebase.projectId) {
    warnings.push('FIREBASE_PROJECT_ID is not set — Firestore will fail on first request');
  }
  if (!cloudinary.cloudName) {
    warnings.push('CLOUDINARY_CLOUD_NAME is not set — media uploads will fail');
  }
  if (!tiktok.clientKey || !tiktok.clientSecret) {
    warnings.push('TIKTOK_CLIENT_KEY/SECRET not set — TikTok OAuth will not work');
  }
  // YouTube is optional: silence when fully absent, but a PARTIAL
  // configuration is a mistake worth surfacing at boot.
  const youtubeValues = [youtube.clientId, youtube.clientSecret, tokenEncryption.keys[1]];
  const youtubePresent = youtubeValues.filter(Boolean).length;
  if (youtubePresent > 0 && youtubePresent < youtubeValues.length) {
    warnings.push(
      'YouTube is partially configured — set all of YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, and TOKEN_ENCRYPTION_KEY (the provider stays unavailable until complete)'
    );
  }

  return warnings;
}

// Expose nested objects for validateSecrets
const { cronSecret, adminSessionSecret, firebase, cloudinary, tiktok, youtube, tokenEncryption } = module.exports;

module.exports.validateSecrets = validateSecrets;
