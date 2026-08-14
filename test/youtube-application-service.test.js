'use strict';

// Shared application-service behavior for YouTube scheduling: the website
// and the Agent Runtime must resolve the same connected-account truth and
// create the same canonical queue shape, with every gate failing closed.

// A configured YouTube provider is required for these paths, so the env is
// set BEFORE any module loads. No live endpoint is ever called: scheduling
// stops at the storage boundary, which is faked below.
process.env.ADMIN_PASSWORD = 'test-admin-password-123';
process.env.TOKEN_ENCRYPTION_KEY = require('node:crypto').randomBytes(32).toString('base64');
process.env.YOUTUBE_CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
process.env.YOUTUBE_CLIENT_SECRET = 'test-client-secret';
process.env.YOUTUBE_REDIRECT_URI = 'http://localhost:10000/auth/youtube/callback';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createCommercialFixture } = require('./helpers/commercial-fixture');

const { createAutoPosterApplicationService, AutoPosterApplicationError } = require('../src/autoposterApplicationService');

const UPLOAD_SCOPE = 'https://www.googleapis.com/auth/youtube.upload';
const READONLY_SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';

function youtubeAccount(overrides = {}) {
  return {
    accountId: 'UC-chanter',
    id: 'UC-chanter',
    userId: 'owner',
    provider: 'youtube',
    platform: 'youtube',
    channelId: 'UC-chanter',
    username: 'chanterCy',
    displayName: 'chanterCy',
    connected: true,
    tokenPresent: true,
    refreshTokenPresent: true,
    accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    grantedScopes: `${UPLOAD_SCOPE} ${READONLY_SCOPE}`,
    scope: `${UPLOAD_SCOPE} ${READONLY_SCOPE}`,
    reauthorizationRequired: false,
    connectedAt: '2026-07-01T00:00:00.000Z',
    ...overrides
  };
}

function tiktokAccount(overrides = {}) {
  return {
    accountId: 'tt-account',
    userId: 'owner',
    open_id: 'tt-account',
    username: 'tiktok_user',
    connected: true,
    access_token: 'tt-access',
    refresh_token: 'tt-refresh',
    scope: 'user.info.basic,video.publish',
    ...overrides
  };
}

function buildService({
  account = youtubeAccount(),
  tiktok = tiktokAccount(),
  existingPosts = [],
  trustLookupOwner = false,
  references = null,
  failureInjector
} = {}) {
  const calls = { addUploadedPosts: [] };
  const matchesWorkspace = (candidate, workspaceScope) => {
    if (!candidate || !workspaceScope || !workspaceScope.workspaceId) return true;
    if (candidate.workspaceId) return candidate.workspaceId === workspaceScope.workspaceId;
    return Boolean(workspaceScope.allowLegacyOwnerRecords);
  };
  const storageFake = {
    getYouTubeAccount: async (userId, accountId, workspaceScope) =>
      (account && (trustLookupOwner || userId === account.userId) && accountId === account.accountId
        && matchesWorkspace(account, workspaceScope) ? account : null),
    getYouTubeAccounts: async () => (account ? [account] : []),
    getCanonicalTikTokAccount: async (userId, accountId, workspaceScope) =>
      (tiktok && (trustLookupOwner || userId === tiktok.userId) && accountId === tiktok.accountId
        && matchesWorkspace(tiktok, workspaceScope) ? tiktok : null),
    getCanonicalTikTokAccounts: async () => (tiktok ? [tiktok] : []),
    getTikTokAccount: async (userId, accountId, workspaceScope) =>
      (tiktok && (trustLookupOwner || userId === tiktok.userId) && accountId === tiktok.accountId
        && matchesWorkspace(tiktok, workspaceScope) ? tiktok : null),
    getTikTokAccounts: async () => (tiktok ? [tiktok] : []),
    listConnectedAccountReferencesForOwner: async () => references || [account, tiktok]
      .filter(Boolean)
      .map((candidate) => ({
        provider: candidate.provider || candidate.platform || 'tiktok',
        accountId: candidate.accountId,
        workspaceId: candidate.workspaceId || ''
      })),
    getPosts: async () => existingPosts,
    getPost: async () => null,
    addUploadedPosts: async (userId, files, defaults) => {
      calls.addUploadedPosts.push({ userId, files, defaults });
      return [{
        id: 'created-post-1',
        userId,
        provider: defaults.provider,
        accountId: defaults.accountId,
        username: defaults.username,
        connectedAccountId: `${defaults.provider}:${defaults.accountId}`,
        providerMetadata: defaults.providerMetadata || null,
        scheduledAt: defaults.scheduledAt || null,
        status: defaults.scheduledAt ? 'scheduled' : 'pending'
      }];
    },
    autoSchedulePosts: async (userId, ids) => ids.length,
    applyExplicitSchedule: async () => 1
  };
  return {
    service: createAutoPosterApplicationService({
      storage: storageFake,
      commercialService: createCommercialFixture(storageFake),
      failureInjector
    }),
    calls
  };
}

