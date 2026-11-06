// @ts-check
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { reconcilePort } = require('../lib/reconcile.js');
const { fingerprint } = require('../lib/fingerprint.js');

const mkThread = (overrides) => ({
  id: 't1', status: 'active', filePath: 'src/a.js', line: 10,
  comments: [{ isBot: true, body: 'finding' }],
  marker: { fingerprint: null, version: '1' },
  ...overrides,
});

test('toPost: new finding with no matching thread', () => {
  const r = reconcilePort([], [{
    filePath: 'src/a.js', line: 10, body: 'x', ruleId: 'r1',
  }]);
  assert.equal(r.toPost.length, 1);
  assert.equal(r.toReply.length, 0);
  assert.equal(r.toReopen.length, 0);
  assert.equal(r.toClose.length, 0);
});

test('skips reply when bot already has last word on active thread', () => {
  const fp = fingerprint('src/a.js', 10, 'r1');
  const existing = [mkThread({ marker: { fingerprint: fp, version: '1' } })];
  const r = reconcilePort(existing, [{
    filePath: 'src/a.js', line: 10, body: 'x', ruleId: 'r1',
  }]);
  assert.equal(r.toReply.length, 0, 'no reply when bot has last word');
  assert.equal(r.toPost.length, 0, 'not re-posted');
  assert.equal(r.toClose.length, 0, 'thread still claimed');
});

test('toReply: active thread where human replied since last bot comment', () => {
  const fp = fingerprint('src/a.js', 10, 'r1');
  const existing = [mkThread({
    comments: [
      { isBot: true, body: 'finding' },
      { isBot: false, body: 'can you explain more?' },
    ],
    marker: { fingerprint: fp, version: '1' },
  })];
  const r = reconcilePort(existing, [{
    filePath: 'src/a.js', line: 10, body: 'x', ruleId: 'r1',
  }]);
  assert.equal(r.toReply.length, 1, 'replies when human spoke last');
  assert.equal(r.toPost.length, 0);
});

test('toReopen: matching closed thread', () => {
  const fp = fingerprint('src/a.js', 10, 'r1');
  const existing = [mkThread({
    status: 'fixed', marker: { fingerprint: fp, version: '1' },
  })];
  const r = reconcilePort(existing, [{
    filePath: 'src/a.js', line: 10, body: 'x', ruleId: 'r1',
  }]);
  assert.equal(r.toReopen.length, 1);
});

test('toClose: bot-authored active thread no longer in findings', () => {
  const fp = fingerprint('src/a.js', 10, 'r1');
  const existing = [mkThread({ marker: { fingerprint: fp, version: '1' } })];
  const r = reconcilePort(existing, []);
  assert.equal(r.toClose.length, 1);
});

test('toClose skips human-authored thread even with marker fingerprint', () => {
  const fp = fingerprint('src/a.js', 10, 'r1');
  const existing = [mkThread({
    comments: [{ isBot: false, body: 'looks like spam marker' }],
    marker: { fingerprint: fp, version: '1' },
  })];
  const r = reconcilePort(existing, []);
  assert.equal(r.toClose.length, 0);
});

test('toClose skips thread without marker.version', () => {
  const fp = fingerprint('src/a.js', 10, 'r1');
  const existing = [mkThread({ marker: { fingerprint: fp, version: null } })];
  const r = reconcilePort(existing, []);
  assert.equal(r.toClose.length, 0);
});

test('toClose requires diff evidence when changedFiles provided: closes when line in change set', () => {
  const fp = fingerprint('src/a.js', 10, 'r1');
  const existing = [mkThread({ marker: { fingerprint: fp, version: '1' } })];
  const changedFiles = new Map([['src/a.js', new Set([10])]]);
  const r = reconcilePort(existing, [], { changedFiles });
  assert.equal(r.toClose.length, 1);
});

test('toClose requires diff evidence: skip when file changed but thread line untouched', () => {
  const fp = fingerprint('src/a.js', 67, 'r1');
  const existing = [mkThread({
    line: 67, marker: { fingerprint: fp, version: '1' },
  })];
  const changedFiles = new Map([['src/a.js', new Set([5, 6, 12])]]);
  const r = reconcilePort(existing, [], { changedFiles });
  assert.equal(r.toClose.length, 0);
});

test('toClose requires diff evidence: skip when file absent from diff', () => {
  const fp = fingerprint('src/a.js', 10, 'r1');
  const existing = [mkThread({ marker: { fingerprint: fp, version: '1' } })];
  const changedFiles = new Map([['src/b.js', new Set([10])]]);
  const r = reconcilePort(existing, [], { changedFiles });
  assert.equal(r.toClose.length, 0);
});

test('toClose backward-compat: omitting changedFiles preserves prior behavior', () => {
  const fp = fingerprint('src/a.js', 10, 'r1');
  const existing = [mkThread({ marker: { fingerprint: fp, version: '1' } })];
  const r = reconcilePort(existing, []);
  assert.equal(r.toClose.length, 1);
});

test('toClose skips thread whose last comment is a dev reply the bot has not answered', () => {
  const fp = fingerprint('src/a.js', 10, 'r1');
  const existing = [mkThread({
    comments: [
      { isBot: true, body: 'finding' },
      { isBot: false, body: 'I disagree — this is intentional' },
    ],
    marker: { fingerprint: fp, version: '1' },
  })];
  const r = reconcilePort(existing, []);
  assert.equal(r.toClose.length, 0);
});

test('toClose still closes when bot has answered after the dev reply', () => {
  const fp = fingerprint('src/a.js', 10, 'r1');
  const existing = [mkThread({
    comments: [
      { isBot: true, body: 'finding' },
      { isBot: false, body: 'I disagree' },
      { isBot: true, body: 'acknowledged' },
    ],
    marker: { fingerprint: fp, version: '1' },
  })];
  const r = reconcilePort(existing, []);
  assert.equal(r.toClose.length, 1);
});

test('suppressClose prevents closing cap-evicted threads', () => {
  const fp = fingerprint('src/a.js', 10, 'r1');
  const existing = [mkThread({
    marker: { fingerprint: fp, version: '1' },
  })];
  const suppressClose = new Set([fp]);
  const r = reconcilePort(existing, [], { suppressClose });
  assert.equal(r.toClose.length, 0);
});
