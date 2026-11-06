'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolvePr } = require('../lib/resolve-pr.js');

test('resolvePr: override wins over env and ref', () => {
  const env = { GITHUB_PR_NUMBER: '99', GITHUB_REF: 'refs/pull/77/head' };
  assert.equal(resolvePr(env, { override: '42' }), 42);
});

test('resolvePr: GITHUB_PR_NUMBER wins when override blank', () => {
  const env = { GITHUB_PR_NUMBER: '99', GITHUB_REF: 'refs/pull/77/head' };
  assert.equal(resolvePr(env, { override: '' }), 99);
});

test('resolvePr: parses GITHUB_REF when env+override absent', () => {
  const env = { GITHUB_REF: 'refs/pull/123/head' };
  assert.equal(resolvePr(env, {}), 123);
});

test('resolvePr: reads GITHUB_EVENT_PATH JSON last', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpr-'));
  const evtPath = path.join(tmp, 'event.json');
  fs.writeFileSync(evtPath, JSON.stringify({ pull_request: { number: 555 } }));
  const env = { GITHUB_EVENT_PATH: evtPath };
  assert.equal(resolvePr(env, {}), 555);
});

test('resolvePr: reads issue.number from event JSON for issue_comment trigger', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpr-'));
  const evtPath = path.join(tmp, 'event.json');
  fs.writeFileSync(evtPath, JSON.stringify({ issue: { number: 777 } }));
  assert.equal(resolvePr({ GITHUB_EVENT_PATH: evtPath }, {}), 777);
});

test('resolvePr: returns null when no source provides a number', () => {
  assert.equal(resolvePr({}, {}), null);
});

test('resolvePr: returns null when GITHUB_REF is non-PR ref', () => {
  assert.equal(resolvePr({ GITHUB_REF: 'refs/heads/main' }, {}), null);
});

test('resolvePr: returns null on malformed event JSON', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpr-'));
  const evtPath = path.join(tmp, 'event.json');
  fs.writeFileSync(evtPath, 'not json');
  assert.equal(resolvePr({ GITHUB_EVENT_PATH: evtPath }, {}), null);
});

test('resolvePr: returns null when event JSON has non-numeric number field', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpr-'));
  const evtPath = path.join(tmp, 'event.json');
  fs.writeFileSync(evtPath, JSON.stringify({ pull_request: { number: 'abc' } }));
  assert.equal(resolvePr({ GITHUB_EVENT_PATH: evtPath }, {}), null);
});
