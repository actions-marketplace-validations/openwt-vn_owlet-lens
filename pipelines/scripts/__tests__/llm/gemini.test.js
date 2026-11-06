// @ts-check
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { GeminiProvider } = require('../../lib/llm/gemini.js');
const { AuthError, RateLimitError, ProviderError, LLMError } = require('../../lib/errors.js');

function makeFetch(impl) {
  return async (url, init) => impl(url, init);
}

test('gemini: 200 success returns text + mapped usage + cost', async (t) => {
  const orig = globalThis.fetch;
  t.after(() => { globalThis.fetch = orig; });
  globalThis.fetch = makeFetch(async (url, init) => {
    assert.match(url, /generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-2\.5-pro:generateContent$/);
    assert.equal(init.headers['x-goog-api-key'], 'k');
    const body = JSON.parse(init.body);
    assert.equal(body.systemInstruction.parts[0].text, 'sys');
    assert.equal(body.contents[0].parts[0].text, 'usr');
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'hi' }] } }],
      usageMetadata: { promptTokenCount: 1_000_000, candidatesTokenCount: 100_000 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  const p = new GeminiProvider({ apiKey: 'k', defaultModel: 'gemini-2.5-pro', pricingOverride: {} });
  const r = await p.call('sys', 'usr');
  assert.equal(r.text, 'hi');
  assert.equal(r.usage.inputTokens, 1_000_000);
  assert.equal(r.usage.outputTokens, 100_000);
  assert.equal(r.cost.totalCost, 1.25 + 1);
});

test('gemini: 401 throws AuthError', async (t) => {
  const orig = globalThis.fetch;
  t.after(() => { globalThis.fetch = orig; });
  globalThis.fetch = makeFetch(async () => new Response('nope', { status: 401 }));
  const p = new GeminiProvider({ apiKey: 'k', defaultModel: 'gemini-2.5-pro', pricingOverride: {} });
  await assert.rejects(p.call('s', 'u'), AuthError);
});

test('gemini: 429 retries then throws RateLimitError', async (t) => {
  const orig = globalThis.fetch;
  t.after(() => { globalThis.fetch = orig; });
  let calls = 0;
  globalThis.fetch = makeFetch(async () => { calls++; return new Response('', { status: 429 }); });
  const p = new GeminiProvider({ apiKey: 'k', defaultModel: 'gemini-2.5-pro', pricingOverride: {}, maxAttempts: 2 });
  await assert.rejects(p.call('s', 'u'), RateLimitError);
  assert.equal(calls, 2);
});

test('gemini: 500 retries then throws ProviderError', async (t) => {
  const orig = globalThis.fetch;
  t.after(() => { globalThis.fetch = orig; });
  globalThis.fetch = makeFetch(async () => new Response('', { status: 500 }));
  const p = new GeminiProvider({ apiKey: 'k', defaultModel: 'gemini-2.5-pro', pricingOverride: {}, maxAttempts: 2 });
  await assert.rejects(p.call('s', 'u'), ProviderError);
});

test('gemini: malformed body throws LLMError', async (t) => {
  const orig = globalThis.fetch;
  t.after(() => { globalThis.fetch = orig; });
  globalThis.fetch = makeFetch(async () => new Response('garbage', { status: 200 }));
  const p = new GeminiProvider({ apiKey: 'k', defaultModel: 'gemini-2.5-pro', pricingOverride: {} });
  await assert.rejects(p.call('s', 'u'), LLMError);
});

test('gemini: supportsTools=true so ai-review.js wires structured output', () => {
  const p = new GeminiProvider({ apiKey: 'k', defaultModel: 'gemini-1.5-pro', pricingOverride: {} });
  assert.equal(p.supportsTools, true);
});

test('gemini: when tools+toolChoice supplied, request sets responseMimeType + responseSchema', async (t) => {
  const orig = globalThis.fetch;
  t.after(() => { globalThis.fetch = orig; });
  const tool = {
    name: 'submit_findings',
    description: 'submit findings',
    input_schema: {
      type: 'object',
      properties: { findings: { type: 'array', items: { type: 'object' } } },
      required: ['findings'],
    },
  };
  let captured;
  globalThis.fetch = async (_url, init) => {
    captured = JSON.parse(init.body);
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: '{"findings":[]}' }] } }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const p = new GeminiProvider({ apiKey: 'k', defaultModel: 'gemini-1.5-pro', pricingOverride: {} });
  await p.call('sys', 'usr', { tools: [tool], toolChoice: { type: 'tool', name: 'submit_findings' } });

  assert.equal(captured.generationConfig.responseMimeType, 'application/json');
  assert.deepEqual(captured.generationConfig.responseSchema, tool.input_schema);
});

test('gemini: without tools, request body has no responseSchema (backward compat)', async (t) => {
  const orig = globalThis.fetch;
  t.after(() => { globalThis.fetch = orig; });
  let captured;
  globalThis.fetch = async (_url, init) => {
    captured = JSON.parse(init.body);
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'hi' }] } }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const p = new GeminiProvider({ apiKey: 'k', defaultModel: 'gemini-1.5-pro', pricingOverride: {} });
  await p.call('sys', 'usr');

  assert.equal(captured.generationConfig.responseSchema, undefined);
  assert.equal(captured.generationConfig.responseMimeType, undefined);
});
