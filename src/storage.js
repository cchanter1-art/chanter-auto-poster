const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { DateTime } = require('luxon');
const config = require('./config');
const {
  postsCollection,
  tiktokAccountsCollection,
  youtubeAccountsCollection,
  connectedAccountCapacityCollection,
  postBatchesCollection,
  configDoc,
  getFirestore,
  Timestamp,
  FieldValue
} = require('./firestore');
const { uploadMediaFile, destroyMediaAsset, checkCloudinaryHealth } = require('./cloudinary');
const {
  VIDEO_ONLY_UPLOAD_MESSAGE,
  VIDEO_ONLY_URL_MESSAGE,
  isVideoUploadFile,
  isVideoMediaUrl
} = require('./mediaPolicy');
const providers = require('./providers');
const tokenVault = require('./tokenVault');
const {
  appendProviderOperationEvent,
  canonicalSha256,
  claimReconciliationLease,
  operationMediaBinding,
  reconciliationLeaseAuthorizes,
  sanitizeProviderOperation,
  sanitizeProviderStatusReceipt,
  TERMINAL_OPERATION_STATES,
  transitionProviderOperation
} = require('./youtubeProviderOperation');
const { sanitizeApprovedMediaIdentity } = require('./approvedMediaIdentity');
const { normalizeSoundMode } = require('./tiktokSoundMode');
const {
  DEFAULT_USER_ID,
  postFromDoc,
  mapPatchToFirestore,
  appendHistoryEntry,
  toTimestampOrNull,
  normalizeQueueStatus,
  resolvePublishAttemptBudget
} = require('./postsMapper');
const { generateAccessCode, parseAccessCode, verifyAccessSecret } = require('./clientAuth');
const {
  USAGE_METRIC_SCHEDULED_POSTS,
  createUsageService
} = require('./usageService');

let defaultUsageService = null;
function getUsageService() {
  defaultUsageService ||= createUsageService({ db: getFirestore() });
  return defaultUsageService;
}

function normalizeWorkspaceScope(scope) {
  if (!scope) return { workspaceId: '', allowLegacyOwnerRecords: false };
  if (typeof scope === 'string') {
    return { workspaceId: String(scope).trim(), allowLegacyOwnerRecords: false };
  }
  return {
    workspaceId: String(scope.workspaceId || '').trim(),
    allowLegacyOwnerRecords: Boolean(scope.allowLegacyOwnerRecords)
  };
}

function recordMatchesWorkspace(data, ownerId, scope) {
  const normalized = normalizeWorkspaceScope(scope);
  if (!normalized.workspaceId) return true;
  const storedWorkspaceId = String((data && data.workspaceId) || '').trim();
  if (storedWorkspaceId) return storedWorkspaceId === normalized.workspaceId;
  return normalized.allowLegacyOwnerRecords
    && String((data && data.userId) || DEFAULT_USER_ID) === ownerId;
}

function workspaceIdForWrite(previous, scope) {
  const normalized = normalizeWorkspaceScope(scope);
  const storedWorkspaceId = String((previous && previous.workspaceId) || '').trim();
  if (
    normalized.workspaceId
    && storedWorkspaceId
    && storedWorkspaceId !== normalized.workspaceId
  ) {
    const error = new Error('Publishing account is assigned to another workspace');
    error.status = 404;
    error.code = 'not_found';
    throw error;
  }
  return normalized.workspaceId || storedWorkspaceId || '';
}

class ConnectedAccountActivationError extends Error {
  constructor(message, { code = 'account_activation_denied', details = {} } = {}) {
    super(message);
    this.name = 'ConnectedAccountActivationError';
    this.status = 409;
    this.code = code;
    this.details = details;
  }
}

function connectedAccountKey(provider, accountId) {
  return `${provider}:${String(accountId || '').trim()}`;
}

function capacityDocId(workspaceId) {
  return encodeURIComponent(String(workspaceId || '').trim());
}

function normalizeActivationLimit(value, name) {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ConnectedAccountActivationError('Connected-account entitlement truth is invalid.', {
      code: 'commercial_truth_unverified',
      details: { entitlement: name }
    });
  }
  return value;
}

function normalizeAccountActivationContext(input, { ownerId, provider, workspaceScope }) {
  const scope = normalizeWorkspaceScope(workspaceScope);
  const workspaceId = String((input && input.workspaceId) || '').trim();
  const resolvedOwnerId = String((input && input.ownerUserId) || '').trim();
  const resolvedProvider = String((input && input.provider) || '').trim().toLowerCase();
  if (
    !workspaceId
    || workspaceId !== scope.workspaceId
    || resolvedOwnerId !== ownerId
    || resolvedProvider !== provider
  ) {
    throw new ConnectedAccountActivationError('Connected-account commercial truth could not be verified.', {
      code: 'commercial_truth_unverified'
    });
  }
  return {
    workspaceId,
    connectedAccountLimit: normalizeActivationLimit(
      input.connectedAccountLimit,
      'connectedAccountLimit'
    ),
    providerLimit: normalizeActivationLimit(input.providerLimit, 'providerLimit')
  };
}

function connectedTikTokData(data) {
  return Boolean(data && data.connected && data.access_token);
}

function connectedYouTubeData(data) {
  return Boolean(data && data.connected && data.tokenPresent);
}

function activeAccountEntry(provider, data) {
  const accountId = String((data && (data.accountId || data.open_id || data.channelId)) || '').trim();
  return accountId ? { key: connectedAccountKey(provider, accountId), provider, accountId } : null;
}

function activeAccountsFromSnapshots({ ownerId, workspaceScope, tiktokSnapshot, youtubeSnapshot }) {
  const active = new Map();
  for (const doc of (tiktokSnapshot && tiktokSnapshot.docs) || []) {
    const data = doc.data() || {};
    if (!connectedTikTokData(data) || !recordMatchesWorkspace(data, ownerId, workspaceScope)) continue;
    const entry = activeAccountEntry('tiktok', data);
    if (entry) active.set(entry.key, entry);
  }
  for (const doc of (youtubeSnapshot && youtubeSnapshot.docs) || []) {
    const data = doc.data() || {};
    if (!connectedYouTubeData(data) || !recordMatchesWorkspace(data, ownerId, workspaceScope)) continue;
    const entry = activeAccountEntry('youtube', data);
    if (entry) active.set(entry.key, entry);
  }
  return active;
}

function capacityDocument({ workspaceId, ownerId, activeAccounts, now }) {
  const entries = [...activeAccounts.values()]
    .sort((left, right) => left.key.localeCompare(right.key));
  return {
    workspaceId,
    ownerUserId: ownerId,
    connectedAccountCount: entries.length,
    activeProviderIds: [...new Set(entries.map((entry) => entry.provider))].sort(),
    activeAccounts: entries,
    updatedAt: now
  };
}

function assertCapacityAllowsActivation(activeAccounts, accountEntry, activation) {
  if (activeAccounts.has(accountEntry.key)) return;
  const prospective = new Map(activeAccounts);
  prospective.set(accountEntry.key, accountEntry);
  if (
    activation.connectedAccountLimit !== null
    && prospective.size > activation.connectedAccountLimit
  ) {
    throw new ConnectedAccountActivationError(
      `The current plan has reached its connected account limit. Current: ${activeAccounts.size}. Limit: ${activation.connectedAccountLimit}.`,
      {
        code: 'connected_account_limit_reached',
        details: {
          workspaceId: activation.workspaceId,
          current: activeAccounts.size,
          limit: activation.connectedAccountLimit,
          remaining: 0
        }
      }
    );
  }
  const providers = new Set([...prospective.values()].map((entry) => entry.provider));
  if (activation.providerLimit !== null && providers.size > activation.providerLimit) {
    throw new ConnectedAccountActivationError(
      `The current plan has reached its active provider limit. Current: ${new Set([...activeAccounts.values()].map((entry) => entry.provider)).size}. Limit: ${activation.providerLimit}.`,
      {
        code: 'provider_limit_reached',
        details: {
          workspaceId: activation.workspaceId,
          current: new Set([...activeAccounts.values()].map((entry) => entry.provider)).size,
          limit: activation.providerLimit,
          remaining: 0
        }
      }
    );
  }
}

async function transactConnectedAccountActivation({
  ownerId,
  provider,
  accountId,
  workspaceScope,
  activationContext,
  accountRef,
  buildAccountData
}) {
  const activation = normalizeAccountActivationContext(activationContext, {
    ownerId,
    provider,
    workspaceScope
  });
  const scope = normalizeWorkspaceScope(workspaceScope);
  const db = getFirestore();
  const capacityRef = connectedAccountCapacityCollection().doc(capacityDocId(activation.workspaceId));
  return db.runTransaction(async (transaction) => {
    // Every read intentionally precedes every write (required by Firestore).
    // Reading the shared workspace capacity document serializes otherwise
    // distinct account activations; reading the globally keyed account doc
    // serializes cross-owner attempts for the same provider identity.
    const accountSnapshot = await transaction.get(accountRef);
    const capacitySnapshot = await transaction.get(capacityRef);
    const tiktokSnapshot = await transaction.get(
      tiktokAccountsCollection().where('userId', '==', ownerId)
    );
    const youtubeSnapshot = await transaction.get(
      youtubeAccountsCollection().where('userId', '==', ownerId)
    );
    const previous = accountSnapshot.exists ? accountSnapshot.data() || {} : {};
    if (accountSnapshot.exists && (previous.userId || DEFAULT_USER_ID) !== ownerId) {
      throw new ConnectedAccountActivationError(
        `${provider === 'youtube' ? 'YouTube channel' : 'TikTok account'} is already assigned to another app user`,
        { code: 'account_already_assigned' }
      );
    }
    const storedWorkspaceId = String(previous.workspaceId || '').trim();
    if (storedWorkspaceId && storedWorkspaceId !== activation.workspaceId) {
      throw new ConnectedAccountActivationError(
        `${provider === 'youtube' ? 'YouTube channel' : 'TikTok account'} is already assigned to another workspace`,
        { code: 'account_already_assigned' }
      );
    }
    if (accountSnapshot.exists && !storedWorkspaceId && !scope.allowLegacyOwnerRecords) {
      throw new ConnectedAccountActivationError(
        'Legacy publishing-account ownership is not verified for this workspace.',
        { code: 'account_workspace_unverified' }
      );
    }
    if (
      capacitySnapshot.exists
      && String((capacitySnapshot.data() || {}).ownerUserId || '').trim()
      && String((capacitySnapshot.data() || {}).ownerUserId || '').trim() !== ownerId
    ) {
      throw new ConnectedAccountActivationError(
        'Connected-account capacity ownership could not be verified.',
        { code: 'commercial_truth_unverified' }
      );
    }

    const activeAccounts = activeAccountsFromSnapshots({
      ownerId,
      workspaceScope,
      tiktokSnapshot,
      youtubeSnapshot
    });
    const entry = { key: connectedAccountKey(provider, accountId), provider, accountId };
    const now = Timestamp.now();
    const data = buildAccountData(previous, now, activation.workspaceId);
    const willBeConnected = provider === 'youtube'
      ? connectedYouTubeData(data)
      : connectedTikTokData(data);
    if (!willBeConnected) {
      throw new ConnectedAccountActivationError(
        `${provider === 'youtube' ? 'YouTube' : 'TikTok'} credentials were not usable, so the account was not connected.`,
        { code: 'provider_credentials_unverified' }
      );
    }
    assertCapacityAllowsActivation(activeAccounts, entry, activation);
    activeAccounts.set(entry.key, entry);

    transaction.set(accountRef, data, { merge: true });
    transaction.set(capacityRef, capacityDocument({
      workspaceId: activation.workspaceId,
      ownerId,
      activeAccounts,
      now
    }), { merge: false });
    return data;
  });
}

async function transactConnectedAccountDisconnect({
  ownerId,
  provider,
  accountId,
  workspaceScope,
  accountRef,
  disconnectPatch
}) {
  const scope = normalizeWorkspaceScope(workspaceScope);
  if (!scope.workspaceId) return null;
  const db = getFirestore();
  const capacityRef = connectedAccountCapacityCollection().doc(capacityDocId(scope.workspaceId));
  return db.runTransaction(async (transaction) => {
    const accountSnapshot = await transaction.get(accountRef);
    await transaction.get(capacityRef);
    const tiktokSnapshot = await transaction.get(
      tiktokAccountsCollection().where('userId', '==', ownerId)
    );
    const youtubeSnapshot = await transaction.get(
      youtubeAccountsCollection().where('userId', '==', ownerId)
    );
    if (
      !accountSnapshot.exists
      || (accountSnapshot.data().userId || DEFAULT_USER_ID) !== ownerId
      || !recordMatchesWorkspace(accountSnapshot.data(), ownerId, workspaceScope)
    ) return false;

    const activeAccounts = activeAccountsFromSnapshots({
      ownerId,
      workspaceScope,
      tiktokSnapshot,
      youtubeSnapshot
    });
    activeAccounts.delete(connectedAccountKey(provider, accountId));
    const now = Timestamp.now();
    transaction.set(accountRef, { ...disconnectPatch, updatedAt: now }, { merge: true });
    transaction.set(capacityRef, capacityDocument({
      workspaceId: scope.workspaceId,
      ownerId,
      activeAccounts,
      now
    }), { merge: false });
    return true;
  });
}

const defaultSettings = {
  dailyPostTime: '09:00',
  updatedAt: null
};

const defaultTikTokAuth = {
  connected: false,
  open_id: '',
  access_token: '',
  refresh_token: '',
  expires_at: null,
  scope: ''
};

const defaultInstagramAuth = {
  connected: false,
  source: '',
  user_id: '',
  access_token: '',
  token_type: '',
  expires_at: null,
  scope: '',
  facebook_page_id: '',
  facebook_page_name: '',
  facebook_page_access_token: '',
  instagram_business_account_id: '',
  instagram_username: '',
  account_type: '',
  profile_picture_url: '',
  media_count: null,
  followers_count: null,
  connected_at: null,
  updated_at: null
};

// ── Bootstrap ────────────────────────────────────────────────────────────

async function ensureStorage() {
  // Firestore needs no directories on disk. This now (a) fails fast and
  // loud at boot if the Admin SDK credentials are missing/bad, instead of
  // booting a server that 500s on the first request, and (b) seeds the
  // singleton config docs the app expects to always exist, mirroring the
  // old "create default JSON files on first run" behaviour.
  const db = getFirestore();
  await db.collection('config').limit(1).get();

  await Promise.all([
    ensureConfigDoc('settings', defaultSettings),
    ensureConfigDoc('tiktokAuth', defaultTikTokAuth),
    ensureConfigDoc('instagramAuth', defaultInstagramAuth)
  ]);
}

async function ensureConfigDoc(name, defaults) {
  const ref = configDoc(name);
  const snap = await ref.get();
  if (!snap.exists) {
    await ref.set(defaults);
  }
}

async function checkMediaStorageHealth({ writeTest = false } = {}) {
  return checkCloudinaryHealth({ writeTest });
}

// TikTok accounts

function tiktokAccountDocId(accountId) {
  return encodeURIComponent(String(accountId || '').trim());
}

function tiktokAccountFromDoc(doc) {
  const data = doc.data() || {};
  const accountId = String(data.accountId || data.open_id || '').trim();
  return {
    accountId,
    id: accountId,
    userId: data.userId || DEFAULT_USER_ID,
    workspaceId: String(data.workspaceId || '').trim(),
    platform: 'tiktok',
    open_id: data.open_id || accountId,
    tiktokOpenId: data.open_id || accountId,
    username: data.username || '',
    displayName: data.displayName || '',
    avatarUrl: data.avatarUrl || '',
    connected: Boolean(data.connected && data.access_token),
    access_token: data.access_token || '',
    refresh_token: data.refresh_token || '',
    expires_at: data.expires_at || null,
    scope: data.scope || '',
    createdAt: data.createdAt || null,
    updatedAt: data.updatedAt || null,
    connectedAt: data.connectedAt || null,
    // Client portal access (see clientAuth.js). clientLoginId is a
    // non-secret lookup key; only the secret's hash is ever stored.
    clientLoginId: data.clientLoginId || '',
    clientAccessEnabled: Boolean(data.clientLoginId) && data.clientAccessEnabled !== false,
    clientAccessUpdatedAt: data.clientAccessUpdatedAt || null
  };
}

