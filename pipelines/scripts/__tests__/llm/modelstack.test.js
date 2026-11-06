// @ts-check
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ModelStackProvider } = require('../../lib/llm/modelstack.js');
const { AuthError, RateLimitError, ProviderError, LLMError } = require('../../lib/errors.js');

function makeFetch(impl) {
  return async (url, init) => impl(url, init);
}

const enc = new TextEncoder();

/** Build a streaming Response from raw SSE strings. */
function sseResponse(parts, { status = 200 } = {}) {
  const stream = new ReadableStream({
    start(controller) {
      for (const p of parts) controller.enqueue(enc.encode(p));
      controller.close();
    },
  });
  return new Response(stream, { status, headers: { 'Content-Type': 'text/event-stream' } });
}

/** content pieces + optional usage frame + [DONE]. */
function sseSuccess(pieces, usage) {
  const parts = pieces.map((c) =>
    `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`);
  if (usage) parts.push(`data: ${JSON.stringify({ choices: [{ delta: {} }], usage })}\n\n`);
  parts.push('data: [DONE]\n\n');
  return parts;
}

test('modelstack: 200 success returns text + mapped usage', async (t) => {
  const orig = globalThis.fetch;
  t.after(() => { globalThis.fetch = orig; });
  globalThis.fetch = makeFetch(async (url, init) => {
    assert.equal(url, 'https://api.modelstack.cc/v1/chat/completions');
    assert.equal(init.headers['Authorization'], 'Bearer k');
    const body = JSON.parse(init.body);
    assert.equal(body.model, 'gpt-4o');
    assert.deepEqual(body.messages, [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'usr' },
    ]);
    assert.equal(body.stream, true);
    assert.deepEqual(body.stream_options, { include_usage: true });
    return sseResponse(sseSuccess(['hi'], { prompt_tokens: 1000, completion_tokens: 200 }));
  });
  const p = new ModelStackProvider({ apiKey: 'k', defaultModel: 'gpt-4o', pricingOverride: {} });
  const r = await p.call('sys', 'usr');
  assert.equal(r.text, 'hi');
  assert.equal(r.usage.inputTokens, 1000);
  assert.equal(r.usage.outputTokens, 200);
  // The response surfaces the model that answered so callers attribute
  // logs/cost to it (defaults to defaultModel when opts.model is absent).
  assert.equal(r.model, 'gpt-4o');
});

