'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.join(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

test('Platform overview is one read-only command center over existing truth', () => {
  const home = read('src/views/platform.ejs');
  for (const surface of [
    'overview-system-state',
    'overview-attention',
    'overview-active-work',
    'overview-modules',
    'overview-evidence',
    'value-ribbon'
  ]) {
    assert.match(home, new RegExp(`data-testid="${surface}"`));
  }
  assert.match(home, /commandCenter\.valueRibbon\.fields/);
  const projection = `${read('src/platformCommandCenter.js')}\n${read('src/missionValue.js')}`;
  for (const field of [
    'Objective',
    'Acceptance coverage',
    'Time to verified outcome',
    'Timeliness',
    'Human attention',
    'Cost',
    'Risk',
    'Evidence coverage',
    'Verification state',
    'Verified value state'
  ]) {
    assert.match(projection, new RegExp(field));
  }
  for (const forbidden of ['<form', '<button', 'accept-all', 'createBatch', 'Coming soon']) {
    assert.doesNotMatch(home, new RegExp(forbidden, 'i'));
  }
});

test('AutoPoster is the only customer module and owns the canonical namespace', () => {
  const platformModules = require('../src/platformModules');
  const customerModules = platformModules.listCustomerModules();
  assert.deepEqual(customerModules.map((module) => module.id), ['autoposter']);
  assert.equal(customerModules[0].href, '/platform/autoposter');
  assert.equal(platformModules.getModule('publishing-queue').id, 'autoposter');
});

test('module navigation stays entirely inside the AutoPoster namespace', () => {
  const nav = read('src/views/_platform-nav.ejs');
  for (const pathName of ['compose', 'queue', 'accounts', 'activity']) {
    assert.match(nav, new RegExp(`href: '/platform/autoposter/${pathName}'`));
  }
  assert.doesNotMatch(nav, /href:\s*'\/private\/autoposter/);
  assert.match(nav, /<span class="product">Platform<\/span>/);
  assert.match(nav, /<span class="module-context">AutoPoster<\/span>/);
});

test('canonical module routes render and saved customer routes only redirect forward', () => {
  const platformRoutes = read('src/platformRoutes.js');
  const classicRoutes = read('src/routes.js');
  for (const route of ['compose', 'queue', 'activity']) {
    assert.match(platformRoutes, new RegExp(`router\\.get\\('/platform/autoposter/${route}'`));
  }
  assert.match(classicRoutes, /router\.get\('\/platform\/autoposter\/accounts', requireAdminPage, renderAutoPoster\)/);
  assert.match(platformRoutes, /router\.get\('\/platform\/compose'[\s\S]*?res\.redirect\(302, '\/platform\/autoposter\/compose'\)/);
  assert.match(classicRoutes, /router\.get\('\/private\/autoposter\/accounts'[\s\S]*?res\.redirect\(302, '\/platform\/autoposter\/accounts'\)/);
  assert.match(classicRoutes, /router\.get\('\/private\/autoposter'[\s\S]*?res\.redirect\(302, `\/platform\/autoposter\/compose\$\{query\}`\)/);
});

test('clean Composer and Accounts surfaces use canonical module destinations', () => {
  const composer = read('src/views/platform-compose.ejs');
  const accounts = read('src/views/platform-accounts.ejs');
  assert.match(composer, /id="compose-form"/);
  assert.match(composer, /href="\/platform\/autoposter\/queue">View Queue<\/a>/);
  assert.doesNotMatch(composer, /href="\/private\/autoposter/);
  assert.match(accounts, /Current Account/);
  assert.match(accounts, /href="\/platform\/autoposter\/compose">Done<\/a>/);
  assert.match(accounts, /name="returnTo" value="\/platform\/autoposter\/accounts"/);
});

test('evidence filtering has an explicit rendered hidden state', () => {
  const evidence = read('src/views/platform-evidence.ejs');
  const css = read('public/platform/platform.css');
  assert.match(evidence, /row\.hidden = !matches/);
  assert.match(css, /\.evidence-ledger-row\[hidden\][\s\S]*display:\s*none/);
});
