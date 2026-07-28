'use strict';

const crypto = require('node:crypto');
const admin = require('firebase-admin');
const {
  OperationalHistoryArchiveError,
  createFounderArchiveApproval,
  createOperationalHistoryArchiveService,
  recordFingerprint,
  sanitizeOperationalArchive
} = require('./operationalHistoryArchive');

const AUTHORITY_MODE = 'firestore_emulator';
const DEFAULT_COLLECTIONS = Object.freeze({
  posts: 'posts',
  postBatches: 'postBatches',
  canonicalCommands: 'canonicalCommands',
  missionGraphs: 'missionGraphs',
  evidenceRecords: 'evidenceRecords',
  authorityManifests: 'operationalArchiveAuthority',
  operations: 'operationalArchiveOperations'
});
const OWNERSHIP_FIELDS = Object.freeze({
  posts: 'userId',
  postBatches: 'userId',
  canonicalCommands: 'ownerId',
  missionGraphs: 'ownerId',
  evidenceRecords: 'ownerId'
});
const LOOPBACK_EMULATOR_HOST = /^(?:127\.0\.0\.1|localhost|\[::1\]):[1-9]\d{0,4}$/i;

function text(value) {
  return String(value === null || value === undefined ? '' : value).trim();
}

function clone(value) {
  if (value === undefined) return undefined;
  return structuredClone(value);
}

function stableDocumentId(prefix, value) {
  return `${prefix}-${crypto.createHash('sha256').update(text(value)).digest('hex')}`;
}

function authorityDocumentId(ownerId) {
  return stableDocumentId('owner', ownerId);
}

function emulatorSafetyError(message, code) {
  return new OperationalHistoryArchiveError(message, { code, status: 503 });
}

function assertFirestoreEmulatorSafety({
  emulatorHost = process.env.FIRESTORE_EMULATOR_HOST,
  projectId = process.env.GCLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID
} = {}) {
  const exactHost = text(emulatorHost);
  const exactProjectId = text(projectId);
  if (!exactHost) {
    throw emulatorSafetyError(
      'Operational history archive requires FIRESTORE_EMULATOR_HOST.',
      'firestore_emulator_required'
    );
  }
  if (!LOOPBACK_EMULATOR_HOST.test(exactHost)) {
    throw emulatorSafetyError(
      'Operational history archive accepts only a loopback Firestore emulator host.',
      'firestore_emulator_host_invalid'
    );
  }
  if (!exactProjectId.startsWith('demo-')) {
    throw emulatorSafetyError(
      'Operational history archive accepts only a Firebase demo project ID.',
      'firestore_demo_project_required'
    );
  }
  return {
    authorityMode: AUTHORITY_MODE,
    emulatorHost: exactHost,
    projectId: exactProjectId
  };
}

function firestoreRecord(snapshot) {
  const data = snapshot.data() || {};
  return { ...data, id: snapshot.id };
}

function collectionSettings(overrides) {
  const settings = { ...DEFAULT_COLLECTIONS, ...(overrides || {}) };
  for (const [key, value] of Object.entries(settings)) {
    if (!text(value)) throw new TypeError(`Firestore archive collection ${key} is required.`);
  }
  return settings;
}

