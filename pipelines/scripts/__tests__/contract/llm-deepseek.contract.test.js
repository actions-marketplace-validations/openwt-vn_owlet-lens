// @ts-check
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { DeepSeekProvider } = require('../../lib/llm/deepseek.js');

// DeepSeekProvider now always streams (OpenAICompatibleProvider), so the
// recorded fixture is expressed as SSE frames rather than a single JSON body.
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

const RECORDED_USAGE = Object.freeze({
  prompt_tokens: 1234,
  completion_tokens: 56,
  total_tokens: 1290,
});

test('DeepSeekProvider maps recorded chat/completions response to common shape', async (t) => {
  const origFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = origFetch; });
  globalThis.fetch = async () => sseResponse(sseSuccess(['{"findings":[]}'], RECORDED_USAGE));

  const provider = new DeepSeekProvider({
    apiKey: 'k',
    defaultModel: 'deepseek-chat',
    pricingOverride: {},
  });

  const r = await provider.call('sys', 'user', { model: 'deepseek-chat' });

  assert.equal(r.text, '{"findings":[]}');
  assert.equal(r.usage.inputTokens, 1234);
  assert.equal(r.usage.outputTokens, 56);
  assert.ok(r.cost.totalCost >= 0);
});
