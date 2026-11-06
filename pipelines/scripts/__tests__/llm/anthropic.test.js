// @ts-check
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AnthropicProvider } = require('../../lib/llm/anthropic.js');
const { AuthError, RateLimitError, ProviderError, LLMError } = require('../../lib/errors.js');

function makeFetch(impl) {
  return async (url, init) => impl(url, init);
}

test('anthropic: 200 success returns text + usage + cost', async (t) => {
  const orig = globalThis.fetch;
  t.after(() => { globalThis.fetch = orig; });
  globalThis.fetch = makeFetch(async (url, init) => {
    assert.equal(url, 'https://api.anthropic.com/v1/messages');
    assert.equal(init.headers['x-api-key'], 'k');
    assert.equal(init.headers['anthropic-version'], '2023-06-01');
    assert.equal(init.headers['anthropic-beta'], 'prompt-caching-2024-07-31');
    const body = JSON.parse(init.body);
    assert.equal(body.model, 'claude-opus-4-7');
    assert.deepEqual(body.system, [
      { type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } },
    ]);
    assert.equal(body.messages[0].content, 'usr');
    return new Response(JSON.stringify({
      content: [{ type: 'text', text: 'hi' }],
      usage: { input_tokens: 1_000_000, output_tokens: 500_000 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  const p = new AnthropicProvider({ apiKey: 'k', defaultModel: 'claude-opus-4-7', pricingOverride: {} });
  const r = await p.call('sys', 'usr');
  assert.equal(r.text, 'hi');
  assert.equal(r.usage.inputTokens, 1_000_000);
  assert.equal(r.usage.outputTokens, 500_000);
  assert.equal(r.cost.totalCost, 17.5);
});

test('anthropic: 401 throws AuthError', async (t) => {
  const orig = globalThis.fetch;
  t.after(() => { globalThis.fetch = orig; });
  globalThis.fetch = makeFetch(async () =>
    new Response('unauthorized', { status: 401 }));
  const p = new AnthropicProvider({ apiKey: 'k', defaultModel: 'claude-opus-4-7', pricingOverride: {} });
  await assert.rejects(p.call('s', 'u'), AuthError);
});

test('anthropic: 429 retries then throws RateLimitError', async (t) => {
  const orig = globalThis.fetch;
  t.after(() => { globalThis.fetch = orig; });
  let calls = 0;
  globalThis.fetch = makeFetch(async () => {
    calls++;
    return new Response('rate limited', { status: 429 });
  });
  const p = new AnthropicProvider({ apiKey: 'k', defaultModel: 'claude-opus-4-7', pricingOverride: {}, maxAttempts: 2 });
  await assert.rejects(p.call('s', 'u'), RateLimitError);
  assert.equal(calls, 2);
});

test('anthropic: 500 retries then throws ProviderError', async (t) => {
  const orig = globalThis.fetch;
  t.after(() => { globalThis.fetch = orig; });
  globalThis.fetch = makeFetch(async () => new Response('boom', { status: 500 }));
  const p = new AnthropicProvider({ apiKey: 'k', defaultModel: 'claude-opus-4-7', pricingOverride: {}, maxAttempts: 2 });
  await assert.rejects(p.call('s', 'u'), ProviderError);
});

test('anthropic: malformed body throws LLMError', async (t) => {
  const orig = globalThis.fetch;
  t.after(() => { globalThis.fetch = orig; });
  globalThis.fetch = makeFetch(async () =>
    new Response('not json', { status: 200, headers: { 'Content-Type': 'application/json' } }));
  const p = new AnthropicProvider({ apiKey: 'k', defaultModel: 'claude-opus-4-7', pricingOverride: {} });
  await assert.rejects(p.call('s', 'u'), LLMError);
});

test('anthropic: supportsTools=true', () => {
  const p = new AnthropicProvider({ apiKey: 'k', defaultModel: 'claude-opus-4-7', pricingOverride: {} });
  assert.equal(p.supportsTools, true);
});

test('anthropic: forwards tools + tool_choice when opts supply them', async (t) => {
  const orig = globalThis.fetch;
  t.after(() => { globalThis.fetch = orig; });
  const tool = {
    name: 'submit_findings',
    description: 'd',
    input_schema: { type: 'object', properties: { findings: { type: 'array' } }, required: ['findings'] },
  };
  globalThis.fetch = makeFetch(async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.deepEqual(body.tools, [tool]);
    assert.deepEqual(body.tool_choice, { type: 'tool', name: 'submit_findings' });
    return new Response(JSON.stringify({
      content: [{ type: 'tool_use', name: 'submit_findings', input: { findings: [{ file: 'a', line: 1 }] } }],
      usage: { input_tokens: 0, output_tokens: 0 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  const p = new AnthropicProvider({ apiKey: 'k', defaultModel: 'claude-opus-4-7', pricingOverride: {} });
  const r = await p.call('s', 'u', { tools: [tool], toolChoice: { type: 'tool', name: 'submit_findings' } });
  assert.equal(r.text, JSON.stringify({ findings: [{ file: 'a', line: 1 }] }));
});

// Claude Opus 5.5, Sonnet 5.5, Fable 5.1 and Mythos 5.1 return a 400 for a
// forced tool_choice ("tool_choice: type \"tool\" and \"any\" are not
// supported for this model."). The provider downgrades to `auto` and names the
// tool in an extra system block instead.
for (const model of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1', 'claude-mythos-5-1']) {
  for (const forced of [{ type: 'tool', name: 'submit_findings' }, { type: 'any' }]) {
    test(`anthropic: ${model} downgrades tool_choice ${forced.type} to auto`, async (t) => {
      const orig = globalThis.fetch;
      t.after(() => { globalThis.fetch = orig; });
      const tool = { name: 'submit_findings', description: 'd', input_schema: { type: 'object' } };
      let body;
      globalThis.fetch = makeFetch(async (_url, init) => {
        body = JSON.parse(init.body);
        return new Response(JSON.stringify({
          content: [{ type: 'tool_use', name: 'submit_findings', input: { findings: [] } }],
          usage: { input_tokens: 0, output_tokens: 0 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      });
      const p = new AnthropicProvider({ apiKey: 'k', defaultModel: model, pricingOverride: {} });
      const r = await p.call('sys', 'u', { tools: [tool], toolChoice: forced });
      assert.deepEqual(body.tool_choice, { type: 'auto' });
      assert.deepEqual(body.system[0], { type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } });
      assert.equal(body.system.length, 2);
      assert.match(body.system[1].text, /submit_findings/);
      assert.equal(r.text, JSON.stringify({ findings: [] }));
    });
  }
}

test('anthropic: forced tool_choice kept for models that accept it', async (t) => {
  const orig = globalThis.fetch;
  t.after(() => { globalThis.fetch = orig; });
  let body;
  globalThis.fetch = makeFetch(async (_url, init) => {
    body = JSON.parse(init.body);
    return new Response(JSON.stringify({
      content: [{ type: 'text', text: '{}' }],
      usage: { input_tokens: 0, output_tokens: 0 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  const tool = { name: 'submit_findings', description: 'd', input_schema: { type: 'object' } };
  for (const model of ['claude-opus-5', 'claude-haiku-5-5', 'claude-sonnet-4-6']) {
    const p = new AnthropicProvider({ apiKey: 'k', defaultModel: model, pricingOverride: {} });
    await p.call('sys', 'u', { tools: [tool], toolChoice: { type: 'any' } });
    assert.deepEqual(body.tool_choice, { type: 'any' }, model);
    assert.equal(body.system.length, 1, model);
  }
});

test('anthropic: extracts cache token usage', async (t) => {
  const orig = globalThis.fetch;
  t.after(() => { globalThis.fetch = orig; });
  globalThis.fetch = makeFetch(async () => new Response(JSON.stringify({
    content: [{ type: 'text', text: 'hi' }],
    usage: {
      input_tokens: 10, output_tokens: 5,
      cache_creation_input_tokens: 100, cache_read_input_tokens: 200,
    },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  const p = new AnthropicProvider({ apiKey: 'k', defaultModel: 'claude-opus-4-7', pricingOverride: {} });
  const r = await p.call('s', 'u');
  assert.equal(r.usage.cacheCreationInputTokens, 100);
  assert.equal(r.usage.cacheReadInputTokens, 200);
});

test('anthropic: 429 parses Retry-After seconds into RateLimitError.retryAfterMs', async (t) => {
  const orig = globalThis.fetch;
  t.after(() => { globalThis.fetch = orig; });
  let calls = 0;
  globalThis.fetch = makeFetch(async () => {
    calls++;
    return new Response('rate limited', {
      status: 429,
      headers: { 'Retry-After': '7' },
    });
  });
  const p = new AnthropicProvider({ apiKey: 'k', defaultModel: 'claude-opus-4-7', pricingOverride: {}, maxAttempts: 1 });
  let caught;
  try { await p.call('s', 'u'); } catch (e) { caught = e; }
  assert.ok(caught instanceof RateLimitError);
  assert.equal(caught.retryAfterMs, 7000, 'Retry-After: 7 must produce 7000ms');
});

test('anthropic: 429 with HTTP-date Retry-After parses into future-relative ms', async (t) => {
  const orig = globalThis.fetch;
  t.after(() => { globalThis.fetch = orig; });
  const future = new Date(Date.now() + 5000).toUTCString();
  globalThis.fetch = makeFetch(async () => new Response('rate limited', {
    status: 429,
    headers: { 'Retry-After': future },
  }));
  const p = new AnthropicProvider({ apiKey: 'k', defaultModel: 'claude-opus-4-7', pricingOverride: {}, maxAttempts: 1 });
  let caught;
  try { await p.call('s', 'u'); } catch (e) { caught = e; }
  assert.ok(caught instanceof RateLimitError);
  assert.ok(caught.retryAfterMs >= 4000 && caught.retryAfterMs <= 6000,
    `retryAfterMs ~5000 expected, got ${caught.retryAfterMs}`);
});

test('anthropic: 429 with no Retry-After leaves retryAfterMs undefined', async (t) => {
  const orig = globalThis.fetch;
  t.after(() => { globalThis.fetch = orig; });
  globalThis.fetch = makeFetch(async () => new Response('rate limited', { status: 429 }));
  const p = new AnthropicProvider({ apiKey: 'k', defaultModel: 'claude-opus-4-7', pricingOverride: {}, maxAttempts: 1 });
  let caught;
  try { await p.call('s', 'u'); } catch (e) { caught = e; }
  assert.ok(caught instanceof RateLimitError);
  assert.equal(caught.retryAfterMs, undefined);
});

test('anthropic: default max_tokens is 32000 (Opus 4.7 ceiling; safe across Gemini 2.5 + DeepSeek V4)', async (t) => {
  const orig = globalThis.fetch;
  t.after(() => { globalThis.fetch = orig; });
  let observedMaxTokens;
  globalThis.fetch = makeFetch(async (_url, init) => {
    observedMaxTokens = JSON.parse(init.body).max_tokens;
    return new Response(JSON.stringify({
      content: [{ type: 'text', text: 'hi' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  const p = new AnthropicProvider({ apiKey: 'k', defaultModel: 'claude-opus-4-7', pricingOverride: {} });
  await p.call('s', 'u');
  assert.equal(observedMaxTokens, 32000);
});

test('anthropic: an over-large maxTokens is clamped to the 32000 ceiling (avoids 400)', async (t) => {
  const orig = globalThis.fetch;
  t.after(() => { globalThis.fetch = orig; });
  let observedMaxTokens;
  globalThis.fetch = makeFetch(async (_url, init) => {
    observedMaxTokens = JSON.parse(init.body).max_tokens;
    return new Response(JSON.stringify({
      content: [{ type: 'text', text: 'hi' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  const p = new AnthropicProvider({ apiKey: 'k', defaultModel: 'claude-opus-4-7', pricingOverride: {} });
  await p.call('s', 'u', { maxTokens: 128_000 });
  assert.equal(observedMaxTokens, 32000);
});
