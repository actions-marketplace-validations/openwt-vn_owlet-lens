// @ts-check
'use strict';

const KEY_QS_RE = /([?&]key=)[A-Za-z0-9_\-]+/g;
const BEARER_RE = /(Bearer\s+)[A-Za-z0-9._\-]+/gi;
const ANTHROPIC_KEY_RE = /sk-ant-[A-Za-z0-9_\-]+/g;
// DeepSeek keys are `sk-<token>` with no provider prefix. Apply
// AFTER Anthropic redaction so `sk-ant-...` is already replaced; the
// lookbehind prevents matches on partial overlaps. Character class
// includes `_` and `-` to match real-world key formats safely.
const DEEPSEEK_KEY_RE = /(?<![A-Za-z0-9_\-])sk-[A-Za-z0-9_\-]{20,}/g;
const GEMINI_KEY_RE = /AIza[0-9A-Za-z_\-]{20,}/g;

/**
 * Strip credential-shaped substrings from a value before logging.
 *
 * @param {unknown} v
 * @returns {string}
 */
function redactSecrets(v) {
  if (v == null) return '';
  let s = typeof v === 'string' ? v : String(v);
  s = s.replace(KEY_QS_RE, '$1[REDACTED]');
  s = s.replace(BEARER_RE, '$1[REDACTED]');
  s = s.replace(ANTHROPIC_KEY_RE, '[REDACTED]');
  s = s.replace(DEEPSEEK_KEY_RE, '[REDACTED]');
  s = s.replace(GEMINI_KEY_RE, '[REDACTED]');
  return s;
}

/**
 * Bounded, sanitised error-message extractor for stderr logging. Reads
 * `.message` off Errors and off plain `{ message: string }` objects (the
 * providers pass HTTP response bodies that way); anything else is stringified.
 *
 * @param {unknown} e
 * @param {number} [maxLen=200]
 * @returns {string}
 */
function safeMsg(e, maxLen = 200) {
  const m = /** @type {{ message?: unknown }} */ (e)?.message;
  const msg = typeof m === 'string' ? m : String(e ?? '');
  return redactSecrets(msg).slice(0, maxLen);
}

/**
 * Bounded stack-trace string for the "unexpected" fallback log path.
 *
 * @param {unknown} e
 * @param {number} [maxLen=2048]
 * @returns {string}
 */
function safeStack(e, maxLen = 2048) {
  const trace = e instanceof Error ? (e.stack ?? e.message ?? '') : String(e ?? '');
  return redactSecrets(trace).slice(0, maxLen);
}

/**
 * Root-cause fields for network failures. Node's fetch (undici) throws a bare
 * `TypeError: fetch failed` and hides the real reason (ENOTFOUND, ECONNREFUSED,
 * ETIMEDOUT, certificate errors, ...) on `.cause`. Walks the cause chain
 * (bounded) and returns the deepest `code` and message, sanitised. Returns an
 * empty object when there is no cause so callers can spread it into a log.
 *
 * @param {unknown} e
 * @returns {{ errCode?: string, errCause?: string }}
 */
function safeCause(e) {
  /** @type {any} */
  let cur = /** @type {any} */ (e)?.cause;
  /** @type {any} */
  let deepest = null;
  for (let depth = 0; cur && depth < 5; cur = cur.cause, depth++) deepest = cur;
  if (!deepest) return {};
  /** @type {{ errCode?: string, errCause?: string }} */
  const out = {};
  if (typeof deepest.code === 'string') out.errCode = deepest.code;
  const msg = safeMsg(deepest);
  if (msg) out.errCause = msg;
  return out;
}

module.exports = { safeMsg, safeStack, safeCause, redactSecrets };
