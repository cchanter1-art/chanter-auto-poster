'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { auditOperationalHistory } = require('../src/operationalHistoryAudit');

const MAX_INPUT_BYTES = 25 * 1024 * 1024;

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.stderr.write(
    'Usage: node scripts/operational-history-audit.js --input <local-json-export> [--now <ISO timestamp>]\n'
  );
  process.exitCode = 2;
}

function run() {
  const inputArg = argument('--input');
  if (!inputArg) {
    fail('An explicit local JSON input is required. Firestore is never contacted by this command.');
    return;
  }
  const inputPath = path.resolve(inputArg);
  let stat;
  try {
    stat = fs.statSync(inputPath);
  } catch {
    fail(`Input file does not exist: ${inputPath}`);
    return;
  }
  if (!stat.isFile() || stat.size > MAX_INPUT_BYTES) {
    fail(`Input must be one JSON file no larger than ${MAX_INPUT_BYTES} bytes.`);
    return;
  }

  const bytes = fs.readFileSync(inputPath);
  let input;
  try {
    input = JSON.parse(bytes.toString('utf8'));
  } catch {
    fail(`Input is not valid JSON: ${inputPath}`);
    return;
  }

  const sourceHash = crypto.createHash('sha256').update(bytes).digest('hex');
  const report = auditOperationalHistory(input, {
    now: argument('--now') || new Date(),
    source: {
      kind: 'explicit_local_json',
      path: inputPath,
      bytes: bytes.length,
      sha256: sourceHash
    }
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

run();
