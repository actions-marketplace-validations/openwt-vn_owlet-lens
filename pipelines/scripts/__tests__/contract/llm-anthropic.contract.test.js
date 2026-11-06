// @ts-check
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { AnthropicProvider } = require('../../lib/llm/anthropic.js');

const RECORDED = Object.freeze({
  id: 'msg_01ABCDEF',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-4-7',
  content: [{ type: 'text', text: '{"findings":[]}' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 1234, output_tokens: 56 },
});

test('AnthropicProvider maps recorded Messages API response to common shape', async (t) => {
  const origFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = origFetch; });
  globalThis.fetch = async () => new Response(JSON.stringify(RECORDED), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

  const provider = new AnthropicProvider({
    apiKey: 'k',
    defaultModel: 'claude-opus-4-7',
    pricingOverride: {},
  });

  const r = await provider.call('sys', 'user', { model: 'claude-opus-4-7' });

  assert.equal(r.text, '{"findings":[]}');
  assert.equal(r.usage.inputTokens, 1234);
  assert.equal(r.usage.outputTokens, 56);
  assert.ok(r.cost.totalCost >= 0);
});