const websiteContext = { userId: 'owner', source: 'website' };
const runtimeContext = { userId: 'owner', source: 'runtime', idempotencyKey: 'mission-key-1' };

const scheduledAt = new Date(Date.now() + 3600_000).toISOString();

function youtubeInput(overrides = {}) {
  return {
    provider: 'youtube',
    accountIds: ['UC-chanter'],
    mediaUrl: 'https://res.cloudinary.com/demo/video/upload/clip.mp4',
    youtube: { title: 'Launch teaser', description: 'Private test upload' },
    schedule: { mode: 'explicit', scheduledAt },
    ...overrides
  };
}

test('YouTube scheduling requires a non-empty title; TikTok does not', async () => {
  const { service } = buildService();
  await assert.rejects(
    () => service.schedulePost(websiteContext, youtubeInput({ youtube: { title: '' } })),
    (error) => error instanceof AutoPosterApplicationError && error.code === 'invalid_provider_metadata'
  );
  await assert.rejects(
    () => service.schedulePost(websiteContext, youtubeInput({ youtube: undefined })),
    (error) => error.code === 'invalid_provider_metadata'
  );

  // The same request against TikTok needs no YouTube fields at all.
  const tiktokResult = await service.schedulePost(websiteContext, {
    accountIds: ['tt-account'],
    mediaUrl: 'https://res.cloudinary.com/demo/video/upload/clip.mp4',
    caption: 'A caption',
    schedule: { mode: 'explicit', scheduledAt }
  });
  assert.equal(tiktokResult.posts.length, 1);
  assert.equal(tiktokResult.posts[0].provider, 'tiktok');
});

test('website and runtime create the same canonical YouTube queue shape', async () => {
  const { service, calls } = buildService();
  await service.schedulePost(websiteContext, youtubeInput());
  await service.schedulePost(runtimeContext, youtubeInput({ requireSingle: true }));

  assert.equal(calls.addUploadedPosts.length, 2);
  const [website, runtime] = calls.addUploadedPosts.map((call) => call.defaults);
  for (const defaults of [website, runtime]) {
    assert.equal(defaults.provider, 'youtube');
    assert.equal(defaults.accountId, 'UC-chanter');
    assert.equal(defaults.username, 'chanterCy');
    assert.deepEqual(defaults.providerMetadata, { youtube: { title: 'Launch teaser', description: 'Private test upload', privacyStatus: 'private' } });
    assert.equal(defaults.scheduledAt, scheduledAt);
    // No token-shaped values may ride along into queue creation.
    const serialized = JSON.stringify(defaults);
    assert.equal(/access_token|refresh_token|client_secret|credential/i.test(serialized), false);
  }
  assert.equal(website.creationSource, 'website');
  assert.equal(runtime.creationSource, 'runtime');
  assert.equal(runtime.runtimeIdempotencyKey, 'mission-key-1');
  assert.equal(website.tiktokOpenId, '', 'YouTube jobs never borrow the TikTok identity alias');
  assert.equal(website.accounts[0].tiktokOpenId, '', 'YouTube targets stay provider-native');
  // Neither surface self-approves a YouTube draft here: publishing still
  // requires the human approval gate.
  assert.equal(website.selfApprove, null);
  assert.equal(runtime.selfApprove, null);
});

