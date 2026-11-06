'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { safeMsg, safeStack, safeCause } = require('../lib/log-safe.js');

test('safeMsg returns Error.message', () => {
  assert.equal(safeMsg(new Error('boom')), 'boom');
});

test('safeMsg coerces non-Error to string', () => {
  assert.equal(safeMsg('plain string'), 'plain string');
  assert.equal(safeMsg(42), '42');
  assert.equal(safeMsg(null), '');
  assert.equal(safeMsg(undefined), '');
});

test('safeMsg truncates at default 200 chars', () => {
  const long = 'x'.repeat(500);
  assert.equal(safeMsg(new Error(long)).length, 200);
});

test('safeMsg honors custom maxLen', () => {
  assert.equal(safeMsg(new Error('abcdef'), 3), 'abc');
});

test('safeMsg truncates messages containing token-like fragments', () => {
  const fakeMsg = 'auth failed at https://api.github.com/x?token=ghp_' + 'A'.repeat(300);
  const out = safeMsg(new Error(fakeMsg));
  assert.equal(out.length, 200);
  assert.ok(out.startsWith('auth failed'));
});

test('safeStack returns Error.stack', () => {
  const e = new Error('with-stack');
  assert.ok(safeStack(e).includes('with-stack'));
});

test('safeStack falls back to message when stack missing', () => {
  const e = new Error('no-stack');
  e.stack = undefined;
  assert.equal(safeStack(e), 'no-stack');
});

test('safeStack truncates at default 2048 chars', () => {
  const e = new Error('boom');
  e.stack = 'x'.repeat(5000);
  assert.equal(safeStack(e).length, 2048);
});

test('safeStack honors custom maxLen', () => {
  const e = new Error('boom');
  e.stack = 'abcdef';
  assert.equal(safeStack(e, 4), 'abcd');
});

test('safeStack handles non-Error', () => {
  assert.equal(safeStack(null), '');
  assert.equal(safeStack('raw'), 'raw');
});

const { redactSecrets } = require('../lib/log-safe.js');

test('redactSecrets: strips Gemini ?key= query param', () => {
  const out = redactSecrets('GET https://generativelanguage.googleapis.com/v1beta/models/x:generateContent?key=AIzaSy_SECRET_VALUE');
  assert.match(out, /key=\[REDACTED]/);
  assert.doesNotMatch(out, /AIzaSy_SECRET_VALUE/);
});

test('redactSecrets: strips Authorization Bearer token', () => {
  const out = redactSecrets('Authorization: Bearer sk-deepseek-abcdef1234567890');
  assert.match(out, /Bearer \[REDACTED]/);
  assert.doesNotMatch(out, /sk-deepseek-abcdef1234567890/);
});

test('redactSecrets: leaves unrelated text untouched', () => {
  const out = redactSecrets('hello world');
  assert.equal(out, 'hello world');
});

test('redactSecrets: handles non-string input', () => {
  assert.equal(redactSecrets(null), '');
  assert.equal(redactSecrets(undefined), '');
  assert.equal(redactSecrets(42), '42');
});

test('redactSecrets: redacts realistic Anthropic sk-ant-api03 token without DeepSeek double-match', () => {
  const token = 'sk-ant-api03-' + 'A'.repeat(40) + '_-Bcd';
  const out = redactSecrets(`call failed with key=${token} oops`);
  assert.doesNotMatch(out, new RegExp(token.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')));
  assert.match(out, /\[REDACTED]/);
});

test('redactSecrets: redacts DeepSeek-shaped sk- token containing _ and -', () => {
  const token = 'sk-ds_abcdefghijk-LMNOP_qrstuv';
  const out = redactSecrets(`auth: ${token}`);
  assert.doesNotMatch(out, new RegExp(token.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')));
  assert.match(out, /\[REDACTED]/);
});

test('safeCause surfaces the root code and message behind "fetch failed"', () => {
  const root = Object.assign(new Error('getaddrinfo ENOTFOUND api.modelstack.cc'), { code: 'ENOTFOUND' });
  const err = new TypeError('fetch failed', { cause: root });
  assert.deepEqual(safeCause(err), {
    errCode: 'ENOTFOUND',
    errCause: 'getaddrinfo ENOTFOUND api.modelstack.cc',
  });
});

test('safeCause walks nested causes to the deepest one', () => {
  const inner = Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:443'), { code: 'ECONNREFUSED' });
  const mid = new Error('mid', { cause: inner });
  assert.equal(safeCause(new TypeError('fetch failed', { cause: mid })).errCode, 'ECONNREFUSED');
});

test('safeCause is empty without a cause and redacts secrets', () => {
  assert.deepEqual(safeCause(new Error('plain')), {});
  assert.deepEqual(safeCause(undefined), {});
  const err = new Error('x', { cause: new Error('Bearer abc123.def') });
  assert.equal(safeCause(err).errCause, 'Bearer [REDACTED]');
});
