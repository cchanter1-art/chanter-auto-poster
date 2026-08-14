'use strict';

// Canonical provider domain for the AutoPoster product.
//
// This registry is declarative capability truth: it says what each publishing
// provider is, whether it is implemented, and what it can do. It owns no
// business operations — it never touches Firestore, the queue, tokens, or a
// provider API. Callers (application service, scheduler worker, routes)
// consult it and then use their existing execution paths.
//
// Provider #1 is TikTok. Provider #2 is YouTube: a real integration
// (server-side Google OAuth, encrypted token custody, resumable private
// uploads via src/youtube.js) that is ACTIVE only when fully configured —
// otherwise it stays implemented-but-disabled and fails closed. Instagram
// has a real but env-gated partial integration (legacy singleton auth +
// manual test route + worker path); it is never schedulable through the
// product queue. LinkedIn is a reserved identifier only — no adapter, no
// OAuth, no posting support — and must fail closed everywhere.

const config = require('./config');
const mediaPolicy = require('./mediaPolicy');
const tokenVault = require('./tokenVault');

const PROVIDER_TIKTOK = 'tiktok';
const PROVIDER_INSTAGRAM = 'instagram';
const PROVIDER_YOUTUBE = 'youtube';
const PROVIDER_LINKEDIN = 'linkedin';

// Implementation status vocabulary. Only TikTok may be "active".
const IMPLEMENTATION_STATUS = Object.freeze({
  ACTIVE: 'active',
  DEVELOPMENT: 'development',
  DISABLED: 'disabled',
  UNSUPPORTED: 'unsupported'
});

// How a stored provider value was resolved (see normalizeStoredProviderId).
const PROVIDER_SOURCE_EXPLICIT = 'explicit';
const PROVIDER_SOURCE_LEGACY_DEFAULT = 'legacy_default';