function timestampMillis(value) {
  if (value && typeof value.toMillis === 'function') return value.toMillis();
  if (value && typeof value.toDate === 'function') return value.toDate().getTime();
  const parsed = new Date(value || 0).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

async function saveTikTokAccount(userId, auth, profile = {}, workspaceScope, activationContext) {
  const ownerId = userId || DEFAULT_USER_ID;
  const accountId = String(auth.open_id || auth.accountId || '').trim();
  if (!accountId) throw new Error('TikTok OAuth did not return an open_id');

  const ref = tiktokAccountsCollection().doc(tiktokAccountDocId(accountId));
  if (activationContext) {
    const data = await transactConnectedAccountActivation({
      ownerId,
      provider: 'tiktok',
      accountId,
      workspaceScope,
      activationContext,
      accountRef: ref,
      buildAccountData(previous, now, workspaceId) {
        return {
          userId: ownerId,
          workspaceId,
          platform: 'tiktok',
          accountId,
          open_id: accountId,
          username: profile.username || profile.creator_username || previous.username || '',
          displayName: profile.displayName || profile.creator_nickname || previous.displayName || '',
          avatarUrl: profile.avatarUrl || profile.creator_avatar_url || previous.avatarUrl || '',
          connected: Boolean(auth.access_token || previous.access_token),
          access_token: auth.access_token || previous.access_token || '',
          refresh_token: auth.refresh_token || previous.refresh_token || '',
          expires_at: auth.expires_at || previous.expires_at || null,
          scope: auth.scope || previous.scope || '',
          createdAt: previous.createdAt || now,
          connectedAt: now,
          updatedAt: now
        };
      }
    });
    return tiktokAccountFromDoc({ id: ref.id, data: () => data });
  }
  const snap = await ref.get();
  if (snap.exists && (snap.data().userId || DEFAULT_USER_ID) !== ownerId) {
    throw new Error('TikTok account is already assigned to another app user');
  }

  const previous = snap.exists ? snap.data() : {};
  const workspaceId = workspaceIdForWrite(previous, workspaceScope);
  const now = Timestamp.now();
  const data = {
    userId: ownerId,
    workspaceId,
    platform: 'tiktok',
    accountId,
    open_id: accountId,
    username: profile.username || profile.creator_username || previous.username || '',
    displayName: profile.displayName || profile.creator_nickname || previous.displayName || '',
    avatarUrl: profile.avatarUrl || profile.creator_avatar_url || previous.avatarUrl || '',
    connected: Boolean(auth.access_token || previous.access_token),
    access_token: auth.access_token || previous.access_token || '',
    refresh_token: auth.refresh_token || previous.refresh_token || '',
    expires_at: auth.expires_at || previous.expires_at || null,
    scope: auth.scope || previous.scope || '',
    createdAt: previous.createdAt || now,
    connectedAt: now,
    updatedAt: now
  };
  await ref.set(data, { merge: true });
  return tiktokAccountFromDoc({ id: ref.id, data: () => data });
}

async function updateTikTokAccountProfile(userId, accountId, profile = {}, workspaceScope) {
  const account = await getTikTokAccount(userId, accountId, workspaceScope);
  if (!account) return null;
  const patch = {
    username: profile.username || profile.creator_username || account.username || '',
    displayName: profile.displayName || profile.creator_nickname || account.displayName || '',
    avatarUrl: profile.avatarUrl || profile.creator_avatar_url || account.avatarUrl || '',
    updatedAt: Timestamp.now()
  };
  await tiktokAccountsCollection().doc(tiktokAccountDocId(accountId)).set(patch, { merge: true });
  return { ...account, ...patch };
}

// Canonical collection-only reads for Runtime discovery/preflight. These never
// consult, surface, or migrate the legacy singleton credential document.
async function getCanonicalTikTokAccounts(userId, workspaceScope) {
  const ownerId = userId || DEFAULT_USER_ID;
  const snapshot = await tiktokAccountsCollection().where('userId', '==', ownerId).get();
  return snapshot.docs
    .filter((doc) => recordMatchesWorkspace(doc.data(), ownerId, workspaceScope))
    .map(tiktokAccountFromDoc)
    .sort((a, b) => {
      if (a.connected !== b.connected) return a.connected ? -1 : 1;
      return timestampMillis(b.updatedAt) - timestampMillis(a.updatedAt);
    });
}

async function getCanonicalTikTokAccount(userId, accountId, workspaceScope) {
  const ownerId = userId || DEFAULT_USER_ID;
  const exactId = String(accountId || '');
  if (!exactId || exactId !== exactId.trim() || exactId === 'legacy') return null;
  const snap = await tiktokAccountsCollection().doc(tiktokAccountDocId(exactId)).get();
  if (
    snap.exists
    && (snap.data().userId || DEFAULT_USER_ID) === ownerId
    && recordMatchesWorkspace(snap.data(), ownerId, workspaceScope)
  ) {
    return tiktokAccountFromDoc(snap);
  }
  return null;
}

async function getTikTokAccounts(userId, workspaceScope) {
  const ownerId = userId || DEFAULT_USER_ID;
  const accounts = await getCanonicalTikTokAccounts(ownerId, workspaceScope);

  const legacy = await getTikTokAuth();
  if (
    legacy.connected && legacy.access_token && legacy.open_id &&
    !accounts.some((account) => account.accountId === legacy.open_id)
  ) {
    const scope = normalizeWorkspaceScope(workspaceScope);
    if (!scope.workspaceId || scope.allowLegacyOwnerRecords) {
      accounts.push(await saveTikTokAccount(ownerId, legacy, {}, workspaceScope));
    }
  }

  return accounts.sort((a, b) => {
    if (a.connected !== b.connected) return a.connected ? -1 : 1;
    return timestampMillis(b.updatedAt) - timestampMillis(a.updatedAt);
  });
}

async function getTikTokAccount(userId, accountId, workspaceScope) {
  const ownerId = userId || DEFAULT_USER_ID;
  const normalizedId = String(accountId || '').trim();
  if (!normalizedId || normalizedId === 'legacy') return null;
  const canonical = await getCanonicalTikTokAccount(ownerId, normalizedId, workspaceScope);
  if (canonical) return canonical;

  const legacy = await getTikTokAuth();
  const scope = normalizeWorkspaceScope(workspaceScope);
  if (
    legacy.open_id === normalizedId
    && legacy.connected
    && legacy.access_token
    && (!scope.workspaceId || scope.allowLegacyOwnerRecords)
  ) {
    return saveTikTokAccount(ownerId, legacy, {}, workspaceScope);
  }
  return null;
}

async function disconnectTikTokAccount(userId, accountId, workspaceScope) {
  const ownerId = userId || DEFAULT_USER_ID;
  const normalizedId = String(accountId || '').trim();
  const transactional = await transactConnectedAccountDisconnect({
    ownerId,
    provider: 'tiktok',
    accountId: normalizedId,
    workspaceScope,
    accountRef: tiktokAccountsCollection().doc(tiktokAccountDocId(normalizedId)),
    disconnectPatch: {
      connected: false,
      access_token: '',
      refresh_token: '',
      expires_at: null
    }
  });
  if (transactional !== null) return transactional;
  const account = await getTikTokAccount(ownerId, normalizedId, workspaceScope);
  if (!account) return false;
  await tiktokAccountsCollection().doc(tiktokAccountDocId(normalizedId)).set({
    connected: false,
    access_token: '',
    refresh_token: '',
    expires_at: null,
    updatedAt: Timestamp.now()
  }, { merge: true });
  return true;
}

// ── Client portal access codes ──────────────────────────────────────────
// Deliberately separate from the TikTok OAuth tokens above: this is the
// credential a *client* uses to reach their own scoped portal, never the
// admin. See src/clientAuth.js for the hashing/signing scheme and
// src/clientRoutes.js for how it's consumed.

async function generateClientAccessCode(userId, accountId, workspaceScope) {
  const account = await getTikTokAccount(userId, accountId, workspaceScope);
  if (!account) return null;
  const generated = generateAccessCode();
  const now = Timestamp.now();
  await tiktokAccountsCollection().doc(tiktokAccountDocId(accountId)).set({
    clientLoginId: generated.clientLoginId,
    clientAccessSecretHash: generated.secretHash,
    clientAccessEnabled: true,
    clientAccessCreatedAt: now,
    clientAccessUpdatedAt: now
  }, { merge: true });
  return generated.code;
}

async function revokeClientAccessCode(userId, accountId, workspaceScope) {
  const account = await getTikTokAccount(userId, accountId, workspaceScope);
  if (!account) return false;
  await tiktokAccountsCollection().doc(tiktokAccountDocId(accountId)).set({
    clientAccessEnabled: false,
    clientAccessUpdatedAt: Timestamp.now()
  }, { merge: true });
  return true;
}

// Resolves a pasted access code to exactly one account, or null. This is
// the *only* lookup path that runs before any identity is known — it uses
// an indexed equality query on the non-secret clientLoginId (never a
// collection scan of all accounts), then verifies the secret's hash.
// Fails closed on any missing/disabled/mismatched state.
async function verifyClientAccessCode(rawCode) {
  const parsed = parseAccessCode(rawCode);
  if (!parsed) return null;
  const snapshot = await tiktokAccountsCollection()
    .where('clientLoginId', '==', parsed.clientLoginId)
    .limit(1)
    .get();
  if (snapshot.empty) return null;
  const doc = snapshot.docs[0];
  const data = doc.data() || {};
  if (data.clientAccessEnabled === false) return null;
  if (!verifyAccessSecret(parsed.secret, parsed.clientLoginId, data.clientAccessSecretHash)) return null;
  return tiktokAccountFromDoc(doc);
}

// Re-checked on every client-portal request (not just at login) so
// disabling access takes effect immediately instead of waiting for the
// session token to expire.
async function resolveClientAccount(userId, accountId, workspaceScope) {
  const account = await getTikTokAccount(userId, accountId, workspaceScope);
  if (!account || account.clientAccessEnabled === false) return null;
  return account;
}

// ── YouTube accounts ─────────────────────────────────────────────────────
// One document per connected YouTube channel. The document carries two
// strictly separated layers:
//
//   safe metadata  — everything youtubeAccountFromDoc returns (identity,
//                    connection state, token PRESENCE/expiry booleans,
//                    granted scopes). This is the only layer other modules
//                    may serialize.
//   credential     — the tokenVault envelope (encrypted access/refresh
//                    tokens). Read ONLY via getYouTubeAccountCredential;
//                    never included in the safe record, queue items,
//                    Runtime evidence, or MCP responses.
//
// Unlike TikTok records, no plaintext token field exists here at all.

function youtubeAccountDocId(channelId) {
  return encodeURIComponent(String(channelId || '').trim());
}

function youtubeAccountFromDoc(doc) {
  const data = doc.data() || {};
  const accountId = String(data.accountId || data.channelId || '').trim();
  return {
    accountId,
    id: accountId,
    userId: data.userId || DEFAULT_USER_ID,
    workspaceId: String(data.workspaceId || '').trim(),
    platform: 'youtube',
    provider: 'youtube',
    channelId: accountId,
    username: String(data.username || '').replace(/^@/, ''),
    displayName: data.displayName || '',
    avatarUrl: data.avatarUrl || '',
    connected: Boolean(data.connected && data.tokenPresent),
    // Token PRESENCE metadata only — the encrypted envelope is deliberately
    // not part of this record (see getYouTubeAccountCredential).
    tokenPresent: Boolean(data.tokenPresent),
    refreshTokenPresent: Boolean(data.refreshTokenPresent),
    accessTokenExpiresAt: data.accessTokenExpiresAt || null,
    grantedScopes: data.grantedScopes || '',
    scope: data.grantedScopes || '',
    reauthorizationRequired: Boolean(data.reauthorizationRequired),
    lastRefreshAt: data.lastRefreshAt || null,
    lastRefreshFailureCode: data.lastRefreshFailureCode || '',
    credentialVersion: Number(data.credentialVersion || 0) || null,
    createdAt: data.createdAt || null,
    updatedAt: data.updatedAt || null,
    connectedAt: data.connectedAt || null
  };
}

/**
 * Creates or updates one connected YouTube channel. Ownership is enforced
 * the same way as TikTok: a channel already assigned to another app user
 * cannot be re-bound. Reconnecting an existing channel UPDATES the same
 * document (same connectedAccountId), never a duplicate.
 *
 * `credentialEnvelope` must already be an encrypted tokenVault envelope —
 * this function refuses anything that looks like plaintext credentials.
 */
async function saveYouTubeAccount(
  userId,
  { channelId, profile = {}, credentialEnvelope, tokenMeta = {} },
  workspaceScope,
  activationContext
) {
  const ownerId = userId || DEFAULT_USER_ID;
  const normalizedId = String(channelId || '').trim();
  if (!normalizedId) throw new Error('YouTube connection did not resolve a channel ID');
  if (!credentialEnvelope || typeof credentialEnvelope !== 'object' || !credentialEnvelope.ct) {
    throw new Error('YouTube credentials must be an encrypted envelope; refusing to persist');
  }

  const ref = youtubeAccountsCollection().doc(youtubeAccountDocId(normalizedId));
  if (activationContext) {
    const data = await transactConnectedAccountActivation({
      ownerId,
      provider: 'youtube',
      accountId: normalizedId,
      workspaceScope,
      activationContext,
      accountRef: ref,
      buildAccountData(previous, now, workspaceId) {
        return {
          userId: ownerId,
          workspaceId,
          platform: 'youtube',
          provider: 'youtube',
          accountId: normalizedId,
          channelId: normalizedId,
          username: String(profile.handle || previous.username || '').replace(/^@/, ''),
          displayName: profile.title || previous.displayName || '',
          avatarUrl: profile.thumbnailUrl || previous.avatarUrl || '',
          connected: Boolean(tokenMeta.tokenPresent),
          credential: credentialEnvelope,
          tokenPresent: Boolean(tokenMeta.tokenPresent),
          refreshTokenPresent: Boolean(tokenMeta.refreshTokenPresent),
          accessTokenExpiresAt: tokenMeta.accessTokenExpiresAt || null,
          grantedScopes: tokenMeta.grantedScopes || previous.grantedScopes || '',
          reauthorizationRequired: false,
          lastRefreshAt: previous.lastRefreshAt || null,
          lastRefreshFailureCode: '',
          credentialVersion: Number(credentialEnvelope.kv || 0) || null,
          createdAt: previous.createdAt || now,
          connectedAt: now,
          updatedAt: now
        };
      }
    });
    return youtubeAccountFromDoc({ id: ref.id, data: () => data });
  }
  const snap = await ref.get();
  if (snap.exists && (snap.data().userId || DEFAULT_USER_ID) !== ownerId) {
    throw new Error('YouTube channel is already assigned to another app user');
  }

  const previous = snap.exists ? snap.data() : {};
  const workspaceId = workspaceIdForWrite(previous, workspaceScope);
  const now = Timestamp.now();
  const data = {
    userId: ownerId,
    workspaceId,
    platform: 'youtube',
    provider: 'youtube',
    accountId: normalizedId,
    channelId: normalizedId,
    // Google returns the handle as customUrl ('@name'); the app-wide
    // username convention is bare (views prepend the @).
    username: String(profile.handle || previous.username || '').replace(/^@/, ''),
    displayName: profile.title || previous.displayName || '',
    avatarUrl: profile.thumbnailUrl || previous.avatarUrl || '',
    connected: Boolean(tokenMeta.tokenPresent),
    credential: credentialEnvelope,
    tokenPresent: Boolean(tokenMeta.tokenPresent),
    refreshTokenPresent: Boolean(tokenMeta.refreshTokenPresent),
    accessTokenExpiresAt: tokenMeta.accessTokenExpiresAt || null,
    grantedScopes: tokenMeta.grantedScopes || previous.grantedScopes || '',
    reauthorizationRequired: false,
    lastRefreshAt: previous.lastRefreshAt || null,
    lastRefreshFailureCode: '',
    credentialVersion: Number(credentialEnvelope.kv || 0) || null,
    createdAt: previous.createdAt || now,
    connectedAt: now,
    updatedAt: now
  };
  await ref.set(data, { merge: true });
  return youtubeAccountFromDoc({ id: ref.id, data: () => data });
}

async function getYouTubeAccounts(userId, workspaceScope) {
  const ownerId = userId || DEFAULT_USER_ID;
  const snapshot = await youtubeAccountsCollection().where('userId', '==', ownerId).get();
  return snapshot.docs
    .filter((doc) => recordMatchesWorkspace(doc.data(), ownerId, workspaceScope))
    .map(youtubeAccountFromDoc).sort((a, b) => {
    if (a.connected !== b.connected) return a.connected ? -1 : 1;
    return timestampMillis(b.updatedAt) - timestampMillis(a.updatedAt);
  });
}

async function getYouTubeAccount(userId, channelId, workspaceScope) {
  const ownerId = userId || DEFAULT_USER_ID;
  const normalizedId = String(channelId || '').trim();
  if (!normalizedId || normalizedId === 'legacy') return null;
  const snap = await youtubeAccountsCollection().doc(youtubeAccountDocId(normalizedId)).get();
  if (
    snap.exists
    && (snap.data().userId || DEFAULT_USER_ID) === ownerId
    && recordMatchesWorkspace(snap.data(), ownerId, workspaceScope)
  ) {
    return youtubeAccountFromDoc(snap);
  }
  return null;
}

// Read-only identity index used by the internal Runtime preflight. Unlike
// getTikTokAccounts(), this never consults or lazily migrates the legacy auth
// singleton. It returns only the minimum fields needed to classify an exact
// opaque account reference for the already-authenticated owner; credential,
// connection, profile, and provider payload fields never leave storage.
async function listConnectedAccountReferencesForOwner(userId) {
  const ownerId = userId || DEFAULT_USER_ID;
  const [tiktokSnapshot, youtubeSnapshot] = await Promise.all([
    tiktokAccountsCollection().where('userId', '==', ownerId).get(),
    youtubeAccountsCollection().where('userId', '==', ownerId).get()
  ]);

  const references = [];
  for (const [provider, snapshot] of [
    ['tiktok', tiktokSnapshot],
    ['youtube', youtubeSnapshot]
  ]) {
    for (const doc of snapshot.docs) {
      const data = doc.data() || {};
      const accountId = String(
        provider === 'youtube'
          ? (data.accountId || data.channelId || '')
          : (data.accountId || data.open_id || '')
      );
      if (!accountId) continue;
      references.push({
        provider,
        accountId,
        workspaceId: String(data.workspaceId || '').trim()
      });
    }
  }

  return references.sort((a, b) =>
    a.provider.localeCompare(b.provider) || a.accountId.localeCompare(b.accountId)
  );
}

/**
 * The ONLY read path for the encrypted credential envelope. Ownership
 * enforced; returns the envelope (still encrypted) or null.
 */
async function getYouTubeAccountCredential(userId, channelId, workspaceScope) {
  const ownerId = userId || DEFAULT_USER_ID;
  const normalizedId = String(channelId || '').trim();
  if (!normalizedId) return null;
  const snap = await youtubeAccountsCollection().doc(youtubeAccountDocId(normalizedId)).get();
  if (
    !snap.exists
    || (snap.data().userId || DEFAULT_USER_ID) !== ownerId
    || !recordMatchesWorkspace(snap.data(), ownerId, workspaceScope)
  ) return null;
  return snap.data().credential || null;
}

/**
 * Atomic persist of a refreshed credential state: the new envelope and its
 * safe metadata land in one write, so a crash can never leave metadata
 * describing tokens that were not stored.
 */
async function updateYouTubeAccountTokenState(
  userId,
  channelId,
  { credentialEnvelope, tokenMeta = {} },
  workspaceScope
) {
  const account = await getYouTubeAccount(userId, channelId, workspaceScope);
  if (!account) return null;
  const patch = {
    updatedAt: Timestamp.now()
  };
  if (credentialEnvelope) {
    patch.credential = credentialEnvelope;
    patch.credentialVersion = Number(credentialEnvelope.kv || 0) || null;
  }
  if ('tokenPresent' in tokenMeta) patch.tokenPresent = Boolean(tokenMeta.tokenPresent);
  if ('refreshTokenPresent' in tokenMeta) patch.refreshTokenPresent = Boolean(tokenMeta.refreshTokenPresent);
  if ('accessTokenExpiresAt' in tokenMeta) patch.accessTokenExpiresAt = tokenMeta.accessTokenExpiresAt || null;
  if ('grantedScopes' in tokenMeta && tokenMeta.grantedScopes) patch.grantedScopes = tokenMeta.grantedScopes;
  if ('lastRefreshAt' in tokenMeta) patch.lastRefreshAt = tokenMeta.lastRefreshAt || null;
  if ('lastRefreshFailureCode' in tokenMeta) patch.lastRefreshFailureCode = tokenMeta.lastRefreshFailureCode || '';
  await youtubeAccountsCollection().doc(youtubeAccountDocId(channelId)).set(patch, { merge: true });
  return { ...account, ...patch };
}

/**
 * Truthful reauthorization transition (e.g. Google invalid_grant, expired
 * Testing-mode refresh token). The account stays visibly connected-but-
 * blocked; the worker refuses it until a human reconnects.
 */
async function markYouTubeAccountReauthorizationRequired(userId, channelId, failureCode, workspaceScope) {
  const account = await getYouTubeAccount(userId, channelId, workspaceScope);
  if (!account) return null;
  await youtubeAccountsCollection().doc(youtubeAccountDocId(channelId)).set({
    reauthorizationRequired: true,
    lastRefreshFailureCode: String(failureCode || 'invalid_grant'),
    updatedAt: Timestamp.now()
  }, { merge: true });
  return true;
}

/**
 * Disconnect: removes the encrypted credential envelope and marks the
 * channel disconnected. Publishing fails closed immediately (worker gates
 * on connected + credential presence). Never touches TikTok records.
 */
async function disconnectYouTubeAccount(userId, channelId, workspaceScope) {
  const ownerId = userId || DEFAULT_USER_ID;
  const normalizedId = String(channelId || '').trim();
  const transactional = await transactConnectedAccountDisconnect({
    ownerId,
    provider: 'youtube',
    accountId: normalizedId,
    workspaceScope,
    accountRef: youtubeAccountsCollection().doc(youtubeAccountDocId(normalizedId)),
    disconnectPatch: {
      connected: false,
      credential: null,
      tokenPresent: false,
      refreshTokenPresent: false,
      accessTokenExpiresAt: null,
      reauthorizationRequired: false
    }
  });
  if (transactional !== null) return transactional;
  const account = await getYouTubeAccount(ownerId, normalizedId, workspaceScope);
  if (!account) return false;
  await youtubeAccountsCollection().doc(youtubeAccountDocId(normalizedId)).set({
    connected: false,
    credential: null,
    tokenPresent: false,
    refreshTokenPresent: false,
    accessTokenExpiresAt: null,
    reauthorizationRequired: false,
    updatedAt: Timestamp.now()
  }, { merge: true });
  return true;
}

// ── Posts ────────────────────────────────────────────────────────────────

function comparePosts(a, b) {
  const orderDiff = Number(a.order || 0) - Number(b.order || 0);
  if (orderDiff !== 0) return orderDiff;
  return String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
}

async function getPosts(userId, accountId, workspaceScope) {
  const ownerId = userId || DEFAULT_USER_ID;
  const snapshot = await postsCollection().where('userId', '==', ownerId).get();
  const posts = snapshot.docs
    .filter((doc) => recordMatchesWorkspace(doc.data(), ownerId, workspaceScope))
    .map(postFromDoc);
  const normalizedAccountId = String(accountId || '').trim();
  return posts
    .filter((post) => !normalizedAccountId || post.accountId === normalizedAccountId)
    .sort(comparePosts);
}

async function getDashboardJobs(userId, workspaceScope) {
  const ownerId = userId || DEFAULT_USER_ID;
  const snapshot = await postsCollection().where('userId', '==', ownerId).get();

  return snapshot.docs.filter((doc) => recordMatchesWorkspace(doc.data(), ownerId, workspaceScope)).map((doc) => {
    const data = doc.data() || {};
    const post = postFromDoc(doc);

    return {
      ...post,
      title: data.title || data.postTitle || data.name || data.originalName || data.fileName || '',
      accountId: post.accountId,
      tiktokOpenId: post.tiktokOpenId,
      username: post.username,
      thumbnailUrl:
        data.thumbnailUrl ||
        data.thumbnail ||
        data.coverUrl ||
        data.imagePath ||
        data.publicImageUrl ||
        '',
      // Keep the canonical mapper's scrubbed evidence. Raw legacy
      // lastError/logs/events may contain provider payloads or credentials.
      lastError: post.lastError,
      logs: post.logs
    };
  }).sort(comparePosts);
}

async function getPost(userId, id, accountId, workspaceScope) {
  if (!id) return null;
  const ownerId = userId || DEFAULT_USER_ID;
  const snap = await postsCollection().doc(id).get();
  if (!snap.exists) return null;
  if ((snap.data().userId || DEFAULT_USER_ID) !== ownerId) return null;
  if (!recordMatchesWorkspace(snap.data(), ownerId, workspaceScope)) return null;
  const post = postFromDoc(snap);
  if (accountId && post.accountId !== accountId) return null;
  return post;
}

async function getRecentJobs(limit = 50) {
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 50));
  const snapshot = await postsCollection()
    .orderBy('updatedAt', 'desc')
    .limit(safeLimit)
    .get();
  return snapshot.docs.map(postFromDoc);
}

