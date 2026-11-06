// @ts-check
'use strict';

const { RateLimitError, ProviderError } = require('./errors.js');
const { logWarn } = require('./log-helpers.js');
const { redactSecrets } = require('./log-safe.js');

// A single wait never exceeds this; a server asking for longer fails the call.
const MAX_WAIT_MS = 60_000;

// Socket errors raised before the request left the machine. Only these, or a
// rate-limit refusal, prove a create (POST) was not applied (ADR-0013).
const NOT_SENT_CODE_RE = /^(ECONNREFUSED|ENOTFOUND|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT)$/;

function isFetchTransportError(err) {
  const code = err?.code ?? err?.cause?.code;
  if (typeof code === 'string' && /^(UND_ERR_|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EPIPE|ENOTFOUND|EAI_AGAIN)$/.test(code)) {
    return true;
  }
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') return true;
  return err instanceof TypeError && /fetch failed|network|terminated|timeout/i.test(err.message || '');
}

function isRetryable(err) {
  if (err instanceof RateLimitError) return true;
  if (err instanceof ProviderError) return err.retryable === true;
  if (isFetchTransportError(err)) return true;
  // Anthropic SDK / Octokit-style status codes
  const s = err?.status ?? err?.statusCode;
  if (s === 429 || s === 529) return true;
  if (typeof s === 'number' && s >= 500 && s < 600) return true;
  return false;
}

function backoffMs(attempt) {
  // attempt 0..2 → 1s, 4s, 16s; attempt ≥3 caps at 60s.
  return Math.min(60_000, 1000 * Math.pow(4, attempt));
}

/**
 * Parse a Retry-After header value. RFC 7231 allows either delta-seconds
 * (e.g. "30") or HTTP-date (e.g. "Wed, 21 Oct 2015 07:28:00 GMT"). Returns
 * the relative wait in milliseconds, or undefined if the header is missing
 * or malformed. Negative/zero values clamp to undefined so a stale header
 * cannot zero out the backoff.
 *
 * @param {string|null|undefined} raw
 * @returns {number|undefined}
 */
function parseRetryAfter(raw) {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  if (/^\d+$/.test(trimmed)) {
    const secs = Number(trimmed);
    return secs > 0 ? Math.min(secs * 1000, 86_400_000) : undefined;
  }
  const t = Date.parse(trimmed);
  if (Number.isNaN(t)) return undefined;
  const delta = t - Date.now();
  return delta > 0 ? Math.min(delta, 86_400_000) : undefined;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * True when the server provably did not apply the request: it refused it
 * (rate limit), or the connection never opened. Walks the `cause` chain,
 * since fetch and the typed provider errors wrap the socket error.
 *
 * @param {any} err
 * @returns {boolean}
 */
function notApplied(err) {
  if (err instanceof RateLimitError) return true;
  for (let e = err, depth = 0; e && depth < 5; e = e.cause, depth++) {
    if (typeof e.code === 'string' && NOT_SENT_CODE_RE.test(e.code)) return true;
  }
  return false;
}

/**
 * @typedef {object} RetryOptions
 * @property {number} [maxAttempts] Attempts in total, including the first (default 5).
 * @property {string} [label] Names the call in the retry log line.
 * @property {boolean} [repeatable] False for a create: it is then repeated only
 *   when the server provably did not apply it (default true).
 * @property {(ms: number) => Promise<void>} [sleep] Test seam for the backoff wait.
 */

/**
 * @template T
 * @param {() => Promise<T>} fn
 * @param {RetryOptions} [opts]
 * @returns {Promise<T>}
 */
async function withRetry(fn, opts = {}) {
  const max = opts.maxAttempts ?? 5;
  const repeatable = opts.repeatable ?? true;
  const pause = opts.sleep ?? sleep;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= max || !isRetryable(e) || !(repeatable || notApplied(e))) throw e;
      const wait = e instanceof RateLimitError && e.retryAfterMs ? e.retryAfterMs : backoffMs(attempt - 1);
      if (wait > MAX_WAIT_MS) throw e;
      logWarn('retry', {
        label: opts.label && redactSecrets(opts.label),
        attempt, waitMs: wait, errName: e?.name, errStatus: e?.status,
      });
      await pause(wait);
    }
  }
}

/**
 * Retry options for one HTTP request. The label is the method and the URL
 * path (no host, no query string). A POST is a create unless the call site
 * opts in with `idempotent`; every other method repeats freely.
 *
 * @param {string} method
 * @param {string} url
 * @param {{ idempotent?: boolean, sleep?: (ms: number) => Promise<void> }} [opts]
 * @returns {RetryOptions}
 */
function requestRetry(method, url, { idempotent = false, sleep: pause } = {}) {
  const verb = method.toUpperCase();
  const path = String(url).replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, '').split('?')[0];
  return { label: `${verb} ${path}`, repeatable: verb !== 'POST' || idempotent, sleep: pause };
}

module.exports = { withRetry, requestRetry, isRetryable, backoffMs, isFetchTransportError, parseRetryAfter };
