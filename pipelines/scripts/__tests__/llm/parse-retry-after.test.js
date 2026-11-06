'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseRetryAfter } = require('../../lib/retry.js');

test('parseRetryAfter: integer seconds → ms', () => {
  assert.equal(parseRetryAfter('30'), 30000);
  assert.equal(parseRetryAfter('1'), 1000);
});

test('parseRetryAfter: HTTP date → relative ms', () => {
  const future = new Date(Date.now() + 10_000).toUTCString();
  const result = parseRetryAfter(future);
  assert.ok(result >= 9000 && result <= 11000, `expected ~10000ms, got ${result}`);
});

test('parseRetryAfter: missing/empty → undefined', () => {
  assert.equal(parseRetryAfter(undefined), undefined);
  assert.equal(parseRetryAfter(null), undefined);
  assert.equal(parseRetryAfter(''), undefined);
  assert.equal(parseRetryAfter('   '), undefined);
});

test('parseRetryAfter: garbage → undefined', () => {
  assert.equal(parseRetryAfter('not-a-date'), undefined);
  assert.equal(parseRetryAfter('--5'), undefined);
});

test('parseRetryAfter: zero or past date → undefined (no zero-backoff)', () => {
  assert.equal(parseRetryAfter('0'), undefined);
  const past = new Date(Date.now() - 5000).toUTCString();
  assert.equal(parseRetryAfter(past), undefined);
});

test('parseRetryAfter: clamps huge delta-seconds to 24h to avoid setTimeout overflow', () => {
  // Node setTimeout cap is ~24.8 days (2^31-1 ms). Values past that wrap
  // and fire in ~1ms — turning a server-mandated long wait into an
  // immediate retry storm. Clamp at 24h.
  const ONE_DAY_MS = 86_400_000;
  assert.equal(parseRetryAfter('9999999999'), ONE_DAY_MS);

  const farFuture = new Date(Date.now() + 30 * ONE_DAY_MS).toUTCString();
  assert.equal(parseRetryAfter(farFuture), ONE_DAY_MS);
});