function nextOrderFor(orderByAccount, accountId) {
  const next = orderByAccount.get(accountId) || 1;
  orderByAccount.set(accountId, next + 1);
  return next;
}

function getUploadMediaType(file) {
  const mime = String(file.mimetype || '').toLowerCase();
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('image/')) return 'photo';

  const extension = path.extname(file.originalname || file.filename || '').toLowerCase();
  if (['.mp4', '.mov', '.webm'].includes(extension)) return 'video';
  return 'photo';
}

function defaultExtension(file) {
  const mime = String(file.mimetype || '').toLowerCase();
  if (mime === 'video/mp4') return '.mp4';
  if (mime === 'video/quicktime') return '.mov';
  if (mime === 'video/webm') return '.webm';
  if (mime === 'image/png') return '.png';
  if (mime === 'image/webp') return '.webp';
  return path.extname(file.originalname || '').toLowerCase() || '.jpg';
}

function getStoredFileName(file) {
  return file.filename || `${Date.now()}-${randomUUID()}${defaultExtension(file)}`;
}

async function saveUploadToCloudinary(file) {
  return uploadMediaFile(file);
}

function cleanupLocalUpload(file) {
  if (!file || !file.path) return;
  try {
    const uploadPath = path.resolve(file.path);
    const uploadsRoot = path.resolve(config.uploadsDir);
    if (uploadPath.startsWith(uploadsRoot)) fs.unlinkSync(uploadPath);
  } catch (error) {
    // The durable copy already lives in Cloudinary; local cleanup is best effort.
  }
}

function getPublicMediaType(mediaUrl) {
  try {
    const pathname = new URL(mediaUrl).pathname.toLowerCase();
    return ['.mp4', '.mov', '.webm'].some((extension) => pathname.endsWith(extension))
      ? 'video'
      : 'photo';
  } catch (error) {
    return 'photo';
  }
}

function isPublicHttpsUrl(mediaUrl) {
  try {
    return new URL(mediaUrl).protocol === 'https:';
  } catch (error) {
    return false;
  }
}

function getPublicMediaName(mediaUrl) {
  try {
    return path.basename(new URL(mediaUrl).pathname) || 'public-media';
  } catch (error) {
    return 'public-media';
  }
}

function getPublicMediaMimeType(mediaType, mediaUrl) {
  const pathname = String(mediaUrl || '').toLowerCase();
  if (pathname.includes('.png')) return 'image/png';
  if (pathname.includes('.webp')) return 'image/webp';
  if (pathname.includes('.mov')) return 'video/quicktime';
  if (pathname.includes('.webm')) return 'video/webm';
  return mediaType === 'video' ? 'video/mp4' : 'image/jpeg';
}

/**
 * Bounded provider-specific queue metadata (Part 3: YouTube only). This is
 * a write-time chokepoint: whatever a caller passes, the stored structure
 * contains exactly these keys, privacyStatus is locked to 'private' and
 * notifySubscribers to false, and no credential-shaped field can ride
 * along. Queue records never carry tokens.
 */
function boundedProviderMetadata(providerId, raw) {
  if (providerId !== 'youtube') return null;
  const youtube = raw && typeof raw === 'object' && raw.youtube && typeof raw.youtube === 'object'
    ? raw.youtube
    : null;
  if (!youtube) return null;
  return {
    youtube: {
      title: String(youtube.title || '').trim(),
      description: String(youtube.description || '').trim(),
      privacyStatus: 'private',
      notifySubscribers: false
    }
  };
}

function normalizeTargetAccounts(defaults, providerId = 'tiktok') {
  // Multi-channel campaigns pass defaults.accounts (one entry per target
  // Publishing Channel). The legacy single-account fields remain the
  // fallback so every existing call site keeps working unchanged.
  const rawAccounts = Array.isArray(defaults.accounts) && defaults.accounts.length > 0
    ? defaults.accounts
    : [{
        accountId: defaults.accountId,
        tiktokOpenId: defaults.tiktokOpenId,
        username: defaults.username || defaults.displayName,
        soundMode: defaults.soundMode
      }];

  const seen = new Set();
  const targets = [];
  for (const raw of rawAccounts) {
    const accountId = String((raw && (
      raw.accountId
      || (providerId === 'tiktok' ? (raw.tiktokOpenId || raw.open_id) : '')
    )) || '').trim();
    if (!accountId || accountId === 'legacy' || seen.has(accountId)) continue;
    seen.add(accountId);
    targets.push({
      accountId,
      tiktokOpenId: providerId === 'tiktok'
        ? String((raw && (raw.tiktokOpenId || raw.open_id)) || accountId).trim()
        : '',
      username: String((raw && (raw.username || raw.displayName)) || accountId).trim(),
      // Destination-level TikTok sound mode; validated to the safe default so a
      // missing or unknown value can never reach a stored post document.
      soundMode: normalizeSoundMode(raw && raw.soundMode)
    });
  }
  return targets;
}

