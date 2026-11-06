// @ts-check
'use strict';

const { AuthError, ProviderError, RateLimitError } = require('../errors.js');
const { safeMsg } = require('../log-safe.js');
const { parseRetryAfter } = require('../retry.js');

/**
 * Map a failed provider response to the typed error the rest of the pipeline
 * branches on: 429 -> RateLimitError (retried, honours Retry-After), 401/403 ->
 * AuthError (exit 3), 5xx -> retryable ProviderError, other 4xx -> terminal
 * ProviderError. `status` is kept on every error so callers can still
 * soft-skip a 403 on resolve or treat 404 as "absent". The body is redacted
 * and the URL loses its query string, the one place a token could ride
 * (fetch rejects a URL with userinfo before any response exists).
 *
 * @param {{ provider: string, label: string }} origin  e.g. `{ provider: 'gitlab', label: 'GitLab' }`
 * @param {string} method
 * @param {string} url
 * @param {{ status: number, headers?: { get(name: string): string|null } }} res
 * @param {string} text  response body, already read
 */
function httpError({ provider, label }, method, url, res, text) {
  const detail = `${label} ${method} ${url.split('?')[0]} failed: ${res.status} ${safeMsg({ message: text })}`;
  if (res.status === 429) {
    return new RateLimitError(detail, {
      provider, status: 429, retryAfterMs: parseRetryAfter(res.headers?.get('retry-after')),
    });
  }
  if (res.status === 401 || res.status === 403) return new AuthError(detail, { provider, status: res.status });
  return new ProviderError(detail, { provider, status: res.status, retryable: res.status >= 500 });
}

module.exports = { httpError };