function createFirestoreEmulatorArchiveRepository({
  db,
  ownerId,
  emulatorHost,
  projectId,
  collectionNames,
  beforeArchiveRecord
} = {}) {
  const safety = assertFirestoreEmulatorSafety({ emulatorHost, projectId });
  const exactOwnerId = text(ownerId);
  if (!exactOwnerId) throw new TypeError('An explicit archive ownerId is required.');
  if (!db || typeof db.collection !== 'function' || typeof db.runTransaction !== 'function') {
    throw new TypeError('A Firestore database instance is required.');
  }
  const collections = collectionSettings(collectionNames);

  async function loadOwnedCollection(key) {
    const snapshot = await db.collection(collections[key])
      .where(OWNERSHIP_FIELDS[key], '==', exactOwnerId)
      .get();
    return snapshot.docs.map(firestoreRecord);
  }

  async function loadAuthorityManifest() {
    const snapshot = await db.collection(collections.authorityManifests)
      .doc(authorityDocumentId(exactOwnerId))
      .get();
    return snapshot.exists ? firestoreRecord(snapshot) : null;
  }

  function archiveTarget(recordType, recordId) {
    if (recordType === 'post') {
      return {
        ownerField: OWNERSHIP_FIELDS.posts,
        ref: db.collection(collections.posts).doc(recordId)
      };
    }
    if (recordType === 'postBatch') {
      return {
        ownerField: OWNERSHIP_FIELDS.postBatches,
        ref: db.collection(collections.postBatches).doc(recordId)
      };
    }
    return null;
  }

  return {
    safety,
    collectionNames: collections,
    async loadDataset() {
      const [
        posts,
        postBatches,
        canonicalCommands,
        missionGraphs,
        evidenceRecords,
        authorityManifest
      ] = await Promise.all([
        loadOwnedCollection('posts'),
        loadOwnedCollection('postBatches'),
        loadOwnedCollection('canonicalCommands'),
        loadOwnedCollection('missionGraphs'),
        loadOwnedCollection('evidenceRecords'),
        loadAuthorityManifest()
      ]);
      return {
        authorityManifest,
        posts,
        postBatches,
        canonicalCommands,
        missionGraphs,
        evidenceRecords
      };
    },
    async getOperation(operationId) {
      const exactOperationId = text(operationId);
      if (!exactOperationId) return null;
      const snapshot = await db.collection(collections.operations).doc(exactOperationId).get();
      if (!snapshot.exists) return null;
      const operation = snapshot.data() || {};
      return operation.ownerId === exactOwnerId ? operation : null;
    },
    async archiveRecord(input) {
      const exactRecordId = text(input && input.recordId);
      const target = archiveTarget(text(input && input.recordType), exactRecordId);
      if (!target) return { status: 'skipped', reason: 'record_type_unsupported' };
      if (typeof beforeArchiveRecord === 'function') {
        await beforeArchiveRecord({
          ownerId: exactOwnerId,
          recordType: text(input.recordType),
          recordId: exactRecordId
        });
      }
      return db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(target.ref);
        if (!snapshot.exists) return { status: 'skipped', reason: 'record_not_found' };
        const current = firestoreRecord(snapshot);
        if (text(current[target.ownerField]) !== exactOwnerId) {
          return { status: 'skipped', reason: 'archive_owner_unproven' };
        }
        const existing = sanitizeOperationalArchive(current.operationalArchive);
        if (existing) {
          return existing.operationId === input.archive.operationId
            ? { status: 'already_archived_same_operation' }
            : { status: 'skipped', reason: 'already_archived_by_other_operation' };
        }
        if (recordFingerprint(current) !== text(input.expectedFingerprint)) {
          return { status: 'skipped', reason: 'record_changed_since_preview' };
        }
        transaction.update(target.ref, { operationalArchive: clone(input.archive) });
        return { status: 'archived' };
      });
    },
    async saveOperation(operation) {
      const ref = db.collection(collections.operations).doc(text(operation.operationId));
      return db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(ref);
        if (snapshot.exists) return snapshot.data() || {};
        transaction.create(ref, clone(operation));
        return clone(operation);
      });
    }
  };
}

function createEmulatorFirestore({
  adminSdk = admin,
  emulatorHost,
  projectId,
  appName
} = {}) {
  const safety = assertFirestoreEmulatorSafety({ emulatorHost, projectId });
  const exactAppName = text(appName)
    || stableDocumentId('autoposter-operational-archive', safety.projectId);
  let app = (adminSdk.apps || []).find((candidate) => candidate.name === exactAppName);
  if (!app) {
    app = adminSdk.initializeApp({ projectId: safety.projectId }, exactAppName);
  }
  const db = app.firestore();
  try {
    db.settings({ ignoreUndefinedProperties: true });
  } catch (error) {
    if (!/already been initialized/i.test(text(error && error.message))) throw error;
  }
  return { app, db, safety };
}

function createFirestoreEmulatorArchiveCommandService({
  db,
  ownerId,
  approvalSecret,
  now,
  emulatorHost,
  projectId,
  collectionNames,
  beforeArchiveRecord
} = {}) {
  const safety = assertFirestoreEmulatorSafety({ emulatorHost, projectId });
  const repository = createFirestoreEmulatorArchiveRepository({
    db,
    ownerId,
    emulatorHost: safety.emulatorHost,
    projectId: safety.projectId,
    collectionNames,
    beforeArchiveRecord
  });
  const archiveService = createOperationalHistoryArchiveService({
    repository,
    ownerId,
    authorityMode: AUTHORITY_MODE,
    approvalSecret,
    now
  });
  return {
    safety,
    repository,
    preview: (input) => archiveService.preview(input),
    approve(preview, input) {
      return createFounderArchiveApproval(preview, {
        approverId: input && input.approverId,
        approvedAt: input && input.approvedAt,
        secret: approvalSecret
      });
    },
    execute: (input) => archiveService.execute(input),
    getResult: (operationId) => repository.getOperation(operationId)
  };
}

module.exports = {
  AUTHORITY_MODE,
  DEFAULT_COLLECTIONS,
  assertFirestoreEmulatorSafety,
  authorityDocumentId,
  createEmulatorFirestore,
  createFirestoreEmulatorArchiveCommandService,
  createFirestoreEmulatorArchiveRepository
};