async function addUploadedPosts(userId, files, defaults = {}) {
  const ownerId = userId || DEFAULT_USER_ID;
  const workspaceScope = normalizeWorkspaceScope(
    defaults.workspaceScope || {
      workspaceId: defaults.workspaceId,
      allowLegacyOwnerRecords: defaults.allowLegacyOwnerRecords
    }
  );
  if (defaults.commercialEnforcement && !workspaceScope.workspaceId) {
    const error = new Error('A verified workspace is required before queue creation');
    error.status = 403;
    error.code = 'workspace_unverified';
    throw error;
  }
  // Provider fail-closed chokepoint (defense in depth behind the
  // application service): a missing provider keeps the documented TikTok
  // compatibility default, but an explicit unknown provider is refused —
  // no new write may silently fall back to TikTok.
  const providerResolution = providers.normalizeStoredProviderId(defaults.provider || defaults.platform);
  if (!providerResolution.known) {
    const error = new Error(`Unsupported publishing provider: ${providerResolution.providerId}.`);
    error.status = 400;
    throw error;
  }
  const providerId = providerResolution.providerId;
  const targetAccounts = normalizeTargetAccounts(defaults, providerId);
  if (targetAccounts.length === 0) {
    const error = new Error('Select a connected publishing account before creating scheduled posts');
    error.status = 400;
    throw error;
  }
  const uploadFiles = Array.isArray(files) ? files : [];
  // Video-only intake (defense in depth behind the route-level multer
  // filters and URL checks): no creation path may mint a new photo job.
  // Existing photo jobs are untouched — this guards writes only.
  for (const file of uploadFiles) {
    if (!isVideoUploadFile(file)) {
      const error = new Error(VIDEO_ONLY_UPLOAD_MESSAGE);
      error.status = 400;
      throw error;
    }
  }
  const fallbackUrl = String(defaults.publicMediaUrl || defaults.publicImageUrl || '').trim();
  if (fallbackUrl && !isPublicHttpsUrl(fallbackUrl)) {
    const error = new Error('Public Media URL must be a valid HTTPS URL');
    error.status = 400;
    throw error;
  }
  if (fallbackUrl && !isVideoMediaUrl(fallbackUrl)) {
    const error = new Error(VIDEO_ONLY_URL_MESSAGE);
    error.status = 400;
    throw error;
  }
  const sources = uploadFiles.length > 0 ? uploadFiles : (fallbackUrl ? [null] : []);
  if (sources.length === 0) {
    const error = new Error('Choose a media file or enter a public HTTPS media URL');
    error.status = 400;
    throw error;
  }

  // Idempotent application operations may reserve one deterministic post ID.
  // Firestore batch.create then makes concurrent requests converge on one
  // queue document instead of allowing a read-before-write duplicate race.
  const rawScheduleEntries = Array.isArray(defaults.scheduleEntries)
    ? defaults.scheduleEntries
    : [];
  const scheduleEntries = rawScheduleEntries.map((entry, index) => {
    const accountId = String((entry && entry.accountId) || '').trim();
    const scheduledAt = toTimestampOrNull(entry && entry.scheduledAt);
    if (!accountId || !targetAccounts.some((account) => account.accountId === accountId)) {
      const error = new Error('Recurring schedule contains an unknown publishing account');
      error.status = 400;
      throw error;
    }
    if (!scheduledAt) {
      const error = new Error('Recurring schedule contains an invalid timestamp');
      error.status = 400;
      throw error;
    }
    return {
      accountId,
      scheduledAt,
      occurrenceIndex: Number.isInteger(Number(entry.occurrenceIndex)) ? Number(entry.occurrenceIndex) : index,
      occurrenceDate: String(entry.occurrenceDate || '').trim(),
      offsetMinutes: Number.isFinite(Number(entry.offsetMinutes)) ? Number(entry.offsetMinutes) : 0,
      order: Number.isInteger(Number(entry.order)) ? Number(entry.order) : 0
    };
  });
  const scheduleEntriesByAccount = new Map(targetAccounts.map((account) => [account.accountId, []]));
  for (const entry of scheduleEntries) scheduleEntriesByAccount.get(entry.accountId).push(entry);
  if (scheduleEntries.length > 0 && [...scheduleEntriesByAccount.values()].some((entries) => entries.length === 0)) {
    const error = new Error('Recurring schedule must include every selected publishing account');
    error.status = 400;
    throw error;
  }

  // Idempotent application operations may reserve one deterministic post ID.
  // Firestore batch.create then makes concurrent requests converge on one
  // queue document instead of allowing a read-before-write duplicate race.
  const requestedDocumentId = String(defaults.documentId || '').trim();
  if (requestedDocumentId) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(requestedDocumentId)) {
      const error = new Error('Invalid deterministic queue item identifier');
      error.status = 400;
      throw error;
    }
    const requestedJobCount = sources.length * (scheduleEntries.length || targetAccounts.length);
    if (requestedJobCount !== 1) {
      const error = new Error('A deterministic queue item identifier can only be used for one post');
      error.status = 400;
      throw error;
    }
  }
  const initialScheduledAt = toTimestampOrNull(defaults.scheduledAt);
  if (defaults.scheduledAt && !initialScheduledAt) {
    const error = new Error('scheduledAt is not a parseable timestamp');
    error.status = 400;
    throw error;
  }
  const scheduleSeries = defaults.scheduleSeries && typeof defaults.scheduleSeries === 'object'
    ? {
        frequency: String(defaults.scheduleSeries.frequency || '').trim(),
        startDate: String(defaults.scheduleSeries.startDate || '').trim(),
        endDate: String(defaults.scheduleSeries.endDate || '').trim(),
        occurrenceCount: Number(defaults.scheduleSeries.occurrenceCount || 0),
        sourceCount: Number(defaults.scheduleSeries.sourceCount || 0),
        timezone: String(defaults.scheduleSeries.timezone || '').trim()
      }
    : null;
  if (scheduleEntries.length > 0 && (
    !scheduleSeries
    || scheduleSeries.frequency !== 'daily'
    || !scheduleSeries.startDate
    || !scheduleSeries.endDate
    || !Number.isInteger(scheduleSeries.occurrenceCount)
    || scheduleSeries.occurrenceCount < 1
    || !Number.isInteger(scheduleSeries.sourceCount)
    || scheduleSeries.sourceCount < 1
    || scheduleSeries.sourceCount > 100
  )) {
    const error = new Error('Recurring schedule series metadata is invalid');
    error.status = 400;
    throw error;
  }
  if (scheduleEntries.length > 0) {
    if (scheduleSeries.sourceCount !== sources.length) {
      const error = new Error('Recurring schedule source count does not match the submitted media');
      error.status = 400;
      throw error;
    }
    const expectedEntryCount = targetAccounts.length * scheduleSeries.occurrenceCount;
    if (scheduleEntries.length !== expectedEntryCount) {
      const error = new Error('Recurring schedule must contain every occurrence for every selected publishing account');
      error.status = 400;
      throw error;
    }
    for (const [accountId, entries] of scheduleEntriesByAccount.entries()) {
      const occurrenceIndexes = new Set(entries.map((entry) => entry.occurrenceIndex));
      const hasCompleteIndexRange = occurrenceIndexes.size === scheduleSeries.occurrenceCount
        && [...occurrenceIndexes].every((index) => Number.isInteger(index) && index >= 0 && index < scheduleSeries.occurrenceCount);
      if (entries.length !== scheduleSeries.occurrenceCount || !hasCompleteIndexRange) {
        const error = new Error(`Recurring schedule is incomplete for publishing account ${accountId}`);
        error.status = 400;
        throw error;
      }
    }
  }
  const campaignStartAtTimestamp = toTimestampOrNull(defaults.campaignStartAt);
  if (defaults.campaignStartAt && !campaignStartAtTimestamp) {
    const error = new Error('campaignStartAt is not a parseable timestamp');
    error.status = 400;
    throw error;
  }

  // One parent campaign per prepare action; every child job carries this id
  // so evidence and the dashboard can group per-channel releases together.
  const campaignId = String(defaults.campaignId || '').trim() || randomUUID();

  // A human-controlled website flow may record explicit approval at
  // creation. Client single-post intake and the admin's optional recurring
  // series approval use the same fail-closed contract; every other intake
  // remains a draft until approved in the Release Queue.
  const selfApprove = defaults.selfApprove && String(defaults.selfApprove.approvedBy || '').trim()
    ? { approvedBy: String(defaults.selfApprove.approvedBy).trim() }
    : null;

  // One posts read per target channel provides both the next queue order
  // (what getMaxOrder used to derive from the same query) and the
  // duplicate-detection keys for that channel's existing jobs.
  const orderByAccount = new Map();
  const duplicateKeysByAccount = new Map();
  for (const target of targetAccounts) {
    const existingPosts = await getPosts(ownerId, target.accountId, workspaceScope);
    const maxOrder = existingPosts.reduce((max, post) => Math.max(max, Number(post.order || 0)), 0);
    orderByAccount.set(target.accountId, maxOrder + 1);
    const keys = new Set();
    for (const post of existingPosts) {
      if (post.originalName && Number(post.fileSize || 0) > 0) {
        keys.add(`file:${post.originalName}:${Number(post.fileSize)}`);
      }
      if (post.mediaSource === 'public_url' && post.publicMediaUrl) {
        keys.add(`url:${post.publicMediaUrl}`);
      }
    }
    duplicateKeysByAccount.set(target.accountId, keys);
  }

  const now = Timestamp.now();
  const db = getFirestore();
  const batch = db.batch();
  const created = [];
  const cloudinaryAssets = [];
  let committed = false;

  try {
    // Upload once per (target channel x source). A recurring series then
    // creates multiple queue records that share that one asset; deletePost
    // reference-checks before destroying it.
    for (const target of targetAccounts) {
    for (let sourceIdx = 0; sourceIdx < sources.length; sourceIdx += 1) {
      const file = sources[sourceIdx];
      const mediaType = file ? getUploadMediaType(file) : getPublicMediaType(fallbackUrl);
      const fileName = file ? getStoredFileName(file) : getPublicMediaName(fallbackUrl);
      const preparedMedia = file && defaults.preparedMedia
        && String(defaults.preparedMedia.originalName || '') === String(file.originalname || '')
        && Number(defaults.preparedMedia.originalSize || 0) === Number(file.size || 0)
        ? defaults.preparedMedia
        : null;
      let mediaUrl = fallbackUrl;
      let cloudinaryPublicId = '';
      let cloudinaryResourceType = '';
      let storageFallback = false;
      let autoMusicApplied = false;

      if (file) {
        try {
          let uploaded;
          if (preparedMedia) {
            try {
              uploaded = await saveUploadToCloudinary(preparedMedia.file);
              autoMusicApplied = true;
            } catch (error) {
              console.warn('[auto-music] prepared video upload failed; using original video', {
                code: error.code || 'CLOUDINARY_UPLOAD_FAILED'
              });
              uploaded = await saveUploadToCloudinary(file);
            }
          } else {
            uploaded = await saveUploadToCloudinary(file);
          }
          mediaUrl = uploaded.mediaUrl;
          cloudinaryPublicId = uploaded.publicId;
          cloudinaryResourceType = uploaded.resourceType;
          cloudinaryAssets.push({
            publicId: cloudinaryPublicId,
            resourceType: cloudinaryResourceType
          });
        } catch (error) {
          if (!fallbackUrl || uploadFiles.length !== 1) throw error;
          storageFallback = true;
          console.warn('[cloudinary] using submitted public media URL after upload failure', {
            code: error.code || 'CLOUDINARY_UPLOAD_FAILED'
          });
        }
      }

      const publicMediaUrl = cloudinaryPublicId ? mediaUrl : fallbackUrl;

      // Duplicate protection (warn, never block): compare against jobs that
      // existed before this intake. Intentional occurrences inside one daily
      // series do not warn against each other.
      const fileSize = file ? Number(file.size || 0) : 0;
      const duplicateKey = file ? `file:${file.originalname}:${fileSize}` : `url:${fallbackUrl}`;
      const accountDuplicateKeys = duplicateKeysByAccount.get(target.accountId);
      const isDuplicate = file
        ? fileSize > 0 && accountDuplicateKeys.has(duplicateKey)
        : accountDuplicateKeys.has(duplicateKey);
      accountDuplicateKeys.add(duplicateKey);
      const duplicateWarning = isDuplicate
        ? 'Possible duplicate: this channel already has a job with the same media. Posting the same content repeatedly can hurt account trust.'
        : '';

      const jobSchedules = scheduleEntries.length > 0
        ? scheduleEntriesByAccount.get(target.accountId)
        : [null];

      for (const scheduleEntry of jobSchedules) {
        const ref = postsCollection().doc(requestedDocumentId || randomUUID());
        const jobScheduledAt = scheduleEntry ? scheduleEntry.scheduledAt : initialScheduledAt;
        const occurrenceNumber = scheduleEntry ? scheduleEntry.occurrenceIndex + 1 : 0;

        let history = appendHistoryEntry([], 'created', `Draft created for @${target.username} (campaign ${campaignId.slice(0, 8)}).`);
        history = appendHistoryEntry(history, 'validated', duplicateWarning || 'Media accepted and stored.');
        if (selfApprove) {
          history = appendHistoryEntry(history, 'approved', `Approved at creation by ${selfApprove.approvedBy}.`);
        }
        if (jobScheduledAt) {
          const scheduleHistory = defaults.scheduleHistory || {};
          const recurringDetail = scheduleEntry && scheduleSeries
            ? `Daily series occurrence ${occurrenceNumber}/${scheduleSeries.occurrenceCount} scheduled for ${jobScheduledAt.toDate().toISOString()}.`
            : '';
          history = appendHistoryEntry(
            history,
            scheduleEntry ? 'series_scheduled' : (scheduleHistory.event || 'scheduled'),
            recurringDetail || scheduleHistory.detail || `Scheduled at creation for ${jobScheduledAt.toDate().toISOString()}.`
          );
        }

        const data = {
          userId: ownerId,
          workspaceId: workspaceScope.workspaceId,
          platform: providerId,
          // Backward-compatible provider/source metadata for the canonical
          // application contract. Older documents omit these and postsMapper
          // derives provider from platform without inventing a creation source.
          provider: providerId,
          // Canonical connected-account identity (provider:accountId). Legacy
          // documents omit it; postsMapper derives the same composite on read.
          connectedAccountId: `${providerId}:${target.accountId}`,
          creationSource: String(defaults.creationSource || '').trim(),
          createdBy: String(defaults.createdBy || '').trim(),
          correlationId: String(defaults.correlationId || '').trim(),
          idempotencyKey: String(defaults.idempotencyKey || '').trim(),
          runtimeIdempotencyKey: String(defaults.runtimeIdempotencyKey || '').trim(),
          runtimeScheduledBy: String(defaults.runtimeScheduledBy || '').trim(),
          runtimeMissionId: String(defaults.runtimeMissionId || ''),
          runtimeGraphId: String(defaults.runtimeGraphId || ''),
          runtimeAction: String(defaults.runtimeAction || ''),
          runtimePayloadHash: String(defaults.runtimePayloadHash || ''),
          providerProofMode: defaults.providerProofMode === true,
          approvedMedia: sanitizeApprovedMediaIdentity(defaults.approvedMedia, {
            maxByteSize: config.youtube.maxVideoBytes
          }),
          accountId: target.accountId,
          tiktokOpenId: providerId === 'tiktok' ? target.tiktokOpenId : '',
          username: target.username,
          campaignId,
          campaignStartAt: campaignStartAtTimestamp,
          channelOffsetMinutes: scheduleEntry ? scheduleEntry.offsetMinutes : 0,
          channelOrder: scheduleEntry ? scheduleEntry.order : 0,
          seriesId: scheduleEntry ? campaignId : '',
          seriesFrequency: scheduleEntry && scheduleSeries ? scheduleSeries.frequency : '',
          seriesStartDate: scheduleEntry && scheduleSeries ? scheduleSeries.startDate : '',
          seriesEndDate: scheduleEntry && scheduleSeries ? scheduleSeries.endDate : '',
          seriesOccurrenceIndex: scheduleEntry ? scheduleEntry.occurrenceIndex : null,
          seriesOccurrenceCount: scheduleEntry && scheduleSeries ? scheduleSeries.occurrenceCount : 0,
          seriesSourceCount: scheduleEntry && scheduleSeries ? scheduleSeries.sourceCount : 0,
          seriesTimezone: scheduleEntry && scheduleSeries ? scheduleSeries.timezone : '',
          seriesOccurrenceDate: scheduleEntry ? scheduleEntry.occurrenceDate : '',
          originalName: file ? file.originalname : fileName,
          fileName,
          mimeType: autoMusicApplied ? 'video/mp4' : ((file && file.mimetype) || getPublicMediaMimeType(mediaType, publicMediaUrl)),
          mediaType,
          mediaUrl,
          mediaPath: mediaUrl,
          mediaStoragePath: '',
          cloudinaryPublicId,
          cloudinaryResourceType,
          sharedMediaAsset: Boolean(scheduleEntry && cloudinaryPublicId),
          videoPath: mediaType === 'video' ? mediaUrl : '',
          imagePath: mediaType === 'photo' ? mediaUrl : '',
          publicMediaUrl,
          mediaSource: cloudinaryPublicId ? 'cloudinary' : 'public_url',
          storageFallback,
          autoMusicApplied,
          musicTrackId: autoMusicApplied ? String(preparedMedia.trackId || '') : '',
          musicCategory: autoMusicApplied ? String(preparedMedia.trackCategory || '') : '',
          musicMood: autoMusicApplied ? String(preparedMedia.trackMood || '') : '',
          caption: String(defaults.caption || '').trim(),
          hashtags: String(defaults.hashtags || '').trim(),
          publicImageUrl: mediaType === 'photo' ? publicMediaUrl : '',
          instagramMediaUrl: String(defaults.instagramMediaUrl || publicMediaUrl).trim(),
          privacyLevel:
            String(defaults.privacyLevel || config.tiktok.privacyLevel || 'SELF_ONLY').trim() || 'SELF_ONLY',
          // Destination-level TikTok sound mode. Each fanned-out copy of one
          // canonical asset carries its OWN mode (keep_original | mute |
          // tiktok_recommended), independent of its siblings; the provider
          // resolves it at publish. Defaults safely to keep_original.
          soundMode: normalizeSoundMode(target.soundMode),
          providerMetadata: boundedProviderMetadata(providerId, defaults.providerMetadata),
          scheduledAt: jobScheduledAt,
          status: jobScheduledAt ? 'scheduled' : 'pending',
          // Approval gate: admin-intake jobs start unapproved (drafts) and
          // are blocked from every publish path until a human approves them.
          approvedAt: selfApprove ? now : null,
          approvedBy: selfApprove ? selfApprove.approvedBy : null,
          history,
          fileSize,
          duplicateWarning,
          order: nextOrderFor(orderByAccount, target.accountId),
          createdAt: now,
          updatedAt: now,
          postedAt: null,
          readyAt: null,
          lastResult: null,
          lastInstagramResult: null,
          disableComment: false,
          disableDuet: false,
          disableStitch: false,
          contentDisclosure: false,
          yourBrand: false,
          brandedContent: false,
          lockedAt: null,
          lockedBy: null,
          claimAttempts: 0,
          // YouTube approval grants exactly one durable provider attempt.
          // Unapproved drafts start closed; approvePost advances this ceiling
          // from the current durable claim count.
          publishAttemptBudget: providerId === providers.PROVIDER_YOUTUBE
            ? (selfApprove ? 1 : 0)
            : null,
          // Additive provider-operation authority. It stays null until a
          // YouTube worker transaction claims this exact queue row.
          providerOperation: null,
          // Platform batch link. batchOrder is the creation index inside this
          // intake; preparation starts pending so the batch runner can claim
          // it transactionally. Non-batch intakes keep the legacy nulls.
          batchId: String(defaults.batchId || '').trim(),
          batchOrder: defaults.batchId ? created.length : null,
          // Source-video lineage for multi-account fan-out: every destination
          // copy of the same uploaded video (same position in `sources`)
          // shares this index, independent of which target account created
          // it, so a synchronized schedule/grouping can find its siblings.
          sourceIndex: defaults.batchId ? sourceIdx : null,
          preparation: defaults.batchId
            ? { status: 'pending', attempts: 0, leaseAt: null, finishedAt: null, provider: '', fallbackUsed: false, error: '' }
            : null
        };

        if (!defaults.usageReservation) {
          if (requestedDocumentId && defaults.createOnly) batch.create(ref, data);
          else batch.set(ref, data);
        }
        created.push({ ref, data });
      }
    }
    }

    if (defaults.usageReservation) {
      const reservation = defaults.usageReservation;
      const metered = await getUsageService().reserveAndCreateQueueItems({
        workspaceId: workspaceScope.workspaceId,
        metric: USAGE_METRIC_SCHEDULED_POSTS,
        usageCycle: reservation.usageCycle,
        source: String(defaults.creationSource || 'website'),
        limits: {
          scheduledPostsPerCycle: reservation.scheduledPostsPerCycle,
          activeQueueLimit: reservation.activeQueueLimit
        },
        activeQueueBaseline: reservation.activeQueueBaseline,
        items: created.map(({ ref, data }) => ({
          idempotencyKey: String(
            reservation.idempotencyKey || data.idempotencyKey || `queue:${ref.id}`
          ),
          queue: { documentId: ref.id, data: { ...data, usageState: 'reserved' } }
        }))
      });
      if (!metered || !metered.allowed) {
        const error = new Error((metered && metered.reason) || 'Usage reservation was denied.');
        error.status = 409;
        error.code = (metered && metered.code) || 'commercial_truth_unverified';
        error.details = metered || {};
        throw error;
      }

      // The usage transaction has already committed every fresh reservation
      // and queue item. From this point on, a confirmation-read failure must
      // not destroy media that those durable queue records reference.
      committed = Number(metered.reservedCount || 0) > 0;

      // A duplicate idempotency key points at the already-created queue
      // record. Read back the stored truth instead of returning this retry's
      // transient media/copy payload.
      const persisted = await Promise.all(created.map(async ({ ref, data }) => {
        const snapshot = await ref.get();
        return snapshot.exists
          ? postFromDoc(snapshot)
          : postFromDoc({ id: ref.id, data: () => data });
      }));
      return persisted;
    }

    await batch.commit();
    committed = true;
    return created.map(({ ref, data }) => postFromDoc({ id: ref.id, data: () => data }));
  } finally {
    uploadFiles.forEach(cleanupLocalUpload);
    if (defaults.preparedMedia && defaults.preparedMedia.file) {
      cleanupLocalUpload(defaults.preparedMedia.file);
    }
    if (!committed) {
      await Promise.all(cloudinaryAssets.map((asset) =>
        destroyMediaAsset(asset.publicId, asset.resourceType)
      ));
    }
  }
}