test('modelstack: request carries extended timeout controls', async (t) => {
  const orig = globalThis.fetch;
  t.after(() => { globalThis.fetch = orig; });
  let observedSignal;
  let observedDispatcher;
  globalThis.fetch = makeFetch(async (_url, init) => {
    observedSignal = init.signal;
    observedDispatcher = init.dispatcher;
    return new Response(JSON.stringify({
      choices: [{ message: { content: 'ok' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  const p = new ModelStackProvider({ apiKey: 'k', defaultModel: 'gpt-4o', pricingOverride: {} });
  await p.call('sys', 'usr');
  assert.ok(observedSignal instanceof AbortSignal);
  assert.equal(observedSignal.aborted, false);
  assert.equal(typeof observedDispatcher?.dispatch, 'function');
});

test('modelstack: response.model reflects the per-call opts.model override', async (t) => {
  const orig = globalThis.fetch;
  t.after(() => { globalThis.fetch = orig; });
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.model, 'failover-model');   // opts.model overrides defaultModel
    return sseResponse(sseSuccess(['ok'], { prompt_tokens: 1, completion_tokens: 1 }));
  };
  const p = new ModelStackProvider({ apiKey: 'k', defaultModel: 'primary-model', pricingOverride: {} });
  const r = await p.call('sys', 'usr', { model: 'failover-model' });
  assert.equal(r.model, 'failover-model');
});

test('modelstack: supportsTools=true', () => {
  const p = new ModelStackProvider({ apiKey: 'k', defaultModel: 'gpt-4o', pricingOverride: {} });
  assert.equal(p.supportsTools, true);
});

test('modelstack: when tools supplied, body sets response_format json_object', async (t) => {
  const orig = globalThis.fetch;
  t.after(() => { globalThis.fetch = orig; });
  let captured;
  globalThis.fetch = async (_url, init) => {
    captured = JSON.parse(init.body);
    return sseResponse(sseSuccess(['{"findings":[]}'], { prompt_tokens: 1, completion_tokens: 1 }));
  };
  const p = new ModelStackProvider({ apiKey: 'k', defaultModel: 'gpt-4o', pricingOverride: {} });
  await p.call('sys', 'usr', {
    tools: [{ name: 'submit_findings', input_schema: { type: 'object' } }],
    toolChoice: { type: 'tool', name: 'submit_findings' },
  });
  assert.deepEqual(captured.response_format, { type: 'json_object' });
});

test('modelstack: responseFormat=json sets json_object even without tools', async (t) => {
  const orig = globalThis.fetch;
  t.after(() => { globalThis.fetch = orig; });
  let captured;
  globalThis.fetch = async (_url, init) => {
    captured = JSON.parse(init.body);
    return sseResponse(sseSuccess(['{}'], { prompt_tokens: 1, completion_tokens: 1 }));
  };
  const p = new ModelStackProvider({ apiKey: 'k', defaultModel: 'gpt-4o', pricingOverride: {} });
  await p.call('sys', 'usr', { responseFormat: 'json' });
  assert.deepEqual(captured.response_format, { type: 'json_object' });
});

test('modelstack: without tools, no response_format', async (t) => {
  const orig = globalThis.fetch;
  t.after(() => { globalThis.fetch = orig; });
  let captured;
  globalThis.fetch = async (_url, init) => {
    captured = JSON.parse(init.body);
    return sseResponse(sseSuccess(['hi'], { prompt_tokens: 1, completion_tokens: 1 }));
  };
  const p = new ModelStackProvider({ apiKey: 'k', defaultModel: 'gpt-4o', pricingOverride: {} });
  await p.call('sys', 'usr');
  assert.equal(captured.response_format, undefined);
});

test('modelstack: clamps over-large maxTokens to 64000', async (t) => {
  const orig = globalThis.fetch;
  t.after(() => { globalThis.fetch = orig; });
  let observed;
  globalThis.fetch = makeFetch(async (_url, init) => {
    observed = JSON.parse(init.body).max_tokens;
    return sseResponse(sseSuccess(['ok'], { prompt_tokens: 1, completion_tokens: 1 }));
  });
  const p = new ModelStackProvider({ apiKey: 'k', defaultModel: 'gpt-4o', pricingOverride: {} });
  await p.call('s', 'u', { maxTokens: 128_000 });
  assert.equal(observed, 64_000);
});

test('modelstack: 401 throws AuthError', async (t) => {
  const orig = globalThis.fetch;
  t.after(() => { globalThis.fetch = orig; });
  globalThis.fetch = makeFetch(async () => new Response('nope', { status: 401 }));
  const p = new ModelStackProvider({ apiKey: 'k', defaultModel: 'gpt-4o', pricingOverride: {} });
  await assert.rejects(p.call('s', 'u'), AuthError);
});

test('modelstack: 403 Cloudflare challenge retries then throws retryable ProviderError (not AuthError)', async (t) => {
  const orig = globalThis.fetch;
  t.after(() => { globalThis.fetch = orig; });
  let calls = 0;
  globalThis.fetch = makeFetch(async () => {
    calls++;
    return new Response(
      '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>cloudflare</body></html>',
      { status: 403, headers: { 'Content-Type': 'text/html', 'cf-mitigated': 'challenge' } },
    );
  });
  const p = new ModelStackProvider({ apiKey: 'k', defaultModel: 'gpt-4o', pricingOverride: {}, maxAttempts: 2 });
  await assert.rejects(
    p.call('s', 'u'),
    (e) => e instanceof ProviderError && !(e instanceof AuthError) && e.retryable === true && e.status === 403,
  );
  assert.equal(calls, 2); // 2 attempts total (1 initial + 1 retry) — the Cloudflare 403 is retried, not fatal on attempt 1
});

test('modelstack: 403 JSON invalid_api_key throws AuthError without retry', async (t) => {
  const orig = globalThis.fetch;
  t.after(() => { globalThis.fetch = orig; });
  let calls = 0;
  globalThis.fetch = makeFetch(async () => {
    calls++;
    return new Response(JSON.stringify({ error: 'invalid_api_key' }), {
      status: 403, headers: { 'Content-Type': 'application/json' },
    });
  });
  const p = new ModelStackProvider({ apiKey: 'k', defaultModel: 'gpt-4o', pricingOverride: {}, maxAttempts: 3 });
  await assert.rejects(p.call('s', 'u'), AuthError);
  assert.equal(calls, 1); // genuine auth failure stays fatal — no wasted retries
});

test('modelstack: 429 retries then throws RateLimitError', async (t) => {
  const orig = globalThis.fetch;
  t.after(() => { globalThis.fetch = orig; });
  let calls = 0;
  globalThis.fetch = makeFetch(async () => { calls++; return new Response('', { status: 429 }); });
  const p = new ModelStackProvider({ apiKey: 'k', defaultModel: 'gpt-4o', pricingOverride: {}, maxAttempts: 2 });
  await assert.rejects(p.call('s', 'u'), RateLimitError);
  assert.equal(calls, 2);
});

test('modelstack: 500 retries then throws ProviderError', async (t) => {
  const orig = globalThis.fetch;
  t.after(() => { globalThis.fetch = orig; });
  globalThis.fetch = makeFetch(async () => new Response('', { status: 502 }));
  const p = new ModelStackProvider({ apiKey: 'k', defaultModel: 'gpt-4o', pricingOverride: {}, maxAttempts: 2 });
  await assert.rejects(p.call('s', 'u'), ProviderError);
});

test('modelstack: malformed body throws LLMError', async (t) => {
  const orig = globalThis.fetch;
  t.after(() => { globalThis.fetch = orig; });
  globalThis.fetch = makeFetch(async () => new Response('garbage', { status: 200 }));
  const p = new ModelStackProvider({ apiKey: 'k', defaultModel: 'gpt-4o', pricingOverride: {} });
  await assert.rejects(p.call('s', 'u'), LLMError);
});
