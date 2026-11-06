// @ts-check
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSSE } = require('../../lib/llm/sse-parse.js');
const { LLMError } = require('../../lib/errors.js');

const enc = new TextEncoder();

/** Turn an array of strings into an async iterable of Uint8Array. */
async function* bytes(parts) {
  for (const p of parts) yield enc.encode(p);
}

async function collect(gen) {
  const out = [];
  for await (const o of gen) out.push(o);
  return out;
}

test('parseSSE: accumulates content deltas across multiple data lines', async () => {
  const parts = [
    'data: {"choices":[{"delta":{"content":"he"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"llo"}}]}\n\n',
    'data: [DONE]\n\n',
  ];
  const objs = await collect(parseSSE(bytes(parts), 'Test'));
  assert.equal(objs.length, 2);
  assert.equal(objs[0].choices[0].delta.content, 'he');
  assert.equal(objs[1].choices[0].delta.content, 'llo');
});

test('parseSSE: reassembles a JSON payload split across two chunks', async () => {
  const parts = ['data: {"choices":[{"delta":{"con', 'tent":"x"}}]}\n\ndata: [DONE]\n\n'];
  const objs = await collect(parseSSE(bytes(parts), 'Test'));
  assert.equal(objs.length, 1);
  assert.equal(objs[0].choices[0].delta.content, 'x');
});

test('parseSSE: ignores blank lines and comment lines', async () => {
  const parts = [':\n\n', 'data: {"a":1}\n', '\n', 'data: [DONE]\n'];
  const objs = await collect(parseSSE(bytes(parts), 'Test'));
  assert.deepEqual(objs, [{ a: 1 }]);
});

test('parseSSE: [DONE] terminates iteration', async () => {
  const parts = ['data: {"a":1}\n', 'data: [DONE]\n', 'data: {"b":2}\n'];
  const objs = await collect(parseSSE(bytes(parts), 'Test'));
  assert.deepEqual(objs, [{ a: 1 }]);
});

test('parseSSE: captures a terminal usage frame', async () => {
  const parts = [
    'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
    'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":10,"completion_tokens":3}}\n\n',
    'data: [DONE]\n\n',
  ];
  const objs = await collect(parseSSE(bytes(parts), 'Test'));
  assert.equal(objs.at(-1).usage.prompt_tokens, 10);
});

test('parseSSE: flushes a trailing line with no final newline', async () => {
  const parts = ['data: {"a":1}'];
  const objs = await collect(parseSSE(bytes(parts), 'Test'));
  assert.deepEqual(objs, [{ a: 1 }]);
});

test('parseSSE: skips non-data SSE field lines (event/id/retry)', async () => {
  const parts = [
    'event: message\n',
    'id: 42\n',
    'retry: 3000\n',
    'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
    'data: [DONE]\n\n',
  ];
  const objs = await collect(parseSSE(bytes(parts), 'Test'));
  assert.equal(objs.length, 1);
  assert.equal(objs[0].choices[0].delta.content, 'hi');
});

test('parseSSE: malformed complete line throws LLMError', async () => {
  const parts = ['data: {not json}\n\n'];
  await assert.rejects(collect(parseSSE(bytes(parts), 'Test')), (e) => {
    assert.ok(e instanceof LLMError);
    assert.match(e.message, /Test malformed SSE chunk/);
    return true;
  });
});
