'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  OperationalHistoryArchiveError,
  createFounderArchiveApproval,
  createLocalFixtureArchiveRepository,
  createOperationalHistoryArchiveService
} = require('../src/operationalHistoryArchive');

const MAX_INPUT_BYTES = 25 * 1024 * 1024;
const APPROVAL_SECRET_ENV = 'AUTOPOSTER_ARCHIVE_APPROVAL_SECRET';

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
}

function fail(message, code = 'archive_command_invalid', exitCode = 2) {
  process.stderr.write(`${JSON.stringify({ ok: false, code, message })}\n`);
  process.stderr.write(
    'Usage:\n'
    + '  node scripts/operational-history-archive.js --mode preview --input <state.json> --owner <owner-id> [--max-candidates 25] [--now <ISO>] [--output <preview.json>]\n'
    + '  node scripts/operational-history-archive.js --mode approve --preview <preview.json> --approver <founder-id> --approved-at <ISO> --output <approval.json>\n'
    + '  node scripts/operational-history-archive.js --mode execute --input <state.json> --owner <owner-id> --approval <approval.json> --output <archived-state.json> [--max-candidates 25] [--now <ISO>]\n'
  );
  process.exitCode = exitCode;
}

function readJson(fileArg, label) {
  if (!fileArg) throw new OperationalHistoryArchiveError(`${label} is required.`, {
    code: 'archive_input_required',
    status: 400
  });
  const filePath = path.resolve(fileArg);
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size > MAX_INPUT_BYTES) {
    throw new OperationalHistoryArchiveError(
      `${label} must be one JSON file no larger than ${MAX_INPUT_BYTES} bytes.`,
      { code: 'archive_input_invalid', status: 400 }
    );
  }
  return {
    path: filePath,
    value: JSON.parse(fs.readFileSync(filePath, 'utf8'))
  };
}

function writeJson(fileArg, value) {
  if (!fileArg) return '';
  const outputPath = path.resolve(fileArg);
  if (fs.existsSync(outputPath)) {
    throw new OperationalHistoryArchiveError(
      `Output already exists and will not be overwritten: ${outputPath}`,
      { code: 'archive_output_exists', status: 409 }
    );
  }
  const parent = path.dirname(outputPath);
  if (!fs.statSync(parent).isDirectory()) {
    throw new OperationalHistoryArchiveError(
      `Output directory does not exist: ${parent}`,
      { code: 'archive_output_directory_missing', status: 400 }
    );
  }
  const temporaryPath = path.join(
    parent,
    `.${path.basename(outputPath)}.${process.pid}.${crypto.randomUUID()}.tmp`
  );
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    fs.renameSync(temporaryPath, outputPath);
  } catch (error) {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    throw error;
  }
  return outputPath;
}

function clock() {
  const supplied = argument('--now');
  return supplied || new Date().toISOString();
}

function approvalSecret() {
  return process.env[APPROVAL_SECRET_ENV] || '';
}

async function run() {
  const mode = String(argument('--mode') || 'preview').trim().toLowerCase();
  if (!['preview', 'approve', 'execute'].includes(mode)) {
    throw new OperationalHistoryArchiveError(`Unsupported archive mode: ${mode}`, {
      code: 'archive_mode_invalid',
      status: 400
    });
  }

  if (mode === 'approve') {
    const preview = readJson(argument('--preview'), 'Preview file').value;
    const approval = createFounderArchiveApproval(preview, {
      approverId: argument('--approver'),
      approvedAt: argument('--approved-at'),
      secret: approvalSecret()
    });
    const outputPath = writeJson(argument('--output'), approval);
    if (!outputPath) {
      throw new OperationalHistoryArchiveError('Approval output file is required.', {
        code: 'archive_output_required',
        status: 400
      });
    }
    process.stdout.write(`${JSON.stringify({
      ok: true,
      mode,
      operationId: approval.operationId,
      candidateIds: approval.candidateIds,
      outputPath
    }, null, 2)}\n`);
    return;
  }

  const input = readJson(argument('--input'), 'Explicit local fixture input');
  const ownerId = argument('--owner');
  const repository = createLocalFixtureArchiveRepository(input.value);
  const service = createOperationalHistoryArchiveService({
    repository,
    ownerId,
    authorityMode: 'explicit_local_fixture',
    approvalSecret: approvalSecret(),
    now: clock
  });
  const maxCandidates = argument('--max-candidates') || undefined;

  if (mode === 'preview') {
    const preview = await service.preview({ maxCandidates });
    const outputPath = writeJson(argument('--output'), preview);
    process.stdout.write(`${JSON.stringify({
      ...preview,
      outputPath: outputPath || null
    }, null, 2)}\n`);
    return;
  }

  const approval = readJson(argument('--approval'), 'Founder approval file').value;
  const evidence = await service.execute({ approval, maxCandidates });
  const outputPath = writeJson(argument('--output'), repository.snapshot());
  if (!outputPath) {
    throw new OperationalHistoryArchiveError('Archived state output file is required.', {
      code: 'archive_output_required',
      status: 400
    });
  }
  process.stdout.write(`${JSON.stringify({
    ok: evidence.state === 'completed',
    mode,
    evidence,
    outputPath
  }, null, 2)}\n`);
}

run().catch((error) => {
  const known = error instanceof OperationalHistoryArchiveError;
  fail(
    known ? error.message : 'Archive command failed.',
    known ? error.code : 'archive_command_failed',
    known && error.status === 403 ? 3 : 2
  );
});