// ── YouTube provider-operation custody ─────────────────────────────────────

function providerOperationMatches(data, operationId, attemptId) {
  const operation = data && data.providerOperation;
  return Boolean(
    operation
    && typeof operation === 'object'
    && !Array.isArray(operation)
    && operation.provider === providers.PROVIDER_YOUTUBE
    && operation.providerOperationId === operationId
    && operation.providerAttemptId === attemptId
    && operation.queueId
  );
}

function providerOperationScopeMatches(data, {
  userId,
  accountId,
  workspaceScope
} = {}) {
  const ownerId = userId || DEFAULT_USER_ID;
  if ((data.userId || DEFAULT_USER_ID) !== ownerId) return false;
  if (!recordMatchesWorkspace(data, ownerId, workspaceScope)) return false;
  if (accountId && String(data.accountId || '') !== String(accountId)) return false;
  return String(data.provider || data.platform || '').trim().toLowerCase() === providers.PROVIDER_YOUTUBE;
}

async function mutateYouTubeProviderOperation(input, mutator) {
  const ref = postsCollection().doc(String(input.postId || '').trim());
  return getFirestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { outcome: 'not_found' };
    const data = snap.data() || {};
    if (!providerOperationScopeMatches(data, input)) return { outcome: 'not_found' };
    if (!providerOperationMatches(data, input.providerOperationId, input.providerAttemptId)) {
      return { outcome: 'identity_mismatch' };
    }
    if (String(data.providerOperation.queueId || '') !== ref.id) {
      return { outcome: 'identity_mismatch' };
    }
    if (input.leaseOwnerId || input.fencingToken) {
      if (!reconciliationLeaseAuthorizes(data.providerOperation, input)) {
        return { outcome: 'stale_reconciliation_owner' };
      }
    }
    const result = await mutator({ tx, ref, data, operation: data.providerOperation });
    if (!result || !result.operation) return result || { outcome: 'unchanged' };
    tx.update(ref, {
      providerOperation: result.operation,
      ...(result.queuePatch || {}),
      updatedAt: FieldValue.serverTimestamp()
    });
    return {
      ...result,
      outcome: result.outcome || 'updated',
      operation: result.operation,
      safeOperation: sanitizeProviderOperation(result.operation)
    };
  });
}

async function bindYouTubeProviderOperationMedia(input) {
  const media = {
    mediaSha256: String(input.mediaSha256 || '').trim().toLowerCase(),
    mediaByteSize: Number(input.mediaByteSize),
    mediaMimeType: String(input.mediaMimeType || '').trim().toLowerCase(),
    mediaContainer: String(input.mediaContainer || '').trim().toLowerCase(),
    mediaFileName: String(input.mediaFileName || '').trim(),
    mediaSourceId: String(input.mediaSourceId || '').trim()
  };
  if (
    !/^[a-f0-9]{64}$/.test(media.mediaSha256)
    || !Number.isSafeInteger(media.mediaByteSize)
    || media.mediaByteSize <= 0
    || !media.mediaMimeType.startsWith('video/')
    || media.mediaContainer !== 'mp4'
    || !media.mediaFileName
    || media.mediaFileName.length > 255
    || !media.mediaSourceId
    || media.mediaSourceId.length > 512
  ) throw new Error('YouTube media identity is incomplete.');

  return mutateYouTubeProviderOperation(input, ({ operation }) => {
    if (TERMINAL_OPERATION_STATES.has(operation.operationState)) return { outcome: 'terminal_operation', operation };
    const approvedMedia = sanitizeApprovedMediaIdentity(operation.approvedMedia);
    if (operation.providerProofMode === true && (
      !approvedMedia
      || approvedMedia.sha256 !== media.mediaSha256
      || approvedMedia.byteSize !== media.mediaByteSize
      || approvedMedia.mimeType !== media.mediaMimeType
      || approvedMedia.container !== media.mediaContainer
    )) {
      const failed = appendProviderOperationEvent(
        transitionProviderOperation(operation, 'terminal_failure'),
        'media_drift_rejected',
        { errorCode: 'APPROVED_MEDIA_MISMATCH' }
      );
      return { outcome: 'approved_media_mismatch', operation: { ...failed, lastOperationErrorCode: 'APPROVED_MEDIA_MISMATCH' } };
    }
    const bindingSha256 = canonicalSha256(operationMediaBinding(operation, media));
    if (operation.sessionLocatorEnvelope) {
      const same = operation.mediaSha256 === media.mediaSha256
        && Number(operation.mediaByteSize) === media.mediaByteSize
        && operation.mediaMimeType === media.mediaMimeType
        && operation.mediaContainer === media.mediaContainer
        && operation.mediaFileName === media.mediaFileName
        && operation.mediaSourceId === media.mediaSourceId
        && operation.bindingSha256 === bindingSha256;
      return { outcome: same ? 'already_bound' : 'media_drift', operation };
    }
    const alreadyBound = operation.bindingSha256 !== null && operation.bindingSha256 !== undefined;
    const same = !alreadyBound || (
      operation.mediaSha256 === media.mediaSha256
      && Number(operation.mediaByteSize) === media.mediaByteSize
      && operation.mediaMimeType === media.mediaMimeType
      && operation.mediaContainer === media.mediaContainer
      && operation.mediaFileName === media.mediaFileName
      && operation.mediaSourceId === media.mediaSourceId
      && operation.bindingSha256 === bindingSha256
    );
    if (!same) {
      const drifted = appendProviderOperationEvent(
        { ...transitionProviderOperation(operation, 'terminal_failure'), lastOperationErrorCode: 'MEDIA_IDENTITY_DRIFT' },
        'media_drift_rejected',
        { errorCode: 'MEDIA_IDENTITY_DRIFT' }
      );
      return { outcome: 'media_drift', operation: drifted };
    }
    if (alreadyBound) return { outcome: 'already_bound', operation };
    const next = appendProviderOperationEvent({
      ...transitionProviderOperation(operation, 'media_preflighted'),
      ...media,
      bindingSha256,
      lastOperationErrorCode: null
    }, 'media_preflight_bound');
    return { outcome: 'bound', operation: next };
  });
}

async function persistYouTubeSessionLocator(input) {
  if (!tokenVault.isCredentialEnvelope(input.sessionLocatorEnvelope)) {
    throw new Error('YouTube session locator must use the configured authenticated-encryption vault.');
  }
  return mutateYouTubeProviderOperation(input, ({ operation }) => {
    if (TERMINAL_OPERATION_STATES.has(operation.operationState)) return { outcome: 'terminal_operation', operation };
    if (operation.sessionLocatorEnvelope) {
      return { outcome: 'session_already_exists', operation };
    }
    if (!operation.bindingSha256 || !operation.mediaSha256) {
      return { outcome: 'media_not_bound', operation };
    }
    const createdAt = new Date().toISOString();
    const next = appendProviderOperationEvent({
      ...transitionProviderOperation(operation, 'session_persisted'),
      sessionLocatorEnvelope: input.sessionLocatorEnvelope,
      sessionCreatedAt: createdAt,
      lastOperationErrorCode: null
    }, 'session_initiated', {}, createdAt);
    return { outcome: 'session_persisted', operation: next };
  });
}

async function recordYouTubeUploadAttempt(input) {
  return mutateYouTubeProviderOperation(input, ({ operation }) => {
    if (TERMINAL_OPERATION_STATES.has(operation.operationState)) return { outcome: 'terminal_operation', operation };
    if (!operation.sessionLocatorEnvelope) return { outcome: 'session_missing', operation };
    const startedAt = new Date().toISOString();
    const next = appendProviderOperationEvent({
      ...transitionProviderOperation(operation, 'uploading'),
      uploadStartedAt: operation.uploadStartedAt || startedAt
    }, 'upload_put_attempted', {
      acceptedByteOffset: Number(input.acceptedByteOffset || 0)
    }, startedAt);
    return { outcome: 'recorded', operation: next };
  });
}

async function recordYouTubeAcceptedByteOffset(input) {
  return mutateYouTubeProviderOperation(input, ({ operation }) => {
    if (TERMINAL_OPERATION_STATES.has(operation.operationState)) return { outcome: 'terminal_operation', operation };
    const acceptedByteOffset = Number(input.acceptedByteOffset);
    const mediaByteSize = Number(operation.mediaByteSize);
    const previousOffset = Number(operation.acceptedByteOffset || 0);
    if (!Number.isSafeInteger(acceptedByteOffset) || acceptedByteOffset < 0 || acceptedByteOffset > mediaByteSize) {
      return { outcome: 'invalid_offset', operation };
    }
    if (acceptedByteOffset < previousOffset) return { outcome: 'decreasing_offset', operation };
    const nextState = acceptedByteOffset === mediaByteSize ? 'outcome_unknown' : 'resumable';
    const next = appendProviderOperationEvent({
      ...transitionProviderOperation(operation, nextState),
      acceptedByteOffset,
      lastOperationErrorCode: acceptedByteOffset === mediaByteSize ? 'FULL_SIZE_WITHOUT_COMPLETION' : operation.lastOperationErrorCode,
      lastReconciledAt: new Date().toISOString()
    }, 'accepted_byte_offset', { acceptedByteOffset });
    return { outcome: acceptedByteOffset === mediaByteSize ? 'full_size_ambiguous' : 'recorded', operation: next };
  });
}

async function recordYouTubeProviderResponse(input) {
  const responseSha256 = String(input.providerResponseSha256 || '').trim().toLowerCase();
  const externalVideoId = String(input.externalVideoId || '').trim();
  if (!/^[a-f0-9]{64}$/.test(responseSha256)) throw new Error('Provider response hash is required.');
  return mutateYouTubeProviderOperation(input, ({ operation }) => {
    if (TERMINAL_OPERATION_STATES.has(operation.operationState)) {
      return { outcome: 'terminal_operation', operation };
    }
    if (
      (operation.externalVideoId && operation.externalVideoId !== externalVideoId)
      || (operation.providerResponseSha256 && operation.providerResponseSha256 !== responseSha256)
    ) {
      return { outcome: 'conflicting_provider_response', operation };
    }
    if (
      operation.externalVideoId === externalVideoId
      && operation.providerResponseSha256 === responseSha256
    ) {
      return { outcome: 'already_recorded', operation };
    }
    const completedAt = new Date().toISOString();
    let next = appendProviderOperationEvent({
      ...operation,
      providerResponseSha256: responseSha256,
      uploadCompletedAt: externalVideoId ? completedAt : operation.uploadCompletedAt,
      acceptedByteOffset: externalVideoId ? Number(operation.mediaByteSize || 0) : operation.acceptedByteOffset,
      externalVideoId: externalVideoId || operation.externalVideoId || null
    }, 'provider_response_recorded', {
      responseSha256,
      externalVideoId
    }, completedAt);
    if (externalVideoId && !next.events.some((event) => (
      event.type === 'artifact_confirmed' && event.externalVideoId === externalVideoId
    ))) {
      next = appendProviderOperationEvent(next, 'artifact_confirmed', { externalVideoId }, completedAt);
    }
    return { outcome: 'recorded', operation: next };
  });
}

async function claimYouTubeReconciliationAttempt(input) {
  return mutateYouTubeProviderOperation(input, ({ operation }) =>
    claimReconciliationLease(operation, input));
}

async function releaseYouTubeReconciliationLease(input) {
  return mutateYouTubeProviderOperation(input, ({ operation }) => {
    const lease = operation.reconciliationLease;
    if (!lease) return { outcome: 'already_released', operation };
    const at = new Date().toISOString();
    const next = appendProviderOperationEvent({ ...operation, reconciliationLease: null }, 'reconciliation_lease_released', {}, at);
    return { outcome: 'released', operation: next };
  });
}

