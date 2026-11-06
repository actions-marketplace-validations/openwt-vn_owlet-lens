// @ts-check
'use strict';

// Action poster unit tests: the four-batch provider writes behind one
// interface, with a fake provider (no LLM, no network).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { postActionPlan, logActionFailure, WRITE_CONCURRENCY } = require('../lib/action-poster.js');
const { CONFIG } = require('../lib/config.js');
const { fingerprint } = require('../lib/fingerprint.js');
const { ProviderError } = require('../lib/errors.js');

function finding(overrides = {}) {
  return {
    filePath: 'src/a.js', line: 3, severity: 'HIGH', category: 'security',
    body: 'hardcoded secret', ruleId: 'r1', ...overrides,
  };
}

describe('postActionPlan', () => {
  it('returns zero counts and touches nothing for an empty plan', async () => {
    let called = 0;
    const provider = {
      postThreadsBatch: async () => { called += 1; return []; },
      replyToThread: async () => { called += 1; },
      patchThreadStatus: async () => { called += 1; },
    };
    const out = await postActionPlan({}, provider);
    assert.deepEqual(out, { posted: 0, replied: 0, reopened: 0, closed: 0, retried: 0, failures: 0 });
    assert.equal(called, 0);
  });

  it('posts toPost through the postThreadsBatch fast-path with formatted bodies', async () => {
    const seen = [];
    const provider = {
      postThreadsBatch: async (threads) => {
        seen.push(...threads);
        return threads.map((_, i) => ({ ok: true, value: { id: `T${i}` } }));
      },
    };
    const out = await postActionPlan(
      { toPost: [finding()] },
      provider,
      { formatBody: (f) => `BODY:${f.body}` },
    );
    assert.deepEqual(seen, [{
      filePath: 'src/a.js', line: 3, body: 'BODY:hardcoded secret',
      status: 'active', ruleId: 'r1',
    }]);
    assert.equal(out.posted, 1);
    assert.equal(out.failures, 0);
  });

  it('falls back to per-thread postThread when the provider lacks postThreadsBatch', async () => {
    const seen = [];
    const provider = {
      postThread: async (t) => { seen.push(t); return { threadId: 'T1' }; },
    };
    const out = await postActionPlan({ toPost: [finding({ ruleId: undefined })] }, provider);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].ruleId, '');
    assert.equal(out.posted, 1);
    assert.equal(out.failures, 0);
  });

  it('counts each failed post and reports it through onFailure', async () => {
    const failures = [];
    const provider = {
      postThreadsBatch: async (threads) => threads.map(() => ({ ok: false, error: new Error('422') })),
    };
    const out = await postActionPlan(
      { toPost: [finding(), finding({ line: 9 })] },
      provider,
      { onFailure: (msg, e, ctx) => failures.push({ msg, error: e.message, ctx }) },
    );
    assert.equal(out.posted, 2);
    assert.equal(out.failures, 2);
    assert.equal(failures.length, 2);
    assert.equal(failures[0].msg, 'postThread failed');
    assert.equal(failures[0].ctx.filePath, 'src/a.js');
  });

  it('does not repeat a failed write: the provider owns retries (ADR-0013)', { timeout: 3000 }, async () => {
    let calls = 0;
    const provider = {
      replyToThread: async () => {
        calls += 1;
        throw new ProviderError('502 after the provider retried', { provider: 'fake', status: 502, retryable: true });
      },
    };
    const out = await postActionPlan(
      { toReply: [{ thread: { id: 'T9' }, finding: finding() }] },
      provider,
      { onFailure: () => {} },
    );
    assert.equal(calls, 1);
    assert.equal(out.failures, 1);
  });

  it('replies to threads with the finding body and null suggestion', async () => {
    const seen = [];
    const provider = { replyToThread: async (id, body) => { seen.push({ id, body }); } };
    const out = await postActionPlan({
      toReply: [{ thread: { id: 'T9' }, finding: finding({ suggestion: 'do x' }) }],
    }, provider, { formatBody: (f) => `B:${f.body}:${f.suggestion}` });
    assert.deepEqual(seen, [{ id: 'T9', body: 'B:hardcoded secret:null' }]);
    assert.equal(out.replied, 1);
    assert.equal(out.failures, 0);
  });

  it('reopens by replying with a regression marker then flipping status, serially', async () => {
    const calls = [];
    const provider = {
      replyToThread: async (id, body, opts) => { calls.push(['reply', id, body, opts]); },
      patchThreadStatus: async (id, status, opts) => { calls.push(['patch', id, status, opts]); },
    };
    const f = finding({ ruleId: 'r1' });
    const out = await postActionPlan({ toReopen: [{ thread: { id: 'T2' }, finding: f }] }, provider);
    const fp = fingerprint('src/a.js', 3, 'r1');
    assert.equal(calls.length, 2);
    assert.equal(calls[0][0], 'reply');
    assert.equal(calls[0][1], 'T2');
    assert.match(calls[0][2], /^\*\*\[REGRESSION\]\*\* /);
    assert.deepEqual(calls[0][3], { status: 'active', fingerprintHash: fp });
    assert.deepEqual(calls[1], ['patch', 'T2', 'active', { skipMarkerReply: true }]);
    assert.equal(out.reopened, 1);
    assert.equal(out.failures, 0);
  });

  it('closes threads by patching them to fixed', async () => {
    const seen = [];
    const provider = { patchThreadStatus: async (id, status) => { seen.push([id, status]); } };
    const out = await postActionPlan({
      toClose: [{ id: 'T3', filePath: 'src/a.js', line: 3 }],
    }, provider);
    assert.deepEqual(seen, [['T3', 'fixed']]);
    assert.equal(out.closed, 1);
  });

  it('uses the default formatter with the provider name when none is injected', async () => {
    const seen = [];
    const provider = { postThread: async (t) => { seen.push(t.body); } };
    await postActionPlan({ toPost: [finding()] }, provider, { providerName: 'github' });
    assert.match(seen[0], new RegExp(`^${CONFIG.aiReviewPrefix.replace(/[[\]]/g, '\\$&')} \\*\\*\\[HIGH/security\\]\\*\\* `));
  });

  it('omitting providerName is neutral: no GitHub-only suggestion fence is injected', async () => {
    const seen = [];
    const provider = { postThread: async (t) => { seen.push(t.body); } };
    await postActionPlan({ toPost: [finding({ suggestion: 'const x = 1;' })] }, provider);
    assert.ok(!seen[0].includes('```suggestion'), 'suggestion fence must not be added without an explicit github provider name');
  });

  it('exports the shared write concurrency constant', () => {
    assert.equal(WRITE_CONCURRENCY, 4);
  });
});

describe('logActionFailure', () => {
  it('writes a structured stderr line including commentDbId when present', () => {
    const lines = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => { lines.push(String(chunk)); return true; };
    try {
      const e = new Error('boom');
      e.name = 'OrphanCommentError';
      e.status = 500;
      e.commentDbId = 123;
      logActionFailure('postThread failed', e, { filePath: 'src/a.js' });
    } finally {
      process.stderr.write = orig;
    }
    const rec = JSON.parse(lines[0]);
    assert.equal(rec.level, 'error');
    assert.equal(rec.msg, 'postThread failed');
    assert.equal(rec.filePath, 'src/a.js');
    assert.equal(rec.commentDbId, 123);
    assert.equal(rec.errName, 'OrphanCommentError');
    assert.equal(rec.errStatus, 500);
  });
});