test('YouTube request with a TikTok connected account is rejected before queue creation', async () => {
  const { service, calls } = buildService({ account: tiktokAccount() });
  await assert.rejects(
    () => service.schedulePost(websiteContext, youtubeInput({ accountIds: ['tt-account'] })),
    (error) => error.code === 'provider_account_mismatch'
  );
  assert.equal(calls.addUploadedPosts.length, 0);
});

test('TikTok request with a YouTube connected account is rejected before queue creation', async () => {
  const { service, calls } = buildService({ tiktok: youtubeAccount() });
  await assert.rejects(
    () => service.schedulePost(websiteContext, {
      provider: 'tiktok',
      accountIds: ['UC-chanter'],
      mediaUrl: 'https://res.cloudinary.com/demo/video/upload/clip.mp4',
      caption: 'A caption',
      schedule: { mode: 'explicit', scheduledAt }
    }),
    (error) => error.code === 'provider_account_mismatch'
  );
  assert.equal(calls.addUploadedPosts.length, 0);
});

test('a storage lookup cannot return another owner account into queue creation', async () => {
  const { service, calls } = buildService({
    account: youtubeAccount({ userId: 'someone-else' }),
    trustLookupOwner: true
  });
  await assert.rejects(
    () => service.schedulePost(websiteContext, youtubeInput()),
    (error) => error.status === 404 && error.code === 'unknown_account_id'
  );
  assert.equal(calls.addUploadedPosts.length, 0);
});

test('one valid YouTube account creates exactly one provider-native draft', async () => {
  const { service, calls } = buildService();
  const result = await service.schedulePost(websiteContext, youtubeInput());
  assert.equal(calls.addUploadedPosts.length, 1);
  assert.equal(result.posts.length, 1);
  assert.equal(result.posts[0].provider, 'youtube');
  assert.equal(result.posts[0].connectedAccountId, 'youtube:UC-chanter');
  assert.equal(calls.addUploadedPosts[0].defaults.tiktokOpenId, '');
  assert.equal(calls.addUploadedPosts[0].defaults.selfApprove, null, 'approval gate remains closed');
});

test('exact connected-account preflight succeeds and returns only the canonical safe view', async () => {
  const { service } = buildService();
  const result = await service.validateConnectedAccount(websiteContext, {
    provider: 'youtube',
    accountId: 'UC-chanter'
  });

  assert.equal(result.account.accountId, 'UC-chanter');
  assert.equal(result.account.connectionId, 'youtube:UC-chanter');
  assert.equal(result.account.connectionStatus, 'connected');
  assert.equal(result.account.publishingReady, true);
  assert.equal(JSON.stringify(result).includes('credential'), false);
  assert.equal(JSON.stringify(result).includes('access_token'), false);
});

