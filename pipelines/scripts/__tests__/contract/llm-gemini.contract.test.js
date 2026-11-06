// @ts-check
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { GeminiProvider } = require('../../lib/llm/gemini.js');

const RECORDED = Object.freeze({
  candidates: [{
    content: { parts: [{ text: '{"findings":[]}' }], role: 'model' },
    finishReason: 'STOP',
    index: 0,
  }],
  usageMetadata: {
    promptTokenCount: 1234,
    candidatesTokenCount: 56,
    totalTokenCount: 1290,
  },
  modelVersion: 'gemini-2.5-pro',
});

test('GeminiProvider maps recorded generateContent response to common shape', async (t) => {
  const origFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = origFetch; });
  globalThis.fetch = async () => new Response(JSON.stringify(RECORDED), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

  const provider = new GeminiProvider({
    apiKey: 'k',
    defaultModel: 'gemini-2.5-pro',
    pricingOverride: {},
  });

  const r = await provider.call('sys', 'user', { model: 'gemini-2.5-pro' });

  assert.equal(r.text, '{"findings":[]}');
  assert.equal(r.usage.inputTokens, 1234);
  assert.equal(r.usage.outputTokens, 56);
  assert.ok(r.cost.totalCost >= 0);
});
