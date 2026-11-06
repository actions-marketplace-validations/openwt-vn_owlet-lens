// @ts-check
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { wrapModelFallback } = require('../../lib/llm/model-fallback.js');
const { ProviderError, AuthError } = require('../../lib/errors.js');

// Fake provider: scripts a result/throw per model id. Records calls.
function fakeProvider(byModel) {
  const calls = [];
  return {
    calls,
    async call(_sys, _user, opts) {
      calls.push(opts.model);
      const outcome = byModel[opts.model];
      if (typeof outcome === 'function') return outcome();
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  };
}

function silentLog() { /* swallow */ }

test('primary succeeds — fallback never called', async () => {
  const p = fakeProvider({ A: { text: 'ok', usage: {}, cost: {} } });
  const w = wrapModelFallback(p, ['A', 'B'], silentLog);
  const r = await w.call('s', 'u', {});
  assert.strictEqual(r.text, 'ok');
  assert.deepStrictEqual(p.calls, ['A']);
});

test('502 on primary fails over to next model', async () => {
  const p = fakeProvider({
    A: new ProviderError('ModelStack 502', { provider: 'modelstack', status: 502, retryable: true }),
    B: { text: 'from-B', usage: {}, cost: {} },
  });
  const logs = [];
  const w = wrapModelFallback(p, ['A', 'B'], (e) => logs.push(e));
  const r = await w.call('s', 'u', {});
  assert.strictEqual(r.text, 'from-B');
  assert.deepStrictEqual(p.calls, ['A', 'B']);
  assert.strictEqual(logs.length, 1);
  assert.strictEqual(logs[0].fromModel, 'A');
  assert.strictEqual(logs[0].toModel, 'B');
});

test('all models 5xx — throws last error, type preserved', async () => {
  const errB = new ProviderError('ModelStack 502 B', { provider: 'modelstack', status: 502, retryable: true });
  const p = fakeProvider({
    A: new ProviderError('ModelStack 502 A', { provider: 'modelstack', status: 502, retryable: true }),
    B: errB,
  });
  const w = wrapModelFallback(p, ['A', 'B'], silentLog);
  await assert.rejects(() => w.call('s', 'u', {}), (e) => {
    assert.strictEqual(e, errB);
    assert.ok(e instanceof ProviderError);
    return true;
  });
  assert.deepStrictEqual(p.calls, ['A', 'B']);
});

test('auth error short-circuits — next model never tried', async () => {
  const p = fakeProvider({
    A: new AuthError('ModelStack 401', { provider: 'modelstack', status: 401 }),
    B: { text: 'from-B', usage: {}, cost: {} },
  });
  const w = wrapModelFallback(p, ['A', 'B'], silentLog);
  await assert.rejects(() => w.call('s', 'u', {}), (e) => e instanceof AuthError);
  assert.deepStrictEqual(p.calls, ['A']);
});

test('opts.model is overridden per attempt; other opts pass through', async () => {
  let seenOpts;
  const p = {
    async call(_s, _u, opts) { seenOpts = opts; return { text: 'ok', usage: {}, cost: {} }; },
  };
  const w = wrapModelFallback(p, ['A', 'B'], silentLog);
  await w.call('s', 'u', { maxTokens: 1234, responseFormat: 'json', model: 'IGNORED' });
  assert.strictEqual(seenOpts.model, 'A');
  assert.strictEqual(seenOpts.maxTokens, 1234);
  assert.strictEqual(seenOpts.responseFormat, 'json');
});

test('single-model list still works (no failover path)', async () => {
  const p = fakeProvider({ A: { text: 'solo', usage: {}, cost: {} } });
  const w = wrapModelFallback(p, ['A'], silentLog);
  const r = await w.call('s', 'u', {});
  assert.strictEqual(r.text, 'solo');
});

test('wrapper forwards supportsTools=true from inner provider', () => {
  const p = { supportsTools: true, async call() { return { text: 'ok', usage: {}, cost: {} }; } };
  const w = wrapModelFallback(p, ['A'], silentLog);
  assert.strictEqual(w.supportsTools, true, 'supportsTools must be forwarded from inner provider');
  // defaultModel and maxAttempts must NOT be forwarded
  assert.strictEqual(w.defaultModel, undefined);
  assert.strictEqual(w.maxAttempts, undefined);
});

test('wrapper forwards supportsTools=false from inner provider', () => {
  const p = { supportsTools: false, async call() { return { text: 'ok', usage: {}, cost: {} }; } };
  const w = wrapModelFallback(p, ['A'], silentLog);
  assert.strictEqual(w.supportsTools, false);
});

test('opts.tools pass through to inner provider call', async () => {
  let capturedOpts;
  const tools = [{ name: 'submit_findings', input_schema: {} }];
  const p = {
    supportsTools: true,
    async call(_s, _u, opts) { capturedOpts = opts; return { text: 'ok', usage: {}, cost: {} }; },
  };
  const w = wrapModelFallback(p, ['A'], silentLog);
  await w.call('s', 'u', { tools });
  assert.deepStrictEqual(capturedOpts.tools, tools, 'opts.tools must pass through to inner provider');
});
