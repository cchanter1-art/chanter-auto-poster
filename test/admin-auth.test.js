'use strict';

process.env.ADMIN_PASSWORD = 'test-admin-password-123';
process.env.ADMIN_SESSION_HOURS = '12';

const assert = require('node:assert/strict');
const test = require('node:test');
const config = require('../src/config');
const {
  createAdminSessionToken,
  safeReturnTo,
  validateAdminConfig,
  verifyAdminPassword,
  verifyAdminSessionToken
} = require('../src/auth');

test('creates signed expiring admin sessions and rejects tampering', () => {
  assert.equal(validateAdminConfig(), true);
  assert.equal(verifyAdminPassword('test-admin-password-123'), true);
  assert.equal(verifyAdminPassword('wrong-password'), false);

  const now = Date.now();
  const token = createAdminSessionToken(now);
  const session = verifyAdminSessionToken(token, now + 1000);
  assert.equal(session.role, 'admin');
  assert.equal(session.sub, config.defaultUserId);

  const tampered = `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`;
  assert.equal(verifyAdminSessionToken(tampered, now + 1000), null);
  assert.equal(verifyAdminSessionToken(token, session.exp + 1), null);
});

test('only permits local Platform and explicitly internal return paths', () => {
  assert.equal(safeReturnTo('/private/autoposter/dashboard'), '/private/autoposter/dashboard');
  assert.equal(safeReturnTo('/private/autoposter/legacy'), '/private/autoposter/legacy');
  assert.equal(safeReturnTo('/platform/autoposter/accounts'), '/platform/autoposter/accounts');
  assert.equal(safeReturnTo('/private/autoposter/accounts'), '/platform');
  assert.equal(safeReturnTo('https://attacker.example'), '/platform');
  assert.equal(safeReturnTo('//attacker.example'), '/platform');
});

test('refuses to validate an unset or weak admin password', () => {
  const original = config.adminPassword;
  config.adminPassword = '';
  assert.throws(() => validateAdminConfig(), /ADMIN_PASSWORD is required/);
  config.adminPassword = 'short';
  assert.throws(() => validateAdminConfig(), /at least 12 characters/);
  config.adminPassword = original;
});
