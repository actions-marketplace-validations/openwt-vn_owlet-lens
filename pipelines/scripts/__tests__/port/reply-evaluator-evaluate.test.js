// @ts-check
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Stub retry BEFORE requiring reply-evaluator so withRetry doesn't slow tests.
const retryPath = require.resolve('../../lib/retry.js');
require.cache[retryPath] = {
  id: retryPath,
  filename: retryPath,
  loaded: true,
  exports: { withRetry: async (fn) => fn() },
};

const { evaluate } = require('../../lib/port/reply-evaluator.js');
const { LLMError } = require('../../lib/errors.js');

const ctx = (callImpl, over = {}) => ({
  findingBody: 'F',
  devReply: 'R',
  llmProvider: { call: callImpl },
  model: 'claude-haiku-4-5-20251001',
  ...over,
});

// ---------------------------------------------------------------------------
// evaluate() — success paths
// ---------------------------------------------------------------------------

test('evaluate returns parsed verdict on success', async () => {
  const call = async () => ({ text: '{"verdict":"fixed","reasoning":"committed"}' });
  const r = await evaluate(ctx(call));
  assert.equal(r.verdict, 'fixed');
  assert.equal(r.reasoning, 'committed');
});

test('evaluate truncates reasoning at 500 chars', async () => {
  const long = 'a'.repeat(800);
  const call = async () => ({ text: `{"verdict":"active","reasoning":"${long}"}` });
  const r = await evaluate(ctx(call));
  assert.equal(r.reasoning.length, 500);
});

test('evaluate coerces non-string reasoning to empty string', async () => {
  const call = async () => ({ text: '{"verdict":"fixed","reasoning":null}' });
  const r = await evaluate(ctx(call));
  assert.equal(r.reasoning, '');
});

// ---------------------------------------------------------------------------
// evaluate() — error paths
// ---------------------------------------------------------------------------

test('evaluate throws LLMError when llmProvider.call rejects', async () => {
  const call = async () => {
    const e = new Error('429');
    // @ts-ignore
    e.status = 429;
    throw e;
  };
  await assert.rejects(() => evaluate(ctx(call)), LLMError);
});

test('evaluate falls back to active (no throw) when no JSON in response', async () => {
  const call = async () => ({ text: 'plain prose, no braces here' });
  const r = await evaluate(ctx(call));
  assert.equal(r.verdict, 'active');
  assert.equal(r.costUsd, 0);
  // Fallback must flag itself so runReply skips the verdict marker and retries.
  assert.equal(r.unevaluated, true);
});

test('evaluate falls back to active on invalid verdict', async () => {
  const call = async () => ({ text: '{"verdict":"bogus","reasoning":"x"}' });
  const r = await evaluate(ctx(call));
  assert.equal(r.verdict, 'active');
  assert.equal(r.unevaluated, true);
});

test('evaluate does NOT flag unevaluated on a genuine active verdict', async () => {
  const call = async () => ({ text: '{"verdict":"active","reasoning":"dev asked a question"}' });
  const r = await evaluate(ctx(call));
  assert.equal(r.verdict, 'active');
  assert.equal(r.unevaluated, undefined);
});

test('evaluate falls back to active on null response', async () => {
  const call = async () => null;
  const r = await evaluate(ctx(call));
  assert.equal(r.verdict, 'active');
  assert.equal(r.costUsd, 0);
});

test('evaluate recovers a verdict object even with trailing prose', async () => {
  const call = async () => ({ text: 'Sure:\n```json\n{"verdict":"wontfix","reasoning":"intentional"}\n```\nDone.' });
  const r = await evaluate(ctx(call));
  assert.equal(r.verdict, 'wontfix');
  assert.equal(r.reasoning, 'intentional');
});

test('evaluate returns costUsd from llmProvider.call response', async () => {
  const fakeLlm = {
    call: async () => ({
      text: '{"verdict":"fixed","reasoning":"committed fix"}',
      usage: { inputTokens: 100, outputTokens: 20 },
      cost: { totalCost: 0.0042 },
    }),
  };
  const r = await evaluate({
    findingBody: 'orig',
    devReply: 'fixed it',
    llmProvider: fakeLlm,
  });
  assert.equal(r.verdict, 'fixed');
  assert.equal(r.costUsd, 0.0042);
});

