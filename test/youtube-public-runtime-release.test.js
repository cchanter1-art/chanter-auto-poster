'use strict';

process.env.ADMIN_PASSWORD = 'test-admin-password-123';
process.env.TOKEN_ENCRYPTION_KEY = require('node:crypto').randomBytes(32).toString('base64');
process.env.YOUTUBE_CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
process.env.YOUTUBE_CLIENT_SECRET = 'test-client-secret';
process.env.YOUTUBE_REDIRECT_URI = 'http://localhost:10000/auth/youtube/callback';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createCommercialFixture } = require('./helpers/commercial-fixture');
const { createAutoPosterApplicationService } = require('../src/autoposterApplicationService');

const UPLOAD_SCOPE = 'https://www.googleapis.com/auth/youtube.upload';
const READONLY_SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';

function buildHarness() {
  const account = {
    accountId: 'UC-chanter',
    id: 'UC-chanter',
    userId: 'owner',
    workspaceId: 'workspace-a',
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
  };
  let post = {
    id: 'queue-1',
    userId: 'owner',
    workspaceId: 'workspace-a',
    provider: 'youtube',
    accountId: 'UC-chanter',
    username: 'chanterCy',
    status: 'scheduled',
    approved: false,
    approvedBy: '',
    claimAttempts: 0,
    publishAttemptBudget: 0,
    runtimeGraphId: 'graph-1',
    runtimeMissionId: 'child-1',
    providerStatus: 'scheduled',
    providerMetadata: {
      youtube: { title: 'Launch', description: 'Lyrics', privacyStatus: 'private' }
    },
    providerVerification: null,
    providerOperation: null,
    publishId: '',
  };
  const calls = { changed: 0, approved: 0, processed: 0 };
  const storage = {
    getPosts: async () => [post],
    getPost: async (_userId, id, accountId) => id === post.id && accountId === post.accountId ? post : null,
    getYouTubeAccount: async (_userId, accountId) => accountId === account.accountId ? account : null,
    listConnectedAccountReferencesForOwner: async () => [account],
    changePostDestination: async (_userId, id, destination) => {
      assert.equal(id, post.id);
      assert.equal(destination.provider, 'youtube');
      assert.equal(destination.accountId, post.accountId);
      assert.equal(destination.youtube.privacyStatus, 'public');
      calls.changed += 1;
      post = {
        ...post,
        providerMetadata: { youtube: { ...destination.youtube } },
        publishAttemptBudget: 0,
      };
      return { outcome: 'changed', post };
    },
    approvePost: async (_userId, id, { approvedBy }) => {
      assert.equal(id, post.id);
      calls.approved += 1;
      post = {
        ...post,
        approved: true,
        approvedBy,
        approvalState: 'approved',
        publishAttemptBudget: Number(post.claimAttempts || 0) + 1,
      };
      return post;
    },
  };
  const scheduler = {
    processPost: async (id, options) => {
      assert.equal(id, post.id);
      assert.equal(options.force, true);
      calls.processed += 1;
      post = {
        ...post,
        status: 'posted',
        providerStatus: 'uploaded_public',
        publishId: 'video-1',
        claimAttempts: 1,
        providerVerification: {
          externalVideoId: 'video-1',
          channelId: 'UC-chanter',
          title: 'Launch',
          privacyStatus: 'public',
        },
        providerOperation: {
          operationState: 'completed_public',
          requestedVisibility: 'public',
        },
      };
    },
  };
  const service = createAutoPosterApplicationService({
    storage,
    scheduler,
    commercialService: createCommercialFixture(storage),
  });
  return { service, calls, getPost: () => post };
}

test('runtime public release requires explicit approval authority', async () => {
  const { service } = buildHarness();
  await assert.rejects(
    () => service.releaseYouTubePublic(
      { userId: 'owner', source: 'runtime', workspaceId: 'workspace-a' },
      {
        postId: 'queue-1',
        accountId: 'UC-chanter',
        runtimeGraphId: 'graph-1',
        runtimeMissionId: 'child-1',
        expectedTitle: 'Launch',
        approvedBy: 'founder',
      },
    ),
    (error) => error && error.code === 'forbidden',
  );
});

test('one runtime approval releases one exact public YouTube artifact and replay is idempotent', async () => {
  const { service, calls } = buildHarness();
  const context = {
    userId: 'owner',
    source: 'runtime',
    workspaceId: 'workspace-a',
    approval: { approvedBy: 'founder' },
  };
  const input = {
    postId: 'queue-1',
    accountId: 'UC-chanter',
    runtimeGraphId: 'graph-1',
    runtimeMissionId: 'child-1',
    expectedTitle: 'Launch',
    approvedBy: 'founder',
  };

  const first = await service.releaseYouTubePublic(context, input);
  assert.equal(first.ok, true);
  assert.equal(first.outcome, 'published');
  assert.equal(first.post.providerStatus, 'uploaded_public');
  assert.equal(first.post.providerVerification.privacyStatus, 'public');
  assert.equal(first.post.providerVerification.channelId, 'UC-chanter');
  assert.equal(first.post.providerVerification.title, 'Launch');
  assert.deepEqual(calls, { changed: 1, approved: 1, processed: 1 });

  const replay = await service.releaseYouTubePublic(context, input);
  assert.equal(replay.ok, true);
  assert.equal(replay.outcome, 'already_completed');
  assert.deepEqual(calls, { changed: 1, approved: 1, processed: 1 });
});
