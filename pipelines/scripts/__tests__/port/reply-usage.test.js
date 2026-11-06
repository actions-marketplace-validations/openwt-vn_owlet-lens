// @ts-check
'use strict';

// Reply spend accounting (issue #89): per-verdict results fold into one usage,
// and that usage names the model that answered — not config.reply.model — in
// the state invocation, the audit entry and the stdout result.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  emptyReplyUsage, addVerdictUsage, summarizeReplyUsage, recordReplyRun,
} = require('../../lib/port/reply-usage.js');

const COUNTS = { processed: 2, evalFailures: 0, writeFailures: 0 };

function fakeLife() {
  const calls = { state: [], audit: [] };
  return {
    calls,
    appendState: (arg) => { calls.state.push(arg); },
    writeAudit: (arg) => { calls.audit.push(arg); },
  };
}

describe('addVerdictUsage', () => {
  it('accumulates cost and tokens over every verdict call', () => {
    const usage = emptyReplyUsage();
    addVerdictUsage(usage, { costUsd: 0.001, inputTokens: 100, outputTokens: 20, model: 'm1' });
    addVerdictUsage(usage, { costUsd: 0.002, inputTokens: 50, outputTokens: 5, model: 'm2' });
    assert.equal(usage.costUsd, 0.003);
    assert.equal(usage.inputTokens, 150);
    assert.equal(usage.outputTokens, 25);
    assert.deepEqual(usage.models, ['m1', 'm2']);
  });

  it('keeps each answering model once, in first-answer order', () => {
    const usage = emptyReplyUsage();
    for (const model of ['primary', 'fallback', 'primary', 'fallback']) {
      addVerdictUsage(usage, { costUsd: 0.001, model });
    }
    assert.deepEqual(usage.models, ['primary', 'fallback']);
  });

  it('ignores a missing or blank model and a non-finite cost', () => {
    const usage = emptyReplyUsage();
    addVerdictUsage(usage, { costUsd: Number.NaN, model: '   ' });
    addVerdictUsage(usage, { model: null });
    assert.equal(usage.costUsd, 0);
    assert.deepEqual(usage.models, []);
  });
});

describe('summarizeReplyUsage', () => {
  it('lists every model that answered, comma-joined', () => {
    const usage = emptyReplyUsage();
    addVerdictUsage(usage, { costUsd: 0.001, inputTokens: 10, outputTokens: 2, model: 'primary' });
    addVerdictUsage(usage, { costUsd: 0.002, inputTokens: 20, outputTokens: 3, model: 'fallback' });
    const report = summarizeReplyUsage(usage, {
      configuredModel: 'configured', provider: 'github', dryRun: false, counts: COUNTS,
    });
    assert.equal(report.model, 'primary,fallback');
    assert.equal(report.costUsd, 0.003);
    assert.equal(report.inputTokens, 30);
    assert.equal(report.outputTokens, 5);
    assert.equal(report.invocation.type, 'reply');
    assert.equal(report.invocation.model, 'primary,fallback');
    assert.equal(report.invocation.costUsd, 0.003);
    assert.match(report.invocation.ts, /^\d{4}-\d{2}-\d{2}T/);
  });

  it('falls back to the configured model when no verdict reported one', () => {
    const report = summarizeReplyUsage(emptyReplyUsage(), {
      configuredModel: 'configured', provider: 'github', dryRun: false, counts: COUNTS,
    });
    assert.equal(report.model, 'configured');
    assert.equal(report.costUsd, 0);
  });

  it('reports wouldReply instead of post counts on a dry run', () => {
    const usage = emptyReplyUsage();
    addVerdictUsage(usage, { costUsd: 0.001, model: 'm' });
    const report = summarizeReplyUsage(usage, {
      configuredModel: 'configured', provider: 'github', dryRun: true,
      counts: COUNTS, wouldReply: [{ threadId: 'T1', verdict: 'fixed' }],
    });
    assert.equal(report.result.dryRun, true);
    assert.deepEqual(report.result.wouldReply, [{ threadId: 'T1', verdict: 'fixed' }]);
    assert.equal(report.result.model, 'm');
  });

  it('omits dry-run keys when the run actually posted', () => {
    const report = summarizeReplyUsage(emptyReplyUsage(), {
      configuredModel: 'configured', provider: 'github', dryRun: false, counts: COUNTS,
    });
    assert.equal(report.result.dryRun, undefined);
    assert.equal(report.result.wouldReply, undefined);
    assert.equal(report.result.processed, 2);
    assert.equal(report.result.provider, 'github');
  });
});

describe('recordReplyRun', () => {
  const report = summarizeReplyUsage(emptyReplyUsage(), {
    configuredModel: 'configured', provider: 'github', dryRun: false, counts: COUNTS,
  });
  const keys = {
    prNumber: 7, prId: '42', repo: 'o/r', auditPath: '/tmp/audit.jsonl',
    dryRun: false, processed: 1, report,
  };

  it('records the answering model in both the state invocation and the audit entry', () => {
    const life = fakeLife();
    recordReplyRun(life, keys);
    assert.equal(life.calls.state.length, 1);
    assert.equal(life.calls.state[0].enabled, true);
    assert.equal(life.calls.state[0].prNumber, 7);
    assert.equal(life.calls.state[0].invocation.model, 'configured');
    assert.equal(life.calls.audit.length, 1);
    const entry = life.calls.audit[0].entry;
    assert.equal(entry.event, 'reply');
    assert.equal(entry.prId, '42');
    assert.equal(entry.model, 'configured');
    assert.equal(life.calls.audit[0].repo, 'o/r');
    assert.equal(life.calls.audit[0].path, '/tmp/audit.jsonl');
  });

  it('skips both records on a dry run', () => {
    const life = fakeLife();
    recordReplyRun(life, { ...keys, dryRun: true });
    assert.equal(life.calls.state[0].enabled, false);
    assert.equal(life.calls.audit[0].enabled, false);
  });

  it('leaves the state ledger off a run that neither answered nor spent', () => {
    const life = fakeLife();
    recordReplyRun(life, { ...keys, processed: 0 });
    assert.equal(life.calls.state[0].enabled, false);
    assert.equal(life.calls.audit[0].enabled, true, 'the audit line still records the run');
  });
});