test('connected-account preflight emits stable exact typed failures without queue creation', async () => {
  const ready = buildService();
  const cases = [
    {
      name: 'unknown account',
      service: ready.service,
      context: websiteContext,
      input: { provider: 'youtube', accountId: 'CANARY-UNKNOWN-ACCOUNT-TOKEN' },
      code: 'unknown_account_id'
    },
    {
      name: 'case mismatch',
      service: ready.service,
      context: websiteContext,
      input: { provider: 'youtube', accountId: 'uc-CHANTER' },
      code: 'account_id_case_mismatch'
    },
    {
      name: 'surrounding whitespace',
      service: ready.service,
      context: websiteContext,
      input: { provider: 'youtube', accountId: ' UC-chanter' },
      code: 'account_id_non_canonical'
    },
    {
      name: 'provider mismatch',
      service: ready.service,
      context: websiteContext,
      input: { provider: 'youtube', accountId: 'tt-account' },
      code: 'provider_account_mismatch'
    },
    {
      name: 'disconnected account',
      service: buildService({
        account: youtubeAccount({ connected: false, tokenPresent: false })
      }).service,
      context: websiteContext,
      input: { provider: 'youtube', accountId: 'UC-chanter' },
      code: 'account_disconnected'
    },
    {
      name: 'not publishing-ready',
      service: buildService({
        account: youtubeAccount({ grantedScopes: READONLY_SCOPE, scope: READONLY_SCOPE })
      }).service,
      context: websiteContext,
      input: { provider: 'youtube', accountId: 'UC-chanter' },
      code: 'account_not_publishing_ready'
    }
  ];

  const workspaceMismatch = buildService({
    account: youtubeAccount({ workspaceId: 'workspace-other' }),
    references: [{ provider: 'youtube', accountId: 'UC-chanter', workspaceId: 'workspace-other' }]
  });
  cases.push({
    name: 'workspace mismatch',
    service: workspaceMismatch.service,
    context: { ...websiteContext, workspaceId: 'workspace-current' },
    input: { provider: 'youtube', accountId: 'UC-chanter' },
    code: 'account_workspace_mismatch'
  });

  for (const scenario of cases) {
    await assert.rejects(
      () => scenario.service.validateConnectedAccount(scenario.context, scenario.input),
      (error) => {
        assert.equal(error.code, scenario.code, scenario.name);
        assert.equal(JSON.stringify(error).includes('workspace-other'), false, 'other workspace stays undisclosed');
        assert.equal(JSON.stringify(error).includes('CANARY-UNKNOWN-ACCOUNT-TOKEN'), false, 'unknown input is not echoed');
        return true;
      }
    );
  }
  assert.equal(ready.calls.addUploadedPosts.length, 0);

  await assert.rejects(
    () => ready.service.schedulePost(runtimeContext, youtubeInput({ accountIds: ['uc-CHANTER'] })),
    (error) => error.code === 'account_id_case_mismatch'
  );
  assert.equal(ready.calls.addUploadedPosts.length, 0, 'schedule reuses preflight before queue creation');
});

test('a disconnected channel cannot schedule', async () => {
  const { service, calls } = buildService({ account: youtubeAccount({ connected: false, tokenPresent: false }) });
  await assert.rejects(
    () => service.schedulePost(websiteContext, youtubeInput()),
    (error) => error.status === 409
  );
  assert.equal(calls.addUploadedPosts.length, 0);
});

test('reauthorization_required blocks scheduling truthfully', async () => {
  const { service } = buildService({ account: youtubeAccount({ reauthorizationRequired: true }) });
  await assert.rejects(
    () => service.schedulePost(websiteContext, youtubeInput()),
    (error) => error.code === 'account_not_publishing_ready'
      && error.details.blockers.includes('reauthorization_required')
  );
});

test('a recorded scope set without youtube.upload blocks scheduling', async () => {
  const { service } = buildService({
    account: youtubeAccount({ grantedScopes: READONLY_SCOPE, scope: READONLY_SCOPE })
  });
  await assert.rejects(
    () => service.schedulePost(websiteContext, youtubeInput()),
    (error) => error.code === 'account_not_publishing_ready'
      && error.details.blockers.includes('missing_video_publish_scope')
  );
});

test('a channel owned by another tenant is not found', async () => {
  const { service } = buildService({ account: youtubeAccount({ userId: 'someone-else' }) });
  await assert.rejects(
    () => service.schedulePost(websiteContext, youtubeInput()),
    (error) => error.status === 404
  );
});

test('media stays video-only for YouTube', async () => {
  const { service } = buildService();
  await assert.rejects(
    () => service.schedulePost(websiteContext, youtubeInput({ mediaUrl: 'https://cdn.example.com/image.jpg' })),
    (error) => /video/i.test(error.message)
  );
});