class ProviderError extends Error {
  constructor(message, { status = 400, code = 'unknown_provider', details = {} } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/**
 * YouTube configuration truth (single source — the adapter re-exports
 * this). `configured` is true only when every piece of a REAL, safe flow
 * exists: OAuth client credentials, the exact redirect URI, an encryption
 * key for token custody, and the enable flag. `missing` reports env var
 * NAMES only, never values.
 *
 * `privateOnly` is a separate authorization ceiling, not a configuration
 * requirement: it decides WHICH visibilities a job may request, which is why
 * it is published as `allowedVisibilities` rather than folded into
 * `configured`. On (the default) the deployment publishes private only; off,
 * a job may additionally request public — and must do so explicitly.
 */
function getYouTubeConfigStatus() {
  const missing = [];
  if (!config.youtube.clientId) missing.push('YOUTUBE_CLIENT_ID');
  if (!config.youtube.clientSecret) missing.push('YOUTUBE_CLIENT_SECRET');
  if (!config.youtube.redirectUri) missing.push('YOUTUBE_REDIRECT_URI');
  if (!tokenVault.isVaultConfigured()) missing.push('TOKEN_ENCRYPTION_KEY');
  const enabled = Boolean(config.youtube.enabled);
  const privateOnly = Boolean(config.youtube.privateOnly);
  return {
    enabled,
    privateOnly,
    allowedVisibilities: privateOnly
      ? Object.freeze(['private'])
      : Object.freeze(['private', 'public']),
    configured: enabled && missing.length === 0,
    missing
  };
}

const YOUTUBE_CONFIGURED = getYouTubeConfigStatus().configured;
// Whether this deployment authorizes a job to request public visibility at
// all. A job must still ask for it explicitly; this is only the ceiling.
const YOUTUBE_PUBLIC_AUTHORIZED = getYouTubeConfigStatus().allowedVisibilities.includes('public');

const DEFINITIONS = deepFreeze({
  [PROVIDER_TIKTOK]: {
    id: PROVIDER_TIKTOK,
    displayName: 'TikTok',
    implementationStatus: IMPLEMENTATION_STATUS.ACTIVE,
    authMode: 'oauth2_authorization_code',
    connection: { supported: true, mode: 'oauth', route: '/connect/tiktok' },
    // Declared from actual product behavior, not aspiration: new intake is
    // video-only (mediaPolicy.js), publishing is Direct Post via the queue,
    // and every job requires the human approval gate before the worker may
    // claim it. TikTok's API here has no remote status lookup, remote
    // deletion, or analytics surface in this product.
    capabilities: {
      schedulable: true,
      directPost: true,
      videoPublishing: true,
      imagePublishing: false,
      mediaTypes: ['video'],
      videoFormats: [...mediaPolicy.VIDEO_EXTENSIONS],
      privacyControls: true,
      captionsSupported: true,
      remoteStatusLookup: false,
      remoteDeletion: false,
      analytics: false,
      approvalRequired: true
    },
    mediaValidationPolicy: 'video_only'
  },
  [PROVIDER_INSTAGRAM]: {
    id: PROVIDER_INSTAGRAM,
    displayName: 'Instagram',
    // A partial Meta Graph integration exists (legacy single-account auth
    // doc, manual admin test route, worker path), gated behind
    // ENABLE_INSTAGRAM which defaults off. It is not connectable through
    // the canonical connected-account model and never schedulable through
    // the product queue.
    implementationStatus: config.ENABLE_INSTAGRAM
      ? IMPLEMENTATION_STATUS.DEVELOPMENT
      : IMPLEMENTATION_STATUS.DISABLED,
    authMode: 'oauth2_authorization_code',
    connection: { supported: false, mode: 'legacy_singleton' },
    capabilities: {
      schedulable: false,
      directPost: false,
      videoPublishing: false,
      imagePublishing: false,
      mediaTypes: [],
      videoFormats: [],
      privacyControls: false,
      captionsSupported: false,
      remoteStatusLookup: false,
      remoteDeletion: false,
      analytics: false,
      approvalRequired: true
    },
    mediaValidationPolicy: 'none'
  },
  [PROVIDER_YOUTUBE]: {
    id: PROVIDER_YOUTUBE,
    displayName: 'YouTube',
    // Implemented (src/youtube.js adapter + OAuth routes exist) but ACTIVE
    // only when fully configured — implemented / configured / connected /
    // publishingReady / available are distinct truths (see
    // getProviderStatus and connectedAccounts.js).
    implementationStatus: YOUTUBE_CONFIGURED
      ? IMPLEMENTATION_STATUS.ACTIVE
      : IMPLEMENTATION_STATUS.DISABLED,
    authMode: 'oauth2_authorization_code',
    connection: { supported: true, mode: 'oauth', route: '/connect/youtube' },
    // Declared from actual adapter behavior: resumable video upload with
    // subscriber notifications forced off, status lookup via videos.list
    // (youtube.readonly). Visibility is private unless a job explicitly
    // requests public AND the deployment authorizes it, so publicPublishing
    // reports the deployment's real ceiling. Unlisted publishing, native
    // publishAt scheduling, deletion, analytics, thumbnails, live
    // streaming, and playlists are NOT implemented and fail closed.
    capabilities: {
      schedulable: true,
      directPost: true,
      videoPublishing: true,
      imagePublishing: false,
      mediaTypes: ['video'],
      videoFormats: [...mediaPolicy.VIDEO_EXTENSIONS],
      privacyControls: true,
      captionsSupported: false,
      remoteStatusLookup: true,
      remoteDeletion: false,
      analytics: false,
      approvalRequired: true,
      privateVideoUpload: true,
      publicPublishing: YOUTUBE_PUBLIC_AUTHORIZED,
      unlistedPublishing: false,
      subscriberNotifications: false,
      nativeScheduledPublish: false,
      thumbnailUpload: false,
      liveStreaming: false,
      playlistManagement: false
    },
    // Publishing policy enforced by the adapter on every upload. The
    // default visibility applies unless a job explicitly requests another
    // one AND the deployment authorizes it (getYouTubeConfigStatus().
    // allowedVisibilities); notifySubscribers can never be overridden.
    publishingPolicy: {
      defaultPrivacyStatus: 'private',
      requestablePrivacyStatuses: ['private', 'public'],
      notifySubscribers: false
    },
    metadataRequirements: { titleRequired: true, titleMaxLength: 100, descriptionMaxLength: 5000 },
    mediaValidationPolicy: 'video_only'
  },
  [PROVIDER_LINKEDIN]: {
    id: PROVIDER_LINKEDIN,
    displayName: 'LinkedIn',
    implementationStatus: IMPLEMENTATION_STATUS.UNSUPPORTED,
    authMode: 'none',
    connection: { supported: false, mode: 'none' },
    capabilities: {
      schedulable: false,
      directPost: false,
      videoPublishing: false,
      imagePublishing: false,
      mediaTypes: [],
      videoFormats: [],
      privacyControls: false,
      captionsSupported: false,
      remoteStatusLookup: false,
      remoteDeletion: false,
      analytics: false,
      approvalRequired: true
    },
    mediaValidationPolicy: 'none'
  }
});

function normalizeProviderId(value) {
  return String(value || '').trim().toLowerCase();
}

function isKnownProvider(providerId) {
  return Boolean(DEFINITIONS[normalizeProviderId(providerId)]);
}

function getProviderDefinition(providerId) {
  return DEFINITIONS[normalizeProviderId(providerId)] || null;
}

function getImplementationStatus(providerId) {
  const definition = getProviderDefinition(providerId);
  return definition ? definition.implementationStatus : null;
}

function isProviderActive(providerId) {
  return getImplementationStatus(providerId) === IMPLEMENTATION_STATUS.ACTIVE;
}

/**
 * Resolves a stored provider value under the documented backward-
 * compatibility rule:
 *
 *   MISSING legacy provider value  -> normalize to TikTok (legacy_default)
 *   EXPLICIT provider value        -> kept as-is; unknown values stay
 *                                     unknown (known: false) and must never
 *                                     silently become TikTok.
 */
function normalizeStoredProviderId(rawValue) {
  const value = normalizeProviderId(rawValue);
  if (!value) {
    return { providerId: PROVIDER_TIKTOK, source: PROVIDER_SOURCE_LEGACY_DEFAULT, known: true };
  }
  return { providerId: value, source: PROVIDER_SOURCE_EXPLICIT, known: Boolean(DEFINITIONS[value]) };
}

/**
 * Fail-closed gate for every new scheduling write. Unknown providers and
 * providers that are not active are rejected with structured errors; there
 * is no fallback to TikTok here.
 */
function assertSchedulableProvider(providerId) {
  const normalized = normalizeProviderId(providerId);
  const definition = DEFINITIONS[normalized];
  if (!definition) {
    throw new ProviderError(`Unsupported publishing provider: ${normalized || '(empty)'}.`, {
      status: 400,
      code: 'unknown_provider'
    });
  }
  if (definition.implementationStatus !== IMPLEMENTATION_STATUS.ACTIVE || !definition.capabilities.schedulable) {
    throw new ProviderError(
      `Publishing provider ${definition.displayName} is ${definition.implementationStatus} and cannot schedule posts.`,
      {
        status: 400,
        code: 'provider_not_schedulable',
        details: { provider: definition.id, implementationStatus: definition.implementationStatus }
      }
    );
  }
  return definition;
}

/**
 * Declarative capability lookup. Unknown providers and unknown capability
 * names fail closed with structured errors instead of returning a default.
 */
function providerSupportsCapability(providerId, capability) {
  const definition = getProviderDefinition(providerId);
  if (!definition) {
    throw new ProviderError(`Unsupported publishing provider: ${normalizeProviderId(providerId) || '(empty)'}.`, {
      status: 400,
      code: 'unknown_provider'
    });
  }
  const key = String(capability || '').trim();
  if (!(key in definition.capabilities) || typeof definition.capabilities[key] !== 'boolean') {
    throw new ProviderError(`Unknown provider capability: ${key || '(empty)'}.`, {
      status: 400,
      code: 'unknown_capability',
      details: { provider: definition.id }
    });
  }
  return definition.capabilities[key];
}

function assertProviderCapability(providerId, capability) {
  if (!providerSupportsCapability(providerId, capability)) {
    const definition = getProviderDefinition(providerId);
    throw new ProviderError(
      `Publishing provider ${definition.displayName} does not support ${capability}.`,
      {
        status: 400,
        code: 'capability_unsupported',
        details: { provider: definition.id, capability }
      }
    );
  }
  return true;
}

function providerSupportsMediaType(providerId, mediaType) {
  const definition = getProviderDefinition(providerId);
  if (!definition) {
    throw new ProviderError(`Unsupported publishing provider: ${normalizeProviderId(providerId) || '(empty)'}.`, {
      status: 400,
      code: 'unknown_provider'
    });
  }
  return definition.capabilities.mediaTypes.includes(String(mediaType || '').trim().toLowerCase());
}

/**
 * Safe display metadata (no credentials exist in this registry at all, but
 * this is the shape intended for UI/evidence serialization).
 */
function getProviderSummary(providerId) {
  const definition = getProviderDefinition(providerId);
  if (!definition) return null;
  return {
    id: definition.id,
    displayName: definition.displayName,
    implementationStatus: definition.implementationStatus,
    connectionSupported: definition.connection.supported,
    schedulable: definition.capabilities.schedulable,
    mediaTypes: [...definition.capabilities.mediaTypes],
    mediaValidationPolicy: definition.mediaValidationPolicy
  };
}

function listProviderSummaries() {
  return Object.keys(DEFINITIONS).map(getProviderSummary);
}

/**
 * Deployment-level provider status truth, kept as separate booleans (never
 * collapsed into one flag):
 *
 *   implemented — real adapter code exists in this repository
 *   configured  — this deployment has everything the adapter needs
 *   available   — implemented AND configured AND registry-active
 *
 * "connected" and "publishingReady" are per-account truths and live in
 * connectedAccounts.js, not here. `missing` contains env var names only.
 */
function getProviderStatus(providerId) {
  const definition = getProviderDefinition(providerId);
  if (!definition) return null;
  let implemented;
  let configured;
  let missing = [];
  switch (definition.id) {
    case PROVIDER_TIKTOK:
      implemented = true;
      configured = Boolean(config.tiktok.clientKey && config.tiktok.clientSecret);
      break;
    case PROVIDER_YOUTUBE: {
      const status = getYouTubeConfigStatus();
      implemented = true;
      configured = status.configured;
      missing = status.missing;
      break;
    }
    case PROVIDER_INSTAGRAM:
      implemented = true;
      configured = definition.implementationStatus !== IMPLEMENTATION_STATUS.DISABLED;
      break;
    default:
      implemented = false;
      configured = false;
  }
  return {
    id: definition.id,
    displayName: definition.displayName,
    implemented,
    configured,
    available: implemented && configured
      && definition.implementationStatus === IMPLEMENTATION_STATUS.ACTIVE,
    implementationStatus: definition.implementationStatus,
    connectionSupported: definition.connection.supported,
    connectionRoute: definition.connection.route || '',
    missing
  };
}

module.exports = {
  PROVIDER_TIKTOK,
  PROVIDER_INSTAGRAM,
  PROVIDER_YOUTUBE,
  PROVIDER_LINKEDIN,
  IMPLEMENTATION_STATUS,
  PROVIDER_SOURCE_EXPLICIT,
  PROVIDER_SOURCE_LEGACY_DEFAULT,
  ProviderError,
  isKnownProvider,
  getProviderDefinition,
  getImplementationStatus,
  isProviderActive,
  normalizeStoredProviderId,
  assertSchedulableProvider,
  providerSupportsCapability,
  assertProviderCapability,
  providerSupportsMediaType,
  getProviderSummary,
  listProviderSummaries,
  getProviderStatus,
  getYouTubeConfigStatus
};