test('evaluate returns costUsd=0 when llmProvider.call omits cost', async () => {
  const fakeLlm = {
    call: async () => ({
      text: '{"verdict":"wontfix","reasoning":"by design"}',
    }),
  };
  const r = await evaluate({
    findingBody: 'orig',
    devReply: 'nope',
    llmProvider: fakeLlm,
  });
  assert.equal(r.costUsd, 0);
});

// ---------------------------------------------------------------------------
// evaluate() — answering-model and token attribution (issue #89)
// ---------------------------------------------------------------------------

test('evaluate keeps the model that answered and its tokens under failover', async () => {
  // The wrapped provider fails over and reports the model that actually
  // answered — differ from the requested primary on purpose.
  const fakeLlm = {
    call: async () => ({
      text: '{"verdict":"fixed","reasoning":"committed fix"}',
      usage: { inputTokens: 100, outputTokens: 20 },
      cost: { totalCost: 0.0042 },
      model: 'fallback-reply-model',
    }),
  };
  const r = await evaluate({
    findingBody: 'orig',
    devReply: 'fixed it',
    llmProvider: fakeLlm,
    model: 'primary-reply-model',
  });
  assert.equal(r.verdict, 'fixed');
  assert.equal(r.model, 'fallback-reply-model');
  assert.equal(r.inputTokens, 100);
  assert.equal(r.outputTokens, 20);
});

test('evaluate falls back to the requested model when the response omits model', async () => {
  const fakeLlm = {
    call: async () => ({ text: '{"verdict":"wontfix","reasoning":"by design"}' }),
  };
  const r = await evaluate({
    findingBody: 'orig',
    devReply: 'nope',
    llmProvider: fakeLlm,
    model: 'requested-model',
  });
  assert.equal(r.model, 'requested-model');
  assert.equal(r.inputTokens, 0);
  assert.equal(r.outputTokens, 0);
});

// ---------------------------------------------------------------------------
// reply.secrets.redacted log
// ---------------------------------------------------------------------------

/** Run `fn` with process.stderr.write captured, returning the parsed JSON lines. */
async function captureStderr(fn) {
  const orig = process.stderr.write.bind(process.stderr);
  const chunks = [];
  process.stderr.write = (chunk) => { chunks.push(String(chunk)); return true; };
  try { await fn(); } finally { process.stderr.write = orig; }
  return chunks.join('').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('evaluate logs reply.secrets.redacted with the count and threadId', async () => {
  const call = async () => ({ text: '{"verdict":"fixed","reasoning":"ok"}' });
  const lines = await captureStderr(() => evaluate(ctx(call, {
    threadId: 'TH-99',
    diffSlice: "const url = 'postgres://app:s3cretpass@db:5432/prod';",
  })));

  const line = lines.find((l) => l.msg === 'reply.secrets.redacted');
  assert.ok(line, 'expected a reply.secrets.redacted line');
  assert.equal(line.threadId, 'TH-99');
  assert.ok(line.count > 0);
});

test('evaluate omits threadId when the caller does not supply one', async () => {
  const call = async () => ({ text: '{"verdict":"fixed","reasoning":"ok"}' });
  const lines = await captureStderr(() => evaluate(ctx(call, {
    diffSlice: "const url = 'postgres://app:s3cretpass@db:5432/prod';",
  })));

  const line = lines.find((l) => l.msg === 'reply.secrets.redacted');
  assert.ok(line);
  assert.equal(line.threadId, undefined);
});

test('evaluate logs nothing when the payload has no secret', async () => {
  const call = async () => ({ text: '{"verdict":"fixed","reasoning":"ok"}' });
  const lines = await captureStderr(() => evaluate(ctx(call, { threadId: 'TH-1' })));
  assert.equal(lines.find((l) => l.msg === 'reply.secrets.redacted'), undefined);
});