test('a duplicate idempotency key returns the existing job instead of creating a second one', async () => {
  const existing = {
    id: 'existing-post',
    accountId: 'UC-chanter',
    provider: 'youtube',
    idempotencyKey: 'mission-key-1',
    runtimeIdempotencyKey: 'mission-key-1',
    status: 'scheduled',
    scheduledAt
  };
  const { service, calls } = buildService({ existingPosts: [existing] });
  const result = await service.schedulePost(runtimeContext, youtubeInput());
  assert.equal(result.duplicate, true);
  assert.equal(result.post.id, 'existing-post');
  assert.equal(calls.addUploadedPosts.length, 0, 'no second queue item was created');
});

test('durable-create failure hooks straddle the real storage boundary', async () => {
  const before = buildService({
    failureInjector(boundary) {
      if (boundary === 'before_autoposter_durable_create') throw new Error('injected-before-create');
    }
  });
  await assert.rejects(
    () => before.service.schedulePost(runtimeContext, youtubeInput()),
    /injected-before-create/
  );
  assert.equal(before.calls.addUploadedPosts.length, 0, 'pre-create crash leaves no queue record');

  const observed = [];
  const after = buildService({
    failureInjector(boundary) {
      observed.push(boundary);
      if (boundary === 'after_autoposter_durable_create_before_response') {
        throw new Error('injected-after-create');
      }
    }
  });
  await assert.rejects(
    () => after.service.schedulePost(runtimeContext, youtubeInput()),
    /injected-after-create/
  );
  assert.equal(after.calls.addUploadedPosts.length, 1, 'post-create crash occurs after one durable write');
  assert.deepEqual(observed, [
    'before_autoposter_durable_create',
    'after_autoposter_durable_create_before_response'
  ]);
});

test('the same raw account id and idempotency key remain isolated by provider', async () => {
  const sharedId = 'shared-provider-account';
  const existingTikTok = {
    id: 'existing-tiktok-post',
    accountId: sharedId,
    provider: 'tiktok',
    idempotencyKey: 'mission-key-1',
    runtimeIdempotencyKey: 'mission-key-1',
    status: 'scheduled',
    scheduledAt
  };
  const { service, calls } = buildService({
    account: youtubeAccount({ accountId: sharedId, channelId: sharedId }),
    tiktok: tiktokAccount({ accountId: sharedId, open_id: sharedId }),
    existingPosts: [existingTikTok]
  });

  const result = await service.schedulePost(
    runtimeContext,
    youtubeInput({ accountIds: [sharedId] })
  );

  assert.equal(result.duplicate, false);
  assert.equal(result.post.provider, 'youtube');
  assert.equal(result.post.accountId, sharedId);
  assert.equal(calls.addUploadedPosts.length, 1, 'the TikTok draft cannot satisfy a YouTube replay');
  assert.equal(calls.addUploadedPosts[0].defaults.provider, 'youtube');
});

test('unknown providers fail closed before any account or media work', async () => {
  const { service, calls } = buildService();
  await assert.rejects(
    () => service.schedulePost(websiteContext, youtubeInput({ provider: 'mastodon' })),
    (error) => error.code === 'unknown_provider'
  );
  assert.equal(calls.addUploadedPosts.length, 0);
});

test('website and runtime resolve the same safe connected-account view', async () => {
  const { service } = buildService();
  const website = await service.getConnectedAccount(websiteContext, { accountId: 'UC-chanter', provider: 'youtube' });
  const runtime = await service.getConnectedAccount({ userId: 'owner', source: 'runtime', idempotencyKey: 'k' }, { accountId: 'UC-chanter', provider: 'youtube' });
  assert.deepEqual(website.account, runtime.account, 'one connected-account truth for both surfaces');
  assert.equal(website.account.provider, 'youtube');
  assert.equal(website.account.publishingReady, true);
  assert.equal(website.account.connectionStatus, 'connected');
  const serialized = JSON.stringify(website);
  assert.equal(/access_token|refresh_token|credential|"ct"/i.test(serialized), false, 'no credential fields in the view');

  const list = await service.listConnectedAccounts(websiteContext, { provider: 'youtube' });
  assert.equal(list.accounts.length, 1);
  assert.equal(list.accounts[0].connectionId, 'youtube:UC-chanter');
});
