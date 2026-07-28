#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  OperationalHistoryArchiveError
} = require('../src/operationalHistoryArchive');
const {
  createEmulatorFirestore,
  createFirestoreEmulatorArchiveCommandService
} = require('../src/operationalHistoryArchiveFirestore');

function text(value) {
  return String(value === null || value === undefined ? '' : value).trim();
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      args[key] = next;
      index += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function positiveInteger(value, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new TypeError('max-candidates must be a positive integer.');
  }
  return parsed;
}

function readJson(filePath, label) {
  const exactPath = path.resolve(text(filePath));
  if (!exactPath || !fs.existsSync(exactPath)) {
    throw new TypeError(`${label} JSON file is required.`);
  }
  return JSON.parse(fs.readFileSync(exactPath, 'utf8'));
}

function writeResult(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const mode = text(args.mode || 'preview').toLowerCase();
  const ownerId = text(args.owner);
  const approvalSecret = text(process.env.AUTOPOSTER_ARCHIVE_APPROVAL_SECRET);
  const projectId = text(args.project || process.env.GCLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID);
  const emulatorHost = text(process.env.FIRESTORE_EMULATOR_HOST);
  const maxCandidates = positiveInteger(args['max-candidates'], 100);
  const fixedNow = text(args.now);
  if (!ownerId) throw new TypeError('--owner is required.');
  if (['approve', 'execute'].includes(mode) && !approvalSecret) {
    throw new TypeError('AUTOPOSTER_ARCHIVE_APPROVAL_SECRET is required.');
  }

  const { db, safety } = createEmulatorFirestore({ emulatorHost, projectId });
  const command = createFirestoreEmulatorArchiveCommandService({
    db,
    ownerId,
    approvalSecret,
    emulatorHost: safety.emulatorHost,
    projectId: safety.projectId,
    now: fixedNow ? () => fixedNow : undefined
  });

  if (mode === 'preview') {
    const preview = await command.preview({ maxCandidates });
    writeResult({ ok: true, mode, safety, preview });
    return;
  }
  if (mode === 'approve') {
    const preview = await command.preview({ maxCandidates });
    const approval = command.approve(preview, {
      approverId: text(args.approver),
      approvedAt: text(args['approved-at']) || new Date().toISOString()
    });
    writeResult({ ok: true, mode, safety, preview, approval });
    return;
  }
  if (mode === 'execute') {
    const approvalInput = readJson(args.approval, 'approval');
    const approval = approvalInput.approval || approvalInput;
    const evidence = await command.execute({ approval, maxCandidates });
    writeResult({ ok: true, mode, safety, evidence });
    return;
  }
  if (mode === 'get') {
    const operationId = text(args['operation-id']);
    if (!operationId) throw new TypeError('--operation-id is required.');
    const evidence = await command.getResult(operationId);
    writeResult({ ok: Boolean(evidence), mode, safety, evidence });
    if (!evidence) process.exitCode = 4;
    return;
  }
  throw new TypeError('mode must be preview, approve, execute, or get.');
}

main().catch((error) => {
  const known = error instanceof OperationalHistoryArchiveError;
  process.stderr.write(`${JSON.stringify({
    ok: false,
    code: known ? error.code : 'archive_emulator_command_failed',
    message: text(error && error.message),
    details: known ? error.details : undefined
  }, null, 2)}\n`);
  process.exitCode = known ? 2 : 1;
});