async function recordYouTubeProviderStatusReceipt(input) {
  const receipt = sanitizeProviderStatusReceipt(input.providerStatusReceipt);
  if (!receipt) {
    throw new Error('Safe YouTube provider status receipt is invalid.');
  }
  const receiptSha256 = canonicalSha256(receipt);
  return mutateYouTubeProviderOperation(input, ({ operation }) => {
    if (TERMINAL_OPERATION_STATES.has(operation.operationState)) {
      const safe = sanitizeProviderOperation(operation);
      if (
        operation.operationState === 'completed_private'
        && safe?.providerStatusReceiptSha256 === receiptSha256
        && canonicalSha256(safe.providerStatusReceipt) === receiptSha256
      ) return { outcome: 'completed_private', operation };
      return { outcome: 'conflicting_terminal_completion', operation };
    }
    if (
      receipt.queueId !== operation.queueId
      || receipt.providerOperationId !== operation.providerOperationId
      || receipt.providerAttemptId !== operation.providerAttemptId
      || receipt.configuredAccountId !== operation.accountId
      || receipt.connectedAccountId !== operation.connectedAccountId
      || receipt.mediaSha256 !== operation.mediaSha256
      || receipt.userId !== operation.userId
      || receipt.workspaceId !== operation.workspaceId
      || receipt.runtimeMissionId !== operation.runtimeMissionId
      || receipt.graphId !== operation.graphId
      || (receipt.externalVideoId || null) !== (operation.externalVideoId || null)
      || receipt.authenticatedChannelId !== receipt.verifiedChannelId
      || canonicalSha256(receipt.approvedMedia) !== canonicalSha256(operation.approvedMedia)
    ) return { outcome: 'identity_mismatch', operation };
    let operationState = 'outcome_unknown';
    if (!receipt.artifactExists) operationState = 'provider_missing';
    else if (
      receipt.privacyStatus === 'private'
      && receipt.exactTitleMatch
      && receipt.verifiedChannelId === receipt.configuredAccountId
      && receipt.authenticatedChannelId === receipt.configuredAccountId
      && !['rejected', 'deleted', 'failed'].includes(receipt.uploadStatus.toLowerCase())
    ) operationState = 'completed_private';
    else if (receipt.privacyStatus === 'public' || receipt.privacyStatus === 'unlisted') {
      operationState = 'contradictory_public';
    }
    const at = receipt.verificationTimestamp;
    let next = appendProviderOperationEvent({
      ...transitionProviderOperation(operation, operationState),
      providerStatusReceipt: receipt,
      providerStatusReceiptSha256: receiptSha256,
      externalVideoId: receipt.externalVideoId || operation.externalVideoId || null,
      lastReconciledAt: at,
      lastOperationErrorCode: operationState === 'completed_private'
        ? null
        : operationState.toUpperCase()
    }, 'provider_status_read', {
      externalVideoId: receipt.externalVideoId,
      receiptSha256
    }, at);
    next = appendProviderOperationEvent(next, 'provider_receipt_recorded', {
      externalVideoId: receipt.externalVideoId,
      receiptSha256
    }, at);
    if (receipt.artifactExists && receipt.externalVideoId && !next.events.some((event) => (
      event.type === 'artifact_confirmed' && event.externalVideoId === receipt.externalVideoId
    ))) {
      next = appendProviderOperationEvent(next, 'artifact_confirmed', {
        externalVideoId: receipt.externalVideoId
      }, at);
    }
    return { outcome: operationState, operation: next };
  });
}

async function recordYouTubeProviderOperationFailure(input) {
  const errorCode = String(input.errorCode || 'PROVIDER_OUTCOME_UNKNOWN').trim().slice(0, 120);
  const operationState = ['terminal_failure', 'outcome_unknown', 'provider_missing', 'resumable']
    .includes(input.operationState)
    ? input.operationState
    : 'outcome_unknown';
  return mutateYouTubeProviderOperation(input, ({ operation }) => {
    if (TERMINAL_OPERATION_STATES.has(operation.operationState)) return { outcome: 'terminal_operation', operation };
    const eventType = errorCode === 'SESSION_PERSISTENCE_FAILED'
      ? 'session_persistence_failed'
      : (operationState === 'terminal_failure' ? 'terminal_failure' : 'outcome_unknown');
    const next = appendProviderOperationEvent({
      ...transitionProviderOperation(operation, operationState),
      lastOperationErrorCode: errorCode,
      lastReconciledAt: input.reconciled === true ? new Date().toISOString() : operation.lastReconciledAt
    }, eventType, { errorCode });
    return { outcome: operationState, operation: next };
  });
}

async function getYouTubeProviderOperationInternal(userId, postId, accountId, workspaceScope) {
  const ownerId = userId || DEFAULT_USER_ID;
  const ref = postsCollection().doc(String(postId || '').trim());
  const snap = await ref.get();
  if (!snap.exists) return null;
  const data = snap.data() || {};
  if (!providerOperationScopeMatches(data, { userId: ownerId, accountId, workspaceScope })) return null;
  const safe = sanitizeProviderOperation(data.providerOperation);
  if (!safe || safe.queueId !== ref.id) return null;
  return { post: postFromDoc(snap), operation: data.providerOperation };
}

async function applyYouTubeProviderReconciliationResult(input) {
  return mutateYouTubeProviderOperation(input, async ({ tx, ref, data, operation }) => {
    const safe = sanitizeProviderOperation(operation);
    if (!safe || !safe.providerStatusReceipt) return { outcome: 'receipt_missing', operation };
    const receipt = safe.providerStatusReceipt;
    const now = Timestamp.now();
    if (safe.operationState === 'completed_private') {
      const verification = {
        provider: 'youtube',
        externalVideoId: receipt.externalVideoId,
        channelId: receipt.verifiedChannelId,
        channelTitle: receipt.safeChannelTitle,
        channelHandle: receipt.safeChannelHandle,
        title: receipt.expectedTitle,
        privacyStatus: 'private',
        uploadStatus: receipt.uploadStatus,
        processingStatus: receipt.processingStatus,
        verifiedAt: receipt.verificationTimestamp,
        uploadMethod: 'resumable'
      };
      let usageState = data.usageState || '';
      let usageReconciliationRequired = Boolean(data.usageReconciliationRequired);
      if (data.usageLedgerId && data.workspaceId && data.usageCycleId) {
        try {
          const transition = await getUsageService().transaction.consumeReservation(tx, {
            workspaceId: data.workspaceId,
            usageCycleId: data.usageCycleId,
            metric: data.usageMetric || USAGE_METRIC_SCHEDULED_POSTS,
            ledgerId: data.usageLedgerId,
            relatedResourceId: ref.id
          });
          usageState = transition.state;
          usageReconciliationRequired = false;
        } catch {
          usageReconciliationRequired = true;
        }
      }
      return {
        outcome: 'completed_private',
        operation,
        queuePatch: {
          status: 'posted',
          postedAt: data.postedAt || now,
          failedAt: null,
          errorMessage: null,
          lockedAt: null,
          lockedBy: null,
          publishId: receipt.externalVideoId,
          providerStatus: 'uploaded_private',
          providerVerification: verification,
          usageState,
          usageReconciliationRequired,
          lastResult: {
            ok: true,
            mode: 'api_reconciliation',
            completedAt: receipt.verificationTimestamp,
            providerStatus: 'uploaded_private',
            response: {
              video_id: receipt.externalVideoId,
              privacy_status: receipt.privacyStatus,
              upload_status: receipt.uploadStatus,
              channel_id: receipt.verifiedChannelId,
              upload_method: 'resumable'
            }
          },
          history: appendHistoryEntry(data.history, 'provider_reconciled', 'The persisted YouTube session reconciled to one verified private video.')
        }
      };
    }
    const contradiction = safe.operationState === 'contradictory_public';
    return {
      outcome: safe.operationState,
      operation,
      queuePatch: {
        status: 'outcome_unknown',
        failedAt: null,
        errorMessage: contradiction
          ? 'YouTube reported a public or unlisted artifact; critical reconciliation is required.'
          : 'The persisted YouTube provider operation remains unresolved.',
        lockedAt: null,
        lockedBy: null,
        providerStatus: contradiction ? 'provider_visibility_contradiction' : safe.operationState,
        lastResult: {
          ok: false,
          mode: 'api_reconciliation',
          code: contradiction ? 'PROVIDER_VISIBILITY_CONTRADICTION' : 'PROVIDER_RECONCILIATION_REQUIRED',
          outcomeUnknown: true,
          providerMutationStarted: safe.mutationSummary.providerSessionInitiationCount > 0,
          reason: contradiction
            ? 'YouTube reported a public or unlisted artifact.'
            : 'The persisted YouTube provider operation remains unresolved.',
          completedAt: new Date().toISOString()
        },
        history: appendHistoryEntry(
          data.history,
          contradiction ? 'provider_visibility_contradiction' : 'provider_reconciliation_required',
          contradiction
            ? 'Provider read-back contradicted the private-only policy.'
            : 'Same-session reconciliation did not establish one private artifact.'
        )
      }
    };
  });
}

async function updatePost(userId, id, patch, accountId, historyEvent, workspaceScope) {
  const ownerId = userId || DEFAULT_USER_ID;
  const ref = postsCollection().doc(id);
  const snap = await ref.get();
  if (!snap.exists) return null;
  if ((snap.data().userId || DEFAULT_USER_ID) !== ownerId) return null;
  if (!recordMatchesWorkspace(snap.data(), ownerId, workspaceScope)) return null;
  if (accountId && postFromDoc(snap).accountId !== accountId) return null;

  const firestorePatch = mapPatchToFirestore(patch);
  if ('scheduledAt' in firestorePatch && !['processing', 'posted'].includes(snap.data().status)) {
    firestorePatch.status = firestorePatch.scheduledAt ? 'scheduled' : 'pending';
  }
  if (historyEvent && historyEvent.event) {
    firestorePatch.history = appendHistoryEntry(snap.data().history, historyEvent.event, historyEvent.detail);
  }
  await ref.update({ ...firestorePatch, updatedAt: FieldValue.serverTimestamp() });
  const updated = await ref.get();
  return postFromDoc(updated);
}

async function retryFailedPost(userId, id, accountId, workspaceScope) {
  const ownerId = userId || DEFAULT_USER_ID;
  const ref = postsCollection().doc(id);

  // Retry and worker claim are competing transitions on the same durable row.
  // Recheck status and authorization inside one transaction so a stale retry
  // can never overwrite a claim, its lock, or its monotone attempt count.
  return getFirestore().runTransaction(async (tx) => {
    const current = await tx.get(ref);
    if (!current.exists) return { outcome: 'not_found' };

    const data = current.data() || {};
    if ((data.userId || DEFAULT_USER_ID) !== ownerId) return { outcome: 'not_found' };
    if (!recordMatchesWorkspace(data, ownerId, workspaceScope)) return { outcome: 'not_found' };

    const post = postFromDoc(current);
    if (accountId && post.accountId !== accountId) return { outcome: 'not_found' };

    const status = normalizeQueueStatus(data.status);
    if (status !== 'failed') {
      return { outcome: 'queue_transition_blocked', post };
    }

    const claimAttempts = Number(data.claimAttempts || 0);
    const effectiveAttemptBudget = resolvePublishAttemptBudget(data);
    if (claimAttempts >= effectiveAttemptBudget) {
      return {
        outcome: 'attempt_budget_exhausted',
        post,
        claimAttempts,
        effectiveAttemptBudget
      };
    }

    // Keep legacy scheduledTimeUTC-only rows in `pending`: that is the state
    // paired with the scheduler's legacy due-query. Only the canonical
    // scheduledAt field is eligible for the canonical `scheduled` query.
    const nextStatus = data.scheduledAt ? 'scheduled' : 'pending';
    const history = appendHistoryEntry(
      data.history,
      'retry_requested',
      `Returned to the ${nextStatus === 'scheduled' ? 'schedule' : 'pending queue'} for another authorized claim; ${claimAttempts} of ${effectiveAttemptBudget} authorized claims are already consumed.`
    );
    tx.update(ref, {
      status: nextStatus,
      postedAt: null,
      readyAt: null,
      failedAt: null,
      errorMessage: null,
      lastResult: null,
      providerStatus: null,
      lockedAt: null,
      lockedBy: null,
      history,
      updatedAt: FieldValue.serverTimestamp()
    });

    return {
      outcome: 'retried',
      claimAttempts,
      effectiveAttemptBudget,
      post: {
        ...post,
        status: nextStatus,
        postedAt: null,
        readyAt: null,
        failedAt: null,
        lastResult: null,
        lastError: '',
        providerStatus: null,
        lockedAt: null,
        lockedBy: null,
        history,
        logs: history
      }
    };
  });
}

// ── Approval gate ────────────────────────────────────────────────────────
// The one write path that marks a job publishable. Workers (scheduler.js
// claimPost) refuse to claim anything without a valid approvedAt, so a job
// that never passes through here can never reach TikTok.

const APPROVABLE_STATUSES = ['pending', 'scheduled', 'failed', 'ready'];

async function approvePost(userId, id, { approvedBy } = {}, accountId, workspaceScope) {
  const ownerId = userId || DEFAULT_USER_ID;
  const ref = postsCollection().doc(id);
  const snap = await ref.get();
  if (!snap.exists) return null;
  if ((snap.data().userId || DEFAULT_USER_ID) !== ownerId) return null;
  if (!recordMatchesWorkspace(snap.data(), ownerId, workspaceScope)) return null;
  const post = postFromDoc(snap);
  if (accountId && post.accountId !== accountId) return null;
  // Only reviewable states can change approval; a job that is mid-publish
  // or already posted keeps whatever approval record produced it.
  if (!APPROVABLE_STATUSES.includes(post.status)) return null;

  const reviewer = String(approvedBy || '').trim() || 'admin';
  const approvalPatch = {
    approvedAt: Timestamp.now(),
    approvedBy: reviewer,
    history: appendHistoryEntry(snap.data().history, 'approved', `Approved by ${reviewer}.`),
    updatedAt: FieldValue.serverTimestamp()
  };
  if (post.provider === providers.PROVIDER_YOUTUBE) {
    // Each explicit human approval authorizes one and only one additional
    // claim. The ceiling is absolute, so restart/replay cannot reset it.
    approvalPatch.publishAttemptBudget = Number(snap.data().claimAttempts || 0) + 1;
  }
  await ref.update(approvalPatch);
  const updated = await ref.get();
  return postFromDoc(updated);
}

async function revokePostApproval(userId, id, accountId, workspaceScope) {
  const ownerId = userId || DEFAULT_USER_ID;
  const ref = postsCollection().doc(id);
  const snap = await ref.get();
  if (!snap.exists) return null;
  if ((snap.data().userId || DEFAULT_USER_ID) !== ownerId) return null;
  if (!recordMatchesWorkspace(snap.data(), ownerId, workspaceScope)) return null;
  const post = postFromDoc(snap);
  if (accountId && post.accountId !== accountId) return null;
  if (!APPROVABLE_STATUSES.includes(post.status)) return null;

  await ref.update({
    approvedAt: null,
    approvedBy: null,
    history: appendHistoryEntry(snap.data().history, 'approval_revoked', 'Approval removed; publishing is blocked until re-approved.'),
    updatedAt: FieldValue.serverTimestamp()
  });
  const updated = await ref.get();
  return postFromDoc(updated);
}

async function markPostManuallyWithUsage(userId, id, accountId, workspaceScope, completedAt) {
  const ownerId = userId || DEFAULT_USER_ID;
  const ref = postsCollection().doc(id);
  let applied = false;
  await getFirestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const data = snap.data() || {};
    if ((data.userId || DEFAULT_USER_ID) !== ownerId) return;
    if (!recordMatchesWorkspace(data, ownerId, workspaceScope)) return;
    if (accountId && postFromDoc(snap).accountId !== accountId) return;

    let usageState = data.usageState || '';
    let usageReconciliationRequired = false;
    if (data.usageLedgerId && data.workspaceId && data.usageCycleId) {
      try {
        const transition = await getUsageService().transaction.consumeReservation(tx, {
          workspaceId: data.workspaceId,
          usageCycleId: data.usageCycleId,
          metric: data.usageMetric || USAGE_METRIC_SCHEDULED_POSTS,
          ledgerId: data.usageLedgerId,
          relatedResourceId: id
        });
        usageState = transition.state;
      } catch (error) {
        // Keep quota reserved and surface reconciliation instead of claiming
        // that metering completed when the operator records a real post.
        usageReconciliationRequired = true;
      }
    }

    tx.update(ref, {
      status: 'posted',
      postedAt: Timestamp.fromDate(new Date(completedAt)),
      readyAt: null,
      lastResult: {
        ok: true,
        mode: 'manual',
        reason: 'Marked posted manually',
        completedAt
      },
      usageState,
      usageReconciliationRequired,
      history: appendHistoryEntry(
        data.history,
        'marked_posted',
        'Marked posted manually by the operator; no API publish occurred.'
      ),
      updatedAt: FieldValue.serverTimestamp()
    });
    applied = true;
  });
  if (!applied) return null;
  return getPost(ownerId, id, accountId, workspaceScope);
}

