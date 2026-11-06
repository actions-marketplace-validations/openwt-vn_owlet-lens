'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { fingerprint, hashMessage } = require('../lib/fingerprint.js');

test('fingerprint returns 16 hex chars', () => {
  const fp = fingerprint('src/foo.ts', 42, 'security:HIGH:abc');
  assert.equal(fp.length, 16);
  assert.match(fp, /^[a-f0-9]{16}$/);
});

test('fingerprint is stable for same input', () => {
  const a = fingerprint('a.ts', 1, 'r');
  const b = fingerprint('a.ts', 1, 'r');
  assert.equal(a, b);
});

test('fingerprint differs for different file', () => {
  assert.notEqual(fingerprint('a.ts', 1, 'r'), fingerprint('b.ts', 1, 'r'));
});

test('fingerprint differs for different line', () => {
  assert.notEqual(fingerprint('a.ts', 1, 'r'), fingerprint('a.ts', 2, 'r'));
});

test('fingerprint differs for different rule', () => {
  assert.notEqual(fingerprint('a.ts', 1, 'r1'), fingerprint('a.ts', 1, 'r2'));
});

test('fingerprint matches sha256(file:line:rule)[:16]', () => {
  const expected = crypto.createHash('sha256')
    .update('a.ts:1:r').digest('hex').slice(0, 16);
  assert.equal(fingerprint('a.ts', 1, 'r'), expected);
});

test('hashMessage default length 8', () => {
  const h = hashMessage('hello');
  assert.equal(h.length, 8);
  assert.match(h, /^[a-f0-9]{8}$/);
});

test('hashMessage honors custom length', () => {
  assert.equal(hashMessage('hello', 16).length, 16);
});

test('hashMessage handles null/undefined as empty string', () => {
  assert.equal(hashMessage(null), hashMessage(''));
  assert.equal(hashMessage(undefined), hashMessage(''));
});

test('hashMessage stable for same input', () => {
  assert.equal(hashMessage('same'), hashMessage('same'));
});
