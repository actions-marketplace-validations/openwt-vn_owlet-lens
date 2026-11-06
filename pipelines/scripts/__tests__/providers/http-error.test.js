'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { httpError } = require('../../lib/providers/http-error.js');
const { AuthError, ProviderError, RateLimitError } = require('../../lib/errors.js');

const ORIGIN = { provider: 'gitlab', label: 'GitLab' };
const URL_ = 'https://gitlab.example/api/v4/projects/1';

/** @param {number} status @param {Record<string, string>} [headers] */
function res(status, headers) {
  return headers ? { status, headers: { get: (h) => headers[h] ?? null } } : { status };
}

test('httpError: 429 -> RateLimitError honouring delta-seconds Retry-After', () => {
  const e = httpError(ORIGIN, 'GET', URL_, res(429, { 'retry-after': '7' }), '');
  assert.ok(e instanceof RateLimitError);
  assert.equal(e.retryAfterMs, 7000);
  assert.equal(e.retryable, true);
});

test('httpError: 429 with HTTP-date Retry-After -> relative ms', () => {
  const date = new Date(Date.now() + 30_000).toUTCString();
  const e = httpError(ORIGIN, 'GET', URL_, res(429, { 'retry-after': date }), '');
  assert.ok(e.retryAfterMs > 20_000 && e.retryAfterMs <= 30_000, `got ${e.retryAfterMs}`);
});

test('httpError: 429 without headers -> RateLimitError, default backoff', () => {
  const e = httpError(ORIGIN, 'GET', URL_, res(429), '');
  assert.ok(e instanceof RateLimitError);
  assert.equal(e.retryAfterMs, undefined);
});

test('httpError: 401 and 403 -> non-retryable AuthError', () => {
  for (const status of [401, 403]) {
    const e = httpError(ORIGIN, 'GET', URL_, res(status), '');
    assert.ok(e instanceof AuthError);
    assert.equal(e.status, status);
    assert.equal(e.retryable, false);
  }
});

test('httpError: 5xx is retryable, other 4xx is terminal', () => {
  const e502 = httpError(ORIGIN, 'POST', URL_, res(502), '');
  assert.ok(e502 instanceof ProviderError && !(e502 instanceof AuthError));
  assert.equal(e502.retryable, true);
  const e404 = httpError(ORIGIN, 'GET', URL_, res(404), '');
  assert.equal(e404.retryable, false);
  assert.equal(e404.status, 404);
});

test('httpError: message names origin, method, url and status; body is redacted', () => {
  const e = httpError(ORIGIN, 'GET', URL_, res(500), 'echo Bearer abc.def-123');
  assert.equal(e.message, `GitLab GET ${URL_} failed: 500 echo Bearer [REDACTED]`);
  assert.equal(e.provider, 'gitlab');
});

test('httpError: query string is dropped from the message (a token could ride there)', () => {
  const e = httpError(ORIGIN, 'GET', `${URL_}?private_token=s3cret&page=2`, res(500), '');
  assert.equal(e.message, `GitLab GET ${URL_} failed: 500 `);
});
