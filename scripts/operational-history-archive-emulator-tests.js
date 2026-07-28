#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const {
  CANONICAL_ARCHIVE_EMULATOR_PROJECT_ID,
  assertFirestoreEmulatorSafety
} = require('../src/operationalHistoryArchiveFirestore');

const SUITES = Object.freeze({
  canonical: Object.freeze([
    'test/operational-history-archive-firestore-emulator.test.js',
    'test/operational-history-archive-controls-emulator.test.js'
  ]),
  focused: Object.freeze([
    'test/operational-history-audit.test.js',
    'test/operational-history-archive.test.js',
    'test/operational-history-archive-firestore-emulator.test.js',
    'test/operational-history-archive-controls-emulator.test.js',
    'test/admin-auth.test.js',
    'test/private-routes.test.js',
    'test/queue-delete-storage.test.js',
    'test/queue-delete-routes.test.js'
  ])
});

function run() {
  const suiteName = String(process.argv[2] || '').trim();
  const testFiles = SUITES[suiteName];
  if (!testFiles) {
    process.stderr.write('Archive emulator test suite must be canonical or focused.\n');
    process.exitCode = 2;
    return;
  }

  const safety = assertFirestoreEmulatorSafety({
    emulatorHost: process.env.FIRESTORE_EMULATOR_HOST,
    projectId: CANONICAL_ARCHIVE_EMULATOR_PROJECT_ID
  });
  const env = {
    ...process.env,
    GCLOUD_PROJECT: safety.projectId,
    GOOGLE_CLOUD_PROJECT: safety.projectId,
    FIREBASE_PROJECT_ID: safety.projectId,
    VITE_FIREBASE_PROJECT_ID: safety.projectId
  };

  process.stdout.write(
    `[ARCHIVE_EMULATOR_IDENTITY] suite=${suiteName} projectId=${safety.projectId} host=${safety.emulatorHost}\n`
  );
  const result = spawnSync(process.execPath, ['--test', ...testFiles], {
    cwd: process.cwd(),
    env,
    stdio: 'inherit',
    windowsHide: true
  });
  if (result.error) throw result.error;
  process.exitCode = Number.isInteger(result.status) ? result.status : 1;
}

run();