async function deletePost(userId, id, accountId, workspaceScope) {
  const ownerId = userId || DEFAULT_USER_ID;
  const ref = postsCollection().doc(id);
  let deletedData = null;

  await getFirestore().runTransaction(async (tx) => {
    const current = await tx.get(ref);
    if (!current.exists) return;
    const currentData = current.data() || {};
    if ((currentData.userId || DEFAULT_USER_ID) !== ownerId) return;
    if (!recordMatchesWorkspace(currentData, ownerId, workspaceScope)) return;
    if (accountId && postFromDoc(current).accountId !== accountId) return;

    const status = normalizeQueueStatus(currentData.status);
    if (
      ['processing', 'outcome_unknown'].includes(status)
      || currentData.outcomeUnknown
      || currentData.usageReconciliationRequired
    ) {
      const error = new Error(
        status === 'outcome_unknown' || currentData.outcomeUnknown
          ? 'This provider outcome is unknown. Reconcile it before deleting the queue item.'
          : 'This queue item is processing or requires reconciliation and cannot be deleted.'
      );
      error.status = 409;
      error.code = 'queue_transition_blocked';
      throw error;
    }

    const releasable = ['pending', 'scheduled', 'ready', 'failed'].includes(status);
    if (!releasable && status !== 'posted') {
      const error = new Error('This queue state cannot be deleted safely.');
      error.status = 409;
      error.code = 'queue_transition_blocked';
      throw error;
    }

    const usageFields = [
      currentData.workspaceId,
      currentData.usageCycleId,
      currentData.usageLedgerId
    ];
    const hasAnyUsageBinding = usageFields.some((value) => String(value || '').trim());
    const hasCompleteUsageBinding = usageFields.every((value) => String(value || '').trim());
    if (hasAnyUsageBinding && !hasCompleteUsageBinding) {
      const error = new Error('Usage truth is incomplete; deletion was blocked for reconciliation.');
      error.status = 409;
      error.code = 'queue_transition_blocked';
      throw error;
    }

    if (releasable && hasCompleteUsageBinding) {
      if (currentData.publishId) {
        const error = new Error('Provider evidence exists; deletion was blocked for reconciliation.');
        error.status = 409;
        error.code = 'queue_transition_blocked';
        throw error;
      }
      await getUsageService().transaction.releaseReservation(tx, {
        workspaceId: currentData.workspaceId,
        usageCycleId: currentData.usageCycleId,
        metric: currentData.usageMetric || USAGE_METRIC_SCHEDULED_POSTS,
        ledgerId: currentData.usageLedgerId,
        relatedResourceId: current.id,
        reason: 'queue_item_deleted_before_provider_side_effect'
      });
    }

    if (
      status === 'posted'
      && hasCompleteUsageBinding
      && currentData.usageState !== 'consumed'
    ) {
      const error = new Error('Posted usage is not reconciled; deletion was blocked.');
      error.status = 409;
      error.code = 'queue_transition_blocked';
      throw error;
    }

    tx.delete(ref);
    deletedData = currentData;
  });

  if (!deletedData) return false;
  const fileName = deletedData.fileName;
  const cloudinaryPublicId = String(deletedData.cloudinaryPublicId || '').trim();
  let mediaStillReferenced = false;

  // Daily-series jobs intentionally share one uploaded asset per account and
  // source. Never destroy that asset while another queue record still points
  // at it. Legacy one-job/one-asset records continue to destroy immediately.
  if (cloudinaryPublicId) {
    const remaining = await postsCollection()
      .where('cloudinaryPublicId', '==', cloudinaryPublicId)
      .limit(1)
      .get();
    mediaStillReferenced = !remaining.empty;
  }

  if (!mediaStillReferenced) {
    await destroyMediaAsset(cloudinaryPublicId, deletedData.cloudinaryResourceType);
  }

  if (fileName && !mediaStillReferenced) {
    const uploadPath = path.resolve(config.uploadsDir, fileName);
    if (uploadPath.startsWith(path.resolve(config.uploadsDir))) {
      try {
        fs.unlinkSync(uploadPath);
      } catch (error) {
        // The queue item is still removed even if the local media file is
        // already gone — expected after a Render restart wiped the disk.
      }
    }
  }

  return true;
}

async function movePost(userId, id, direction, accountId, workspaceScope) {
  const ownerId = userId || DEFAULT_USER_ID;
  const posts = await getPosts(ownerId, accountId, workspaceScope);
  const index = posts.findIndex((post) => post.id === id);
  const targetIndex = direction === 'up' ? index - 1 : index + 1;

  if (index < 0 || targetIndex < 0 || targetIndex >= posts.length) {
    return false;
  }

  const db = getFirestore();
  const batch = db.batch();
  const now = FieldValue.serverTimestamp();
  batch.update(postsCollection().doc(posts[index].id), { order: posts[targetIndex].order, updatedAt: now });
  batch.update(postsCollection().doc(posts[targetIndex].id), { order: posts[index].order, updatedAt: now });
  await batch.commit();
  return true;
}

async function autoSchedulePosts(userId, postIds, accountId, workspaceScope) {
  const ownerId = userId || DEFAULT_USER_ID;
  const idSet = new Set(postIds);
  const posts = await getPosts(ownerId, accountId, workspaceScope);
  const settings = await getSettings();
  let nextDate = getNextAvailableDate(posts, settings.dailyPostTime, idSet);

  const db = getFirestore();
  const batch = db.batch();
  let count = 0;

  for (const post of posts) {
    if (!idSet.has(post.id) || post.status !== 'pending') continue;
    batch.update(postsCollection().doc(post.id), {
      scheduledAt: Timestamp.fromDate(nextDate),
      status: 'scheduled',
      updatedAt: FieldValue.serverTimestamp()
    });
    nextDate = addDaysAtTime(nextDate, 1, settings.dailyPostTime);
    count += 1;
  }

  if (count > 0) await batch.commit();
  return count;
}

/**
 * Apply a Max Scheduler plan (see maxScheduler.js) to freshly created posts.
 * Every post matching a plan channel's accountId gets that channel's exact
 * scheduledAt, plus the campaign-level bookkeeping fields
 * (campaignStartAt/channelOffsetMinutes/channelOrder) used for display only.
 * Posts whose accountId has no matching plan channel are left untouched
 * (defensive — the caller already validates targets against the plan).
 */
async function applyExplicitSchedule(userId, posts, plan, workspaceScope) {
  const planByAccount = new Map((plan && plan.channels ? plan.channels : []).map((channel) => [channel.accountId, channel]));
  const db = getFirestore();
  const batch = db.batch();
  let count = 0;

  for (const post of Array.isArray(posts) ? posts : []) {
    const planChannel = planByAccount.get(post.accountId);
    if (!planChannel) continue;
    batch.update(postsCollection().doc(post.id), {
      scheduledAt: Timestamp.fromDate(new Date(planChannel.scheduledAt)),
      campaignStartAt: Timestamp.fromDate(new Date(plan.baseAt)),
      channelOffsetMinutes: planChannel.offsetMinutes,
      channelOrder: planChannel.order,
      status: 'scheduled',
      updatedAt: FieldValue.serverTimestamp()
    });
    count += 1;
  }

  if (count > 0) await batch.commit();
  return count;
}

/**
 * Apply a per-item staggered batch plan (maxScheduler.computeBatchStaggerPlan)
 * to freshly created posts: created[i] gets plan.slots[i].scheduledAt. The
 * posts stay unapproved drafts — claimPost's approval gate is untouched, so
 * assigning times here can never publish anything by itself.
 */
async function applyStaggeredSchedule(userId, posts, plan, workspaceScope) {
  const slots = plan && Array.isArray(plan.slots) ? plan.slots : [];
  const items = Array.isArray(posts) ? posts : [];
  if (items.length !== slots.length) {
    const error = new Error(`The staggered plan has ${slots.length} slots for ${items.length} queue items.`);
    error.status = 500;
    throw error;
  }

  const db = getFirestore();
  const batch = db.batch();
  let count = 0;

  for (let index = 0; index < items.length; index += 1) {
    const slot = slots[index];
    batch.update(postsCollection().doc(items[index].id), {
      scheduledAt: Timestamp.fromDate(new Date(slot.scheduledAt)),
      campaignStartAt: Timestamp.fromDate(new Date(plan.baseAt)),
      channelOffsetMinutes: slot.offsetMinutes,
      channelOrder: 0,
      status: 'scheduled',
      updatedAt: FieldValue.serverTimestamp()
    });
    count += 1;
  }

  if (count > 0) await batch.commit();
  return count;
}

/**
 * Apply a channel-agnostic per-source-video plan (maxScheduler.computeBatch
 * SchedulePlan) to freshly created posts. Unlike applyStaggeredSchedule
 * (strict 1:1 by array position, one channel), this maps MANY posts sharing
 * the same sourceIndex onto the SAME slot — every destination copy of one
 * source video keeps the same synchronized release time by default, with no
 * per-account offset. Posts stay unapproved drafts; nothing publishes here.
 */
async function applyBatchSourceSchedule(userId, posts, plan, workspaceScope) {
  const slotsByIndex = new Map(
    (plan && Array.isArray(plan.slots) ? plan.slots : []).map((slot) => [slot.index, slot])
  );
  const items = Array.isArray(posts) ? posts : [];
  const db = getFirestore();
  const batch = db.batch();
  let count = 0;

  for (const post of items) {
    const slot = slotsByIndex.get(post.sourceIndex);
    if (!slot) {
      const error = new Error(`No schedule slot found for source video index ${post.sourceIndex}.`);
      error.status = 500;
      throw error;
    }
    batch.update(postsCollection().doc(post.id), {
      scheduledAt: Timestamp.fromDate(new Date(slot.scheduledAt)),
      campaignStartAt: Timestamp.fromDate(new Date(plan.baseAt || slot.scheduledAt)),
      channelOffsetMinutes: 0,
      channelOrder: 0,
      status: 'scheduled',
      updatedAt: FieldValue.serverTimestamp()
    });
    count += 1;
  }

  if (count > 0) await batch.commit();
  return count;
}

// ── Platform batch records ─────────────────────────────────────────────────
// One postBatches document per batch intake. Items remain ordinary posts
// (the durable truth); the record carries batch-level lifecycle and a
// best-effort count summary for listing.

function batchRecordFromDoc(doc) {
  const data = doc.data() || {};
  return {
    batchId: doc.id,
    userId: data.userId || DEFAULT_USER_ID,
    workspaceId: String(data.workspaceId || '').trim(),
    provider: String(data.provider || '').trim(),
    accountId: String(data.accountId || '').trim(),
    accountLabel: String(data.accountLabel || '').trim(),
    status: String(data.status || 'preparing').trim(),
    itemCount: Number(data.itemCount || 0),
    preparedCount: Number(data.preparedCount || 0),
    failedCount: Number(data.failedCount || 0),
    acceptedCount: Number(data.acceptedCount || 0),
    // Deleted items are removed from itemCount's live-truth recount (see
    // refreshBatchRecord/getBatchPosts); deletedCount is the only durable
    // tally of how many were ever removed, atomically incremented so
    // concurrent per-item and whole-batch deletes never lose an update.
    deletedCount: Number(data.deletedCount || 0),
    // Fan-out lineage (V1.2): videoCount is N (source videos uploaded),
    // destinationCount is M (selected accounts); itemCount is the live
    // N x M canonical post total. Both default to itemCount/1 for batches
    // created before this field existed (single-destination V1/V1.1 shape).
    videoCount: Number.isInteger(Number(data.videoCount)) && Number(data.videoCount) > 0
      ? Number(data.videoCount)
      : Number(data.itemCount || 0),
    destinationCount: Number.isInteger(Number(data.destinationCount)) && Number(data.destinationCount) > 0
      ? Number(data.destinationCount)
      : 1,
    scheduleMode: String(data.scheduleMode || 'interval').trim(),
    staggerMinutes: Number(data.staggerMinutes || 0),
    baseAt: data.baseAt && typeof data.baseAt.toDate === 'function' ? data.baseAt.toDate().toISOString() : null,
    timezoneName: String(data.timezoneName || '').trim(),
    intakeKey: String(data.intakeKey || '').trim(),
    createdAt: data.createdAt && typeof data.createdAt.toDate === 'function' ? data.createdAt.toDate().toISOString() : null,
    updatedAt: data.updatedAt && typeof data.updatedAt.toDate === 'function' ? data.updatedAt.toDate().toISOString() : null
  };
}

function batchRecordMatchesScope(record, ownerId, workspaceScope) {
  if (record.userId !== ownerId) return false;
  const scope = normalizeWorkspaceScope(workspaceScope);
  if (!scope.workspaceId) return true;
  if (record.workspaceId === scope.workspaceId) return true;
  return scope.allowLegacyOwnerRecords && !record.workspaceId;
}

async function createBatchRecord(record) {
  const batchId = String(record.batchId || '').trim();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(batchId)) {
    const error = new Error('Invalid batch identifier');
    error.status = 400;
    throw error;
  }
  const now = Timestamp.now();
  // create() (not set) so a concurrent duplicate intake fails loudly instead
  // of silently overwriting the first record.
  await postBatchesCollection().doc(batchId).create({
    userId: record.userId || DEFAULT_USER_ID,
    workspaceId: String(record.workspaceId || '').trim(),
    provider: String(record.provider || '').trim(),
    accountId: String(record.accountId || '').trim(),
    accountLabel: String(record.accountLabel || '').trim(),
    status: String(record.status || 'preparing').trim(),
    itemCount: Number(record.itemCount || 0),
    preparedCount: 0,
    failedCount: 0,
    acceptedCount: 0,
    deletedCount: 0,
    videoCount: Number(record.videoCount || record.itemCount || 0),
    destinationCount: Math.max(1, Number(record.destinationCount || 1)),
    scheduleMode: String(record.scheduleMode || 'interval').trim(),
    staggerMinutes: Number(record.staggerMinutes || 0),
    baseAt: toTimestampOrNull(record.baseAt),
    timezoneName: String(record.timezoneName || '').trim(),
    intakeKey: String(record.intakeKey || '').trim(),
    createdAt: now,
    updatedAt: now
  });
  const snapshot = await postBatchesCollection().doc(batchId).get();
  return batchRecordFromDoc(snapshot);
}

async function getBatchRecord(userId, batchId, workspaceScope) {
  const ownerId = userId || DEFAULT_USER_ID;
  const id = String(batchId || '').trim();
  if (!id) return null;
  const snapshot = await postBatchesCollection().doc(id).get();
  if (!snapshot.exists) return null;
  const record = batchRecordFromDoc(snapshot);
  if (!batchRecordMatchesScope(record, ownerId, workspaceScope)) return null;
  return record;
}

async function listBatchRecords(userId, workspaceScope, limit = 20) {
  const ownerId = userId || DEFAULT_USER_ID;
  const snapshot = await postBatchesCollection().where('userId', '==', ownerId).get();
  return snapshot.docs
    .map(batchRecordFromDoc)
    .filter((record) => batchRecordMatchesScope(record, ownerId, workspaceScope))
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    .slice(0, Math.max(1, Math.min(100, Number(limit) || 20)));
}

async function updateBatchRecord(userId, batchId, patch, workspaceScope) {
  const existing = await getBatchRecord(userId, batchId, workspaceScope);
  if (!existing) return null;
  const safePatch = {};
  if (typeof patch.status === 'string' && patch.status.trim()) safePatch.status = patch.status.trim();
  for (const key of ['preparedCount', 'failedCount', 'acceptedCount', 'itemCount']) {
    if (Number.isInteger(patch[key]) && patch[key] >= 0) safePatch[key] = patch[key];
  }
  await postBatchesCollection().doc(existing.batchId).update({
    ...safePatch,
    updatedAt: FieldValue.serverTimestamp()
  });
  const snapshot = await postBatchesCollection().doc(existing.batchId).get();
  return batchRecordFromDoc(snapshot);
}

async function getBatchPosts(userId, batchId, workspaceScope) {
  const ownerId = userId || DEFAULT_USER_ID;
  const id = String(batchId || '').trim();
  if (!id) return [];
  const snapshot = await postsCollection()
    .where('userId', '==', ownerId)
    .where('batchId', '==', id)
    .get();
  return snapshot.docs
    .map(postFromDoc)
    .filter((post) => recordMatchesWorkspace({ userId: post.userId, workspaceId: post.workspaceId }, ownerId, workspaceScope))
    .sort((a, b) => (a.batchOrder ?? 0) - (b.batchOrder ?? 0));
}

