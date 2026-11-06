// @ts-check
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { OpenAICompatibleProvider } = require('../../lib/llm/openai-base.js');
const { AuthError, ProviderError, LLMError } = require('../../lib/errors.js');

const enc = new TextEncoder();

/**
 * Build a streaming Response from raw SSE strings.
 * @param {string[]} parts
 * @param {{ status?: number }} [opts]
 * @returns {Response}
 */
function sseResponse(parts, { status = 200 } = {}) {
  const stream = new ReadableStream({
    start(controller) {
      for (const p of parts) controller.enqueue(enc.encode(p));
      controller.close();
    },
  });
  return new Response(stream, { status, headers: { 'Content-Type': 'text/event-stream' } });
}

/**
 * Standard success stream: content pieces + optional usage frame + [DONE].
 * @param {string[]} pieces
 * @param {{ prompt_tokens: number, completion_tokens: number }} [usage]
 * @returns {string[]}
 */
function sseSuccess(pieces, usage) {
  const parts = pieces.map((c) =>
    `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`);
  if (usage) {
    parts.push(`data: ${JSON.stringify({ choices: [{ delta: {} }], usage })}\n\n`);
  }
  parts.push('data: [DONE]\n\n');
  return parts;
}

class TestProvider extends OpenAICompatibleProvider {
  constructor(opts) {
    super({
      ...opts,
      providerName: 'modelstack',
      errorLabel: 'Test',
      apiUrl: 'https://x.test/v1/chat/completions',
      maxOutputTokens: 64_000,
    });
  }
}

test('openai-base: request body sets stream + stream_options and messages', async (t) => {
  const orig = globalThis.fetch;
  t.after(() => { globalThis.fetch = orig; });
  let seenBody;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://x.test/v1/chat/completions');
    assert.equal(init.headers['Authorization'], 'Bearer k');
    seenBody = JSON.parse(init.body);
    return sseResponse(sseSuccess(['hi'], { prompt_tokens: 5, completion_tokens: 2 }));
  };
  const p = new TestProvider({ apiKey: 'k', defaultModel: 'm', pricingOverride: {} });
  const r = await p.call('sys', 'usr');
  assert.equal(seenBody.stream, true);
  assert.deepEqual(seenBody.stream_options, { include_usage: true });
  assert.deepEqual(seenBody.messages, [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'usr' },
  ]);
  assert.equal(r.text, 'hi');
  assert.equal(r.usage.inputTokens, 5);
  assert.equal(r.usage.outputTokens, 2);
  assert.equal(r.model, 'm');
});

test('openai-base: accumulates multi-chunk content deltas', async (t) => {
  const orig = globalThis.fetch;
  t.after(() => { globalThis.fetch = orig; });
  globalThis.fetch = async () =>
    sseResponse(sseSuccess(['he', 'llo', ' world'], { prompt_tokens: 1, completion_tokens: 3 }));
  const p = new TestProvider({ apiKey: 'k', defaultModel: 'm', pricingOverride: {} });
  const r = await p.call('sys', 'usr');
  assert.equal(r.text, 'hello world');
});

test('openai-base: jsonMode sets response_format when tools present', async (t) => {
  const orig = globalThis.fetch;
  t.after(() => { globalThis.fetch = orig; });
  let seenBody;
  globalThis.fetch = async (_url, init) => {
    seenBody = JSON.parse(init.body);
    return sseResponse(sseSuccess(['{}'], { prompt_tokens: 1, completion_tokens: 1 }));
  };
  const p = new TestProvider({ apiKey: 'k', defaultModel: 'm', pricingOverride: {} });
  await p.call('sys', 'usr', { tools: [{ name: 'submit_findings' }] });
  assert.deepEqual(seenBody.response_format, { type: 'json_object' });
});

test('openai-base: missing usage frame yields zero tokens (no estimation)', async (t) => {
  const orig = globalThis.fetch;
  t.after(() => { globalThis.fetch = orig; });
  globalThis.fetch = async () => sseResponse(sseSuccess(['some text'])); // no usage
  const p = new TestProvider({ apiKey: 'k', defaultModel: 'm', pricingOverride: {} });
  const r = await p.call('sys', 'usr');
  assert.equal(r.text, 'some text');
  assert.equal(r.usage.inputTokens, 0);
  assert.equal(r.usage.outputTokens, 0);
});

test('openai-base: 401 on headers throws AuthError, no stream read', async (t) => {
  const orig = globalThis.fetch;
  t.after(() => { globalThis.fetch = orig; });
  globalThis.fetch = async () =>
    new Response('{"error":"invalid_api_key"}', { status: 401, headers: { 'Content-Type': 'application/json' } });
  const p = new TestProvider({ apiKey: 'k', defaultModel: 'm', pricingOverride: {} });
  await assert.rejects(p.call('sys', 'usr'), AuthError);
});

test('openai-base: mid-stream transport break retries then succeeds', async (t) => {
  const orig = globalThis.fetch;
  t.after(() => { globalThis.fetch = orig; });
  let attempt = 0;
  globalThis.fetch = async () => {
    attempt += 1;
    if (attempt === 1) {
      // Stream that errors partway through.
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"par"}}]}\n\n'));
          controller.error(new Error('socket hang up'));
        },
      });
      return new Response(stream, { status: 200 });
    }
    return sseResponse(sseSuccess(['whole'], { prompt_tokens: 1, completion_tokens: 1 }));
  };
  const p = new TestProvider({ apiKey: 'k', defaultModel: 'm', pricingOverride: {}, maxAttempts: 3 });
  const r = await p.call('sys', 'usr');
  assert.equal(attempt, 2);
  assert.equal(r.text, 'whole');
});

test('openai-base: empty stream (no content, no usage) throws retryable ProviderError', async (t) => {
  const orig = globalThis.fetch;
  t.after(() => { globalThis.fetch = orig; });
  globalThis.fetch = async () => sseResponse(['data: [DONE]\n\n']);
  const p = new TestProvider({ apiKey: 'k', defaultModel: 'm', pricingOverride: {}, maxAttempts: 1 });
  await assert.rejects(p.call('sys', 'usr'), (e) => {
    assert.ok(e instanceof ProviderError);
    assert.equal(e.retryable, true);
    return true;
  });
});

test('openai-base: malformed SSE line throws LLMError and does NOT retry', async (t) => {
  const orig = globalThis.fetch;
  t.after(() => { globalThis.fetch = orig; });
  let attempt = 0;
  globalThis.fetch = async () => {
    attempt += 1;
    return sseResponse(['data: {not valid json}\n\n', 'data: [DONE]\n\n']);
  };
  // maxAttempts:3 available, but a malformed line is terminal — must fail on attempt 1.
  const p = new TestProvider({ apiKey: 'k', defaultModel: 'm', pricingOverride: {}, maxAttempts: 3 });
  await assert.rejects(p.call('sys', 'usr'), LLMError);
  assert.equal(attempt, 1);
});
