// @ts-check
'use strict';

// #105: a resolve call that fails leaves the marker saying fixed/wontfix while
// the thread stays open on screen, and the merged status then reads as done —
// so nothing used to revisit it. These cover both halves of the fix: reconcile
// decides to retry (only when the platform flag says still open), and the
// action poster replays the resolve step alone, without a duplicate marker.

const test = require('node:test');
const assert = require('node:assert/strict');
const { reconcilePort } = require('../lib/reconcile.js');
const { postActionPlan } = require('../lib/action-poster.js');
const { fingerprint } = require('../lib/fingerprint.js');

const mkThread = (/** @type {any} */ o = {}) => ({
  id: 't1',
  status: 'fixed',
  filePath: 'src/a.js',
  line: 10,
  comments: [{ isBot: true, body: 'finding' }],
  marker: { fingerprint: fingerprint('src/a.js', 10, 'r1'), version: '1' },
  platformResolved: false,
  ...o,
});

const finding = (/** @type {any} */ o = {}) => ({
  filePath: 'src/a.js', line: 10, body: 'hardcoded secret', ruleId: 'security', ...o,
});

test('retries resolve: marker says fixed but platform still open', () => {
  const r = reconcilePort([mkThread()], []);
  assert.deepEqual(r.toResolve.map((t) => t.id), ['t1']);
});

test('retries resolve: marker says wontfix but platform still open', () => {
  const r = reconcilePort([mkThread({ status: 'wontfix' })], []);
  assert.deepEqual(r.toResolve.map((t) => t.id), ['t1']);
});

test('no extra call: thread already resolved on the platform', () => {
  const r = reconcilePort([mkThread({ platformResolved: true })], []);
  assert.deepEqual(r.toResolve, []);
});

test('no retry for an active thread (nothing failed — it was never resolved)', () => {
  const r = reconcilePort([mkThread({ status: 'active', platformResolved: false })], []);
  assert.deepEqual(r.toResolve, []);
});

test('no retry when the provider reports no platform flag (unknown, not open)', () => {
  const t = mkThread();
  delete /** @type {any} */ (t).platformResolved;
  const r = reconcilePort([/** @type {any} */ (t)], []);
  assert.deepEqual(r.toResolve, []);
});

test('a thread being reopened this run is not also resolved', () => {
  const fp = fingerprint('src/a.js', 10, 'r1');
  const r = reconcilePort([mkThread({ marker: { fingerprint: fp, version: '1' } })], [{
    filePath: 'src/a.js', line: 10, body: 'x', ruleId: 'r1',
  }]);
  assert.deepEqual(r.toReopen.map((x) => x.thread.id), ['t1']);
  assert.deepEqual(r.toResolve, [], 'reopen wins over resolve retry');
});

test('a fuzzy-matched dismissed thread lands in both toReply and toResolve', () => {
  // Overlap is real (a drifted fingerprint routes a dismissed, still-open
  // thread into both buckets) and intentional: the review path's reply is a
  // bare replyToThread with no status opt, so it cannot contradict the
  // resolve. See the comment above the filter.
  const fp = fingerprint('src/a.js', 10, 'security');
  const t = mkThread({
    line: 10,
    comments: [
      { isBot: true, body: '**[HIGH/security]** hardcoded token in config file' },
      { isBot: false, body: 'why is this a problem?' },
    ],
    marker: { fingerprint: fp, version: '1' },
  });
  const r = reconcilePort([t], [{
    filePath: 'src/a.js', line: 14, body: 'hardcoded token in config file', ruleId: 'security',
  }]);
  assert.deepEqual(r.toReply.map((x) => x.thread.id), ['t1']);
  assert.deepEqual(r.toResolve.map((x) => x.id), ['t1'], 'overlap is allowed');
});

test('the reply posted for an overlapping thread carries no status marker', async () => {
  /** @type {any[][]} */
  const calls = [];
  const provider = {
    replyToThread: async (/** @type {string} */ id, /** @type {string} */ _body, /** @type {any} */ opts) => {
      calls.push(['reply', id, opts]);
    },
    patchThreadStatus: async (/** @type {string} */ id, /** @type {string} */ status, /** @type {any} */ opts) => {
      calls.push(['patch', id, status, opts]);
    },
  };
  await postActionPlan({
    toReply: [{ thread: { id: 't1' }, finding: finding() }],
    toResolve: [{ id: 't1', status: 'fixed', filePath: 'src/a.js', line: 10 }],
  }, provider);
  const reply = calls.find((c) => c[0] === 'reply');
  assert.equal(reply[2], undefined, 'no opts means no marker, so no contradiction with the resolve');
  assert.deepEqual(calls.filter((c) => c[0] === 'patch'), [
    ['patch', 't1', 'fixed', { skipMarkerReply: true }],
  ], 'resolve runs exactly once');
});

test('poster resolves the stuck thread without reposting the marker', async () => {
  /** @type {any[][]} */
  const calls = [];
  const provider = {
    replyToThread: async (/** @type {string} */ id) => { calls.push(['reply', id]); },
    patchThreadStatus: async (/** @type {string} */ id, /** @type {string} */ status, /** @type {any} */ opts) => {
      calls.push(['patch', id, status, opts]);
    },
  };
  const out = await postActionPlan({
    toResolve: [{ id: 't1', status: 'fixed', filePath: 'src/a.js', line: 10 }],
  }, provider);
  assert.deepEqual(calls, [['patch', 't1', 'fixed', { skipMarkerReply: true }]]);
  assert.equal(out.retried, 1);
  assert.equal(out.failures, 0);
});

test('a retried resolve that still fails counts as a failure (exit 6)', async () => {
  const provider = {
    patchThreadStatus: async () => { throw new Error('500 boom'); },
  };
  const out = await postActionPlan({
    toResolve: [{ id: 't1', status: 'fixed', filePath: 'src/a.js', line: 10 }],
  }, provider);
  assert.equal(out.retried, 1);
  assert.equal(out.failures, 1);
});