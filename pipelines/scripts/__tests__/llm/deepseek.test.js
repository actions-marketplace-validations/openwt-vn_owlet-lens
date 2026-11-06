// @ts-check
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DeepSeekProvider } = require('../../lib/llm/deepseek.js');
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

test('deepseek: 200 success returns text + mapped usage + cost', async (t) => {
  const orig = globalThis.fetch;
  t.after(() => { globalThis.fetch = orig; });
  globalThis.fetch = makeFetch(async (url, init) => {
    assert.equal(url, 'https://api.deepseek.com/v1/chat/completions');
    assert.equal(init.headers['Authorization'], 'Bearer k');
    const body = JSON.parse(init.body);
    assert.equal(body.model, 'deepseek-chat');
    assert.deepEqual(body.messages, [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'usr' },
    ]);
    assert.equal(body.stream, true);
    assert.deepEqual(body.stream_options, { include_usage: true });
    return sseResponse(sseSuccess(['hi'], { prompt_tokens: 1_000_000, completion_tokens: 200_000 }));
  });
  const p = new DeepSeekProvider({ apiKey: 'k', defaultModel: 'deepseek-chat', pricingOverride: {} });
  const r = await p.call('sys', 'usr');
  assert.equal(r.text, 'hi');
  assert.equal(r.usage.inputTokens, 1_000_000);
  assert.equal(r.usage.outputTokens, 200_000);
  assert.equal(r.cost.totalCost, 0.27 + 0.22);
});

test('deepseek: clamps an over-large maxTokens to the 64000 reasoning ceiling', async (t) => {
  const orig = globalThis.fetch;
  t.after(() => { globalThis.fetch = orig; });
  let observed;
  globalThis.fetch = makeFetch(async (_url, init) => {
    observed = JSON.parse(init.body).max_tokens;
    return sseResponse(sseSuccess(['ok'], { prompt_tokens: 1, completion_tokens: 1 }));
  });
  const p = new DeepSeekProvider({ apiKey: 'k', defaultModel: 'deepseek-v4-pro', pricingOverride: {} });
  await p.call('s', 'u', { maxTokens: 128_000 });
  assert.equal(observed, 64_000);
});

test('deepseek: 401 throws AuthError', async (t) => {
  const orig = globalThis.fetch;
  t.after(() => { globalThis.fetch = orig; });
  globalThis.fetch = makeFetch(async () => new Response('nope', { status: 401 }));
  const p = new DeepSeekProvider({ apiKey: 'k', defaultModel: 'deepseek-chat', pricingOverride: {} });
  await assert.rejects(p.call('s', 'u'), AuthError);
});

test('deepseek: 429 retries then throws RateLimitError', async (t) => {
  const orig = globalThis.fetch;
  t.after(() => { globalThis.fetch = orig; });
  let calls = 0;
  globalThis.fetch = makeFetch(async () => { calls++; return new Response('', { status: 429 }); });
  const p = new DeepSeekProvider({ apiKey: 'k', defaultModel: 'deepseek-chat', pricingOverride: {}, maxAttempts: 2 });
  await assert.rejects(p.call('s', 'u'), RateLimitError);
  assert.equal(calls, 2);
});

test('deepseek: 500 retries then throws ProviderError', async (t) => {
  const orig = globalThis.fetch;
  t.after(() => { globalThis.fetch = orig; });
  globalThis.fetch = makeFetch(async () => new Response('', { status: 502 }));
  const p = new DeepSeekProvider({ apiKey: 'k', defaultModel: 'deepseek-chat', pricingOverride: {}, maxAttempts: 2 });
  await assert.rejects(p.call('s', 'u'), ProviderError);
});

test('deepseek: malformed body throws LLMError', async (t) => {
  const orig = globalThis.fetch;
  t.after(() => { globalThis.fetch = orig; });
  globalThis.fetch = makeFetch(async () => new Response('garbage', { status: 200 }));
  const p = new DeepSeekProvider({ apiKey: 'k', defaultModel: 'deepseek-chat', pricingOverride: {} });
  await assert.rejects(p.call('s', 'u'), LLMError);
});

test('deepseek: supportsTools=true', () => {
  const p = new DeepSeekProvider({ apiKey: 'k', defaultModel: 'deepseek-chat', pricingOverride: {} });
  assert.equal(p.supportsTools, true);
});

test('deepseek: when tools supplied, body sets response_format json_object', async (t) => {
  const orig = globalThis.fetch;
  t.after(() => { globalThis.fetch = orig; });
  let captured;
  globalThis.fetch = async (_url, init) => {
    captured = JSON.parse(init.body);
    return sseResponse(sseSuccess(['{"findings":[]}'], { prompt_tokens: 1, completion_tokens: 1 }));
  };
  const p = new DeepSeekProvider({ apiKey: 'k', defaultModel: 'deepseek-chat', pricingOverride: {} });
  await p.call('sys', 'usr', {
    tools: [{ name: 'submit_findings', input_schema: { type: 'object' } }],
    toolChoice: { type: 'tool', name: 'submit_findings' },
  });
  assert.deepEqual(captured.response_format, { type: 'json_object' });
});

test('deepseek: without tools, no response_format (backward compat)', async (t) => {
  const orig = globalThis.fetch;
  t.after(() => { globalThis.fetch = orig; });
  let captured;
  globalThis.fetch = async (_url, init) => {
    captured = JSON.parse(init.body);
    return sseResponse(sseSuccess(['hi'], { prompt_tokens: 1, completion_tokens: 1 }));
  };
  const p = new DeepSeekProvider({ apiKey: 'k', defaultModel: 'deepseek-chat', pricingOverride: {} });
  await p.call('sys', 'usr');
  assert.equal(captured.response_format, undefined);
});
