// @ts-check
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { computeStrictDecision } = require('../lib/port/strict-port.js');

const f = (severity, ruleId = 'r:r:abc', filePath = 'a.js', line = 1) =>
  ({ filePath, line, severity, ruleId });

describe('computeStrictDecision', () => {
  it('returns disabled snapshot when enabled=false', () => {
    const r = computeStrictDecision({
      enabled: false, threshold: 'medium',
      toPost: [f('critical')], toReopen: [],
    });
    assert.deepEqual(r, { enabled: false, threshold: 'medium', triggered: false, blockingCount: 0, blockingFindings: [] });
  });

  it('triggers on critical when threshold=medium', () => {
    const r = computeStrictDecision({
      enabled: true, threshold: 'medium',
      toPost: [f('critical')], toReopen: [],
    });
    assert.equal(r.triggered, true);
    assert.equal(r.blockingCount, 1);
    assert.equal(r.blockingFindings[0].severity, 'critical');
  });

  it('does NOT trigger on low when threshold=medium', () => {
    const r = computeStrictDecision({
      enabled: true, threshold: 'medium',
      toPost: [f('low')], toReopen: [],
    });
    assert.equal(r.triggered, false);
    assert.equal(r.blockingCount, 0);
  });

  it('counts toPost AND toReopen', () => {
    const r = computeStrictDecision({
      enabled: true, threshold: 'high',
      toPost: [f('critical')],
      toReopen: [{ finding: f('high') }, { finding: f('medium') }],
    });
    assert.equal(r.blockingCount, 2);
  });

  it('treats unknown severity as below low (no block)', () => {
    const r = computeStrictDecision({
      enabled: true, threshold: 'low',
      toPost: [f('UNKNOWN'), f(null)], toReopen: [],
    });
    assert.equal(r.triggered, false);
  });

  it('threshold=low blocks medium/high/critical', () => {
    const r = computeStrictDecision({
      enabled: true, threshold: 'low',
      toPost: [f('low'), f('medium'), f('high'), f('critical')], toReopen: [],
    });
    assert.equal(r.blockingCount, 4);
  });
});

// Threads the bot raised earlier and that are still open (issue
// strict-gate-persistent/01): a blocking finding keeps the gate red until it is
// fixed or argued to wontfix, not just on the run that first posted it.
const { carriedBlockers } = require('../lib/port/strict-port.js');

/** @param {Partial<{ id: string, status: string, severity: string, isBot: boolean, fp: string|null, body: string }>} o */
const thread = ({ id = 't1', status = 'active', severity = 'HIGH', isBot = true, fp = 'abc', body } = {}) => ({
  id, status, filePath: 'a.js', line: 3,
  comments: [{ isBot, body: body ?? `[Owlet Lens] **[${severity}/bug]** something` }],
  marker: { fingerprint: fp, version: 'v1' },
});

describe('carriedBlockers', () => {
  const run = (/** @type {any[]} */ threads, /** @type {any} */ opts = {}) => {
    const warned = /** @type {string[]} */ ([]);
    const out = carriedBlockers({
      threads, threshold: 'medium', excludeIds: new Set(), log: (_l, msg) => warned.push(msg), ...opts,
    });
    return { out, warned };
  };

  it('keeps an open bot thread at or above the threshold', () => {
    assert.deepEqual(run([thread()]).out, [{ filePath: 'a.js', line: 3, severity: 'HIGH', ruleId: '', carried: true }]);
  });

  it('a thread fixed or argued to wontfix no longer blocks', () => {
    assert.deepEqual(run([thread({ status: 'fixed' }), thread({ status: 'wontfix' })]).out, []);
  });

  it('below the threshold does not block', () => {
    assert.deepEqual(run([thread({ severity: 'LOW' })]).out, []);
  });

  it('ignores human threads and bot comments without a finding fingerprint', () => {
    assert.deepEqual(run([thread({ isBot: false }), thread({ fp: null })]).out, []);
  });

  it('skips threads this run is already closing or reopening', () => {
    assert.deepEqual(run([thread({ id: 'gone' })], { excludeIds: new Set(['gone']) }).out, []);
  });

  it('an unreadable severity does not block, and is logged', () => {
    const { out, warned } = run([thread({ body: 'hand-edited, no severity tag' })]);
    assert.deepEqual(out, []);
    assert.deepEqual(warned, ['strict.carried.severity.unknown']);
  });
});

describe('computeStrictDecision with carried blockers', () => {
  it('a carried blocker alone triggers, flagged as carried', () => {
    const r = computeStrictDecision({
      enabled: true, threshold: 'medium', toPost: [], toReopen: [],
      carried: [{ filePath: 'a.js', line: 3, severity: 'HIGH', ruleId: '', carried: true }],
    });
    assert.equal(r.triggered, true);
    assert.equal(r.blockingCount, 1);
    assert.equal(r.blockingFindings[0].carried, true);
  });

  it('carried blockers are ignored when strict is off', () => {
    const r = computeStrictDecision({
      enabled: false, threshold: 'medium', toPost: [], toReopen: [],
      carried: [{ filePath: 'a.js', line: 3, severity: 'HIGH', ruleId: '', carried: true }],
    });
    assert.equal(r.triggered, false);
  });
});