// Monotonic tally of how many items were ever removed from this batch.
// Atomic FieldValue.increment so concurrent per-item and whole-batch delete
// calls can never lose an update (unlike the recomputed-from-truth counters
// in updateBatchRecord, deletion history cannot be re-derived by re-querying
// live posts once they are gone).
async function incrementBatchDeletedCount(userId, batchId, delta, workspaceScope) {
  const existing = await getBatchRecord(userId, batchId, workspaceScope);
  if (!existing || !Number.isInteger(delta) || delta <= 0) return existing;
  await postBatchesCollection().doc(existing.batchId).update({
    deletedCount: FieldValue.increment(delta),
    updatedAt: FieldValue.serverTimestamp()
  });
  const snapshot = await postBatchesCollection().doc(existing.batchId).get();
  return batchRecordFromDoc(snapshot);
}

// Full cleanup: physically removes the postBatches document. Callers must
// only invoke this once every child post has been reconciled (deleted or
// otherwise resolved) — this function does not check child state itself, so
// batchService is responsible for proving zero residue before calling it.
async function deleteBatchRecord(userId, batchId, workspaceScope) {
  const existing = await getBatchRecord(userId, batchId, workspaceScope);
  if (!existing) return false;
  await postBatchesCollection().doc(existing.batchId).delete();
  return true;
}

// ── Destination custody ────────────────────────────────────────────────────
// The one write path that may move an unapproved draft to another
// provider/account. Runs as a transaction so a concurrent approval can never
// interleave with a destination change: an approved job's destination is
// locked until approval is explicitly revoked. Generic website patches
// cannot reach these fields (postsMapper.mapPatchToFirestore strips them).

async function changePostDestination(userId, postId, destination = {}, workspaceScope) {
  const ownerId = userId || DEFAULT_USER_ID;
  const ref = postsCollection().doc(String(postId || ''));

  const outcome = await getFirestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { outcome: 'not_found' };
    const data = snap.data() || {};
    if ((data.userId || DEFAULT_USER_ID) !== ownerId) return { outcome: 'not_found' };
    if (!recordMatchesWorkspace(data, ownerId, workspaceScope)) return { outcome: 'not_found' };

    const current = postFromDoc(snap);
    if (!['pending', 'scheduled'].includes(current.status)) {
      return { outcome: 'queue_transition_blocked', post: current };
    }
    if (current.approved) {
      return { outcome: 'approval_locked', post: current };
    }

    const providerResolution = providers.normalizeStoredProviderId(destination.provider);
    if (!providerResolution.known) {
      return { outcome: 'unknown_provider' };
    }
    const providerId = providerResolution.providerId;
    const accountId = String(destination.accountId || '').trim();
    if (!accountId) return { outcome: 'invalid_destination' };

    const identityChanged = current.provider !== providerId || current.accountId !== accountId;
    const label = destination.username ? `@${destination.username}` : accountId;
    const patch = {
      provider: providerId,
      platform: providerId,
      accountId,
      connectedAccountId: `${providerId}:${accountId}`,
      tiktokOpenId: providerId === 'tiktok' ? String(destination.tiktokOpenId || accountId) : '',
      username: String(destination.username || '').trim(),
      // YouTube drafts keep a closed attempt ceiling until a human approval
      // grants exactly one claim (approvePost); TikTok uses the scheduler's
      // bounded default. Mirrors the creation-time contract exactly.
      publishAttemptBudget: providerId === providers.PROVIDER_YOUTUBE ? 0 : null,
      updatedAt: FieldValue.serverTimestamp()
    };
    // Bounded provider metadata: YouTube receives the validated envelope.
    // On a switch AWAY from YouTube the stored metadata is intentionally
    // retained so a human-entered title survives a provider round trip; the
    // TikTok paths never read it, and a later switch back re-validates it.
    if (providerId === providers.PROVIDER_YOUTUBE) {
      patch.providerMetadata = boundedProviderMetadata(providerId, { youtube: destination.youtube });
    }
    patch.history = appendHistoryEntry(
      data.history,
      identityChanged ? 'destination_changed' : 'edited',
      identityChanged
        ? `Destination changed to ${providerId} ${label} in batch review. The draft still requires human approval.`
        : 'YouTube title/description updated in batch review.'
    );
    tx.update(ref, patch);
    return { outcome: 'changed', identityChanged };
  });

  if (outcome.outcome !== 'changed') return outcome;
  const post = await getPost(ownerId, postId, undefined, workspaceScope);
  return { ...outcome, post };
}

// ── Platform batch preparation custody ─────────────────────────────────────
// Preparation runs at-most-once per lease: claim flips pending/stale/failed
// work to running inside one transaction, so overlapping runners (resume
// after a crash, double-clicked resume, two processes) can never prepare the
// same item concurrently. Mirrors scheduler.claimPost's transactional shape.

async function claimBatchItemPreparation(userId, postId, options = {}) {
  const ownerId = userId || DEFAULT_USER_ID;
  const leaseMs = Math.max(60_000, Number(options.leaseMs || 10 * 60_000));
  const maxAttempts = Math.max(1, Number(options.maxAttempts || 3));
  const ref = postsCollection().doc(String(postId || ''));

  return getFirestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { outcome: 'not_found' };
    const data = snap.data() || {};
    if ((data.userId || DEFAULT_USER_ID) !== ownerId) return { outcome: 'not_found' };
    if (!data.batchId) return { outcome: 'not_batch_item' };

    const status = normalizeQueueStatus(data.status);
    if (!['pending', 'scheduled'].includes(status)) {
      return { outcome: 'not_preparable', post: postFromDoc(snap) };
    }

    const preparation = data.preparation && typeof data.preparation === 'object' ? data.preparation : {};
    const prepStatus = String(preparation.status || 'pending');
    const attempts = Number(preparation.attempts || 0);
    if (prepStatus === 'succeeded') return { outcome: 'already_succeeded', post: postFromDoc(snap) };
    if (prepStatus === 'running') {
      const leaseAtMs = preparation.leaseAt && typeof preparation.leaseAt.toDate === 'function'
        ? preparation.leaseAt.toDate().getTime()
        : 0;
      if (leaseAtMs && Date.now() - leaseAtMs < leaseMs) {
        return { outcome: 'in_progress', post: postFromDoc(snap) };
      }
      // Stale lease: the previous runner died mid-preparation. Reclaim.
    }
    if (attempts >= maxAttempts) {
      return { outcome: 'attempts_exhausted', post: postFromDoc(snap) };
    }

    tx.update(ref, {
      preparation: {
        ...preparation,
        status: 'running',
        attempts: attempts + 1,
        leaseAt: Timestamp.now(),
        error: ''
      },
      updatedAt: FieldValue.serverTimestamp()
    });
    return { outcome: 'claimed', post: postFromDoc(snap), attempt: attempts + 1 };
  });
}

async function recordBatchItemPreparationResult(userId, postId, result = {}) {
  const ownerId = userId || DEFAULT_USER_ID;
  const ref = postsCollection().doc(String(postId || ''));

  return getFirestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const data = snap.data() || {};
    if ((data.userId || DEFAULT_USER_ID) !== ownerId) return null;
    const preparation = data.preparation && typeof data.preparation === 'object' ? data.preparation : {};
    if (String(preparation.status || '') !== 'running') return null;

    const patch = { updatedAt: FieldValue.serverTimestamp() };
    if (result.ok) {
      // Preparation fills text only where the operator has not already
      // written something — human edits always win over generated copy.
      const caption = String(result.caption || '').trim();
      const hashtags = String(result.hashtags || '').trim();
      if (caption && !String(data.caption || '').trim()) patch.caption = caption;
      if (hashtags && !String(data.hashtags || '').trim()) patch.hashtags = hashtags;
      patch.preparation = {
        ...preparation,
        status: 'succeeded',
        leaseAt: null,
        finishedAt: Timestamp.now(),
        provider: String(result.provider || '').slice(0, 40),
        fallbackUsed: Boolean(result.fallbackUsed),
        error: ''
      };
      patch.history = appendHistoryEntry(
        data.history,
        'prepared',
        result.fallbackUsed
          ? 'Caption and hashtags generated with the local fallback (no AI provider reachable). Review before accepting.'
          : `Caption and hashtags generated by ${result.provider || 'the AI provider'}. Review before accepting.`
      );
    } else {
      patch.preparation = {
        ...preparation,
        status: 'failed',
        leaseAt: null,
        finishedAt: Timestamp.now(),
        error: String(result.error || 'Preparation failed.').slice(0, 500)
      };
      patch.history = appendHistoryEntry(
        data.history,
        'preparation_failed',
        String(result.error || 'Preparation failed.').slice(0, 300)
      );
    }
    tx.update(ref, patch);
    return { ok: Boolean(result.ok) };
  });
}

async function reschedulePendingQueue(userId, accountId, workspaceScope) {
  const ownerId = userId || DEFAULT_USER_ID;
  const posts = await getPosts(ownerId, accountId, workspaceScope);
  const settings = await getSettings();
  let nextDate = tomorrowAtTime(settings.dailyPostTime);

  const db = getFirestore();
  const batch = db.batch();
  let count = 0;

  for (const post of posts) {
    if (!['pending', 'scheduled'].includes(post.status)) continue;
    batch.update(postsCollection().doc(post.id), {
      scheduledAt: Timestamp.fromDate(nextDate),
      status: 'scheduled',
      updatedAt: FieldValue.serverTimestamp()
    });
    nextDate = addDaysAtTime(nextDate, 1, settings.dailyPostTime);
    count += 1;
  }

  if (count > 0) await batch.commit();
  return count;
}

function getNextAvailableDate(posts, dailyPostTime, newlyCreatedIds) {
  const tomorrow = tomorrowAtTime(dailyPostTime);
  const futureScheduledTimes = posts
    .filter((post) => !newlyCreatedIds.has(post.id))
    .filter((post) => post.status === 'scheduled' && post.scheduledAt)
    .map((post) => new Date(post.scheduledAt))
    .filter((date) => date.getTime() >= tomorrow.getTime())
    .map((date) => date.getTime());

  if (futureScheduledTimes.length === 0) return tomorrow;

  const latest = new Date(Math.max(...futureScheduledTimes));
  return addDaysAtTime(latest, 1, dailyPostTime);
}

function tomorrowAtTime(time) {
  return zonedDayAtTime(DateTime.now().setZone(getScheduleTimeZone()).plus({ days: 1 }), time);
}

function addDaysAtTime(date, days, time) {
  const base = DateTime.fromJSDate(date, { zone: 'utc' }).setZone(getScheduleTimeZone()).plus({ days });
  return zonedDayAtTime(base, time);
}

function zonedDayAtTime(day, time) {
  const zone = getScheduleTimeZone();
  const { hours, minutes } = parseDailyTime(time);
  return day
    .setZone(zone)
    .set({ hour: hours, minute: minutes, second: 0, millisecond: 0 })
    .toUTC()
    .toJSDate();
}

function parseDailyTime(time) {
  const [hours, minutes] = String(time || '09:00')
    .split(':')
    .map((part) => Number(part));

  return {
    hours: Number.isInteger(hours) && hours >= 0 && hours <= 23 ? hours : 9,
    minutes: Number.isInteger(minutes) && minutes >= 0 && minutes <= 59 ? minutes : 0
  };
}

function getScheduleTimeZone() {
  const zone = config.appTimeZone || 'UTC';
  return DateTime.now().setZone(zone).isValid ? zone : 'UTC';
}

async function getCounts(userId, accountId, workspaceScope) {
  const posts = await getPosts(userId, accountId, workspaceScope);
  return posts.reduce(
    (counts, post) => {
      counts.total += 1;
      counts[post.status] = (counts[post.status] || 0) + 1;
      return counts;
    },
    { total: 0, pending: 0, scheduled: 0, processing: 0, ready: 0, posted: 0, failed: 0 }
  );
}

// ── Settings & integration auth ─────────────────────────────────────────
// Still a single shared doc each — today there's only one TikTok account
// and one Instagram account for the whole app, same as before. The
// difference from the old storage.js is just *where* they live: Firestore
// instead of data/*.json, so a Render restart can't erase them. If you
// later want each user to connect their own TikTok/Instagram account,
// these would move under a per-user path — that's a separate feature.

async function getSettings() {
  const snap = await configDoc('settings').get();
  return { ...defaultSettings, ...(snap.exists ? snap.data() : {}) };
}

async function saveSettings(settings) {
  const next = { ...(await getSettings()), ...settings, updatedAt: new Date().toISOString() };
  await configDoc('settings').set(next);
  return next;
}

async function getTikTokAuth() {
  const snap = await configDoc('tiktokAuth').get();
  return { ...defaultTikTokAuth, ...(snap.exists ? snap.data() : {}) };
}

async function saveTikTokAuth(auth) {
  const next = {
    ...defaultTikTokAuth,
    ...auth,
    connected: Boolean(auth.connected && auth.access_token)
  };
  await configDoc('tiktokAuth').set(next);
  return next;
}

async function clearTikTokAuth() {
  await configDoc('tiktokAuth').set(defaultTikTokAuth);
  return defaultTikTokAuth;
}

async function getInstagramAuth() {
  const snap = await configDoc('instagramAuth').get();
  return { ...defaultInstagramAuth, ...(snap.exists ? snap.data() : {}) };
}

async function saveInstagramAuth(auth) {
  const previous = await getInstagramAuth();
  const now = new Date().toISOString();
  const next = {
    ...defaultInstagramAuth,
    ...previous,
    ...auth,
    connected: Boolean(auth.connected && (auth.access_token || previous.access_token)),
    connected_at: previous.connected_at || auth.connected_at || now,
    updated_at: now
  };
  await configDoc('instagramAuth').set(next);
  return next;
}

async function clearInstagramAuth() {
  await configDoc('instagramAuth').set(defaultInstagramAuth);
  return defaultInstagramAuth;
}

module.exports = {
  ConnectedAccountActivationError,
  ensureStorage,
  checkMediaStorageHealth,
  getPosts,
  getDashboardJobs,
  getPost,
  getRecentJobs,
  getSettings,
  saveSettings,
  getCanonicalTikTokAccounts,
  getCanonicalTikTokAccount,
  getTikTokAccounts,
  getTikTokAccount,
  saveTikTokAccount,
  updateTikTokAccountProfile,
  disconnectTikTokAccount,
  getYouTubeAccounts,
  getYouTubeAccount,
  listConnectedAccountReferencesForOwner,
  saveYouTubeAccount,
  getYouTubeAccountCredential,
  updateYouTubeAccountTokenState,
  markYouTubeAccountReauthorizationRequired,
  disconnectYouTubeAccount,
  generateClientAccessCode,
  revokeClientAccessCode,
  verifyClientAccessCode,
  resolveClientAccount,
  getTikTokAuth,
  saveTikTokAuth,
  clearTikTokAuth,
  getInstagramAuth,
  saveInstagramAuth,
  clearInstagramAuth,
  addUploadedPosts,
  updatePost,
  bindYouTubeProviderOperationMedia,
  persistYouTubeSessionLocator,
  recordYouTubeUploadAttempt,
  recordYouTubeAcceptedByteOffset,
  recordYouTubeProviderResponse,
  claimYouTubeReconciliationAttempt,
  releaseYouTubeReconciliationLease,
  recordYouTubeProviderStatusReceipt,
  recordYouTubeProviderOperationFailure,
  getYouTubeProviderOperationInternal,
  applyYouTubeProviderReconciliationResult,
  retryFailedPost,
  approvePost,
  revokePostApproval,
  markPostManuallyWithUsage,
  deletePost,
  movePost,
  autoSchedulePosts,
  applyExplicitSchedule,
  applyStaggeredSchedule,
  applyBatchSourceSchedule,
  changePostDestination,
  createBatchRecord,
  getBatchRecord,
  listBatchRecords,
  updateBatchRecord,
  incrementBatchDeletedCount,
  deleteBatchRecord,
  getBatchPosts,
  claimBatchItemPreparation,
  recordBatchItemPreparationResult,
  reschedulePendingQueue,
  getCounts,
  DEFAULT_USER_ID
};
