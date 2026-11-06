// pipelines/scripts/__tests__/errors.test.js
// @ts-check
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  AIReviewError,
  ConfigError,
  ProviderError,
  AuthError,
  RateLimitError,
  LLMError,
  ValidationError,
} = require('../lib/errors.js');

describe('errors', () => {
  it('AIReviewError is an Error', () => {
    const e = new AIReviewError('boom');
    assert.ok(e instanceof Error);
    assert.equal(e.name, 'AIReviewError');
    assert.equal(e.message, 'boom');
  });

  it('ConfigError extends AIReviewError', () => {
    const e = new ConfigError('missing key');
    assert.ok(e instanceof AIReviewError);
    assert.equal(e.name, 'ConfigError');
    assert.equal(e.message, 'missing key');
  });

  it('ProviderError captures provider/status/retryable', () => {
    const e = new ProviderError('500 from azure', { provider: 'azure', status: 500, retryable: true });
    assert.equal(e.provider, 'azure');
    assert.equal(e.status, 500);
    assert.equal(e.retryable, true);
    assert.equal(e.message, '500 from azure');
  });

  it('AuthError extends ProviderError and is non-retryable', () => {
    const e = new AuthError('401', { provider: 'github', status: 401 });
    assert.ok(e instanceof ProviderError);
    assert.equal(e.retryable, false);
    assert.ok(e instanceof AIReviewError);
    assert.ok(e instanceof Error);
  });

  it('RateLimitError carries retryAfterMs', () => {
    const e = new RateLimitError('429', { provider: 'github', status: 429, retryAfterMs: 5000 });
    assert.equal(e.retryAfterMs, 5000);
    assert.equal(e.retryable, true);
    assert.ok(e instanceof ProviderError);
    assert.ok(e instanceof AIReviewError);
    assert.ok(e instanceof Error);
  });

  it('LLMError and ValidationError are AIReviewError subclasses', () => {
    assert.ok(new LLMError('bad json') instanceof AIReviewError);
    assert.ok(new ValidationError('malformed finding') instanceof AIReviewError);
    assert.ok(new LLMError('bad json') instanceof Error);
    assert.ok(new ValidationError('malformed finding') instanceof Error);
  });

  it('ProviderError.status defaults to undefined when omitted', () => {
    const e = new ProviderError('unknown', { provider: 'x' });
    assert.equal(e.status, undefined);
    assert.equal(e.retryable, false);
  });

  it('RateLimitError.retryAfterMs is undefined when omitted', () => {
    const e = new RateLimitError('429', { provider: 'github', status: 429 });
    assert.equal(e.retryAfterMs, undefined);
    assert.equal(e.retryable, true);
  });
});
