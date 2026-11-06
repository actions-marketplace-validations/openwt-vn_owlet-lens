// @ts-check
'use strict';

const VERSION = 'v1';

// Cache compiled regexes per (style, prefix). parseMarkers is called once per comment
// per thread per listThreads call — caching avoids re-escaping + re-compiling.
/** @type {Map<string, { statusRe: RegExp, fpRe: RegExp, anyRe: RegExp }>} */
const REGEX_CACHE = new Map();

/**
 * @param {string} prefix
 * @param {'html'|'both'} [style] 'html' restricts to HTML-comment markers
 *   (GitHub, where the bot only ever emits HTML and humans can freely type
 *   inline-code backticks); 'both' (default) also accepts the inline-code form
 *   (Bitbucket, whose wire style may mix HTML + inline-code across runs).
 * @returns {{ statusRe: RegExp, fpRe: RegExp, anyRe: RegExp }}
 */
function getRegexes(prefix, style = 'both') {
  const cacheKey = `${style}\0${prefix}`;
  const cached = REGEX_CACHE.get(cacheKey);
  if (cached) return cached;
  const escaped = prefix.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  // Match the delimiter form(s) for this provider:
  //   HTML:        <!-- ai-review:v1:active -->
  //   inline-code: `ai-review:v1:active`
  // GitHub uses HTML only; broadening it to inline-code on GitHub would let a
  // human-typed backtick marker be parsed as a real bot marker. Bitbucket keeps
  // both forms so a cross-run style mix still reconciles.
  const open = style === 'html' ? '<!--\\s*' : '(?:<!--\\s*|`)';
  const close = style === 'html' ? '\\s*-->' : '(?:\\s*-->|`)';
  const compiled = {
    statusRe: new RegExp(
      `${open}${escaped}:(v\\d+):(active|fixed|wontfix|resolved|closed)${close}`,
      'g',
    ),
    fpRe: new RegExp(
      `${open}${escaped}:fingerprint=([a-f0-9]+)${close}`,
      'g',
    ),
    // Any marker our bot stamps: a versioned key (`v1:active`, `v1:summary`,
    // …) or a fingerprint. Used as a stateless "is this our comment" signal
    // where the author identity isn't available (see hasMarker).
    anyRe: new RegExp(
      `${open}${escaped}:(?:v\\d+:[a-z][a-z0-9-]*|fingerprint=[a-f0-9]+)${close}`,
    ),
  };
  REGEX_CACHE.set(cacheKey, compiled);
  return compiled;
}

/**
 * Parse status + fingerprint markers from a comment body. Reads both the
 * HTML-comment (GitHub) and inline-code (Bitbucket) forms.
 *
 * @param {string} body
 * @param {string} prefix
 * @param {'html'|'both'} [style] see getRegexes; defaults to 'both'.
 * @returns {{
 *   status: 'active'|'fixed'|'wontfix'|'resolved'|'closed'|null,
 *   version: string|null,
 *   fingerprint: string|null,
 * }}
 */
function parseMarkers(body, prefix, style = 'both') {
  /** @type {{ status: 'active'|'fixed'|'wontfix'|'resolved'|'closed'|null, version: string|null, fingerprint: string|null }} */
  const result = { status: null, version: null, fingerprint: null };
  if (typeof body !== 'string' || body.length === 0) return result;

  const { statusRe, fpRe } = getRegexes(prefix, style);
  // Reset lastIndex — cached regexes carry state from prior exec() calls.
  statusRe.lastIndex = 0;
  fpRe.lastIndex = 0;

  let m;
  while ((m = statusRe.exec(body)) !== null) {
    result.version = m[1];
    // Regex capture group 2 is constrained to the status union by construction.
    result.status = /** @type {'active'|'fixed'|'wontfix'|'resolved'|'closed'} */ (m[2]);
  }
  // Last-wins for fingerprint, mirroring status semantics.
  let lastFp = null;
  while ((m = fpRe.exec(body)) !== null) lastFp = m[1];
  result.fingerprint = lastFp;

  return result;
}

/**
 * @param {{
 *   prefix: string,
 *   status: 'active'|'fixed'|'wontfix'|'resolved'|'closed',
 *   fingerprintHash?: string,
 *   style?: 'html'|'bitbucket',
 * }} opts
 */
function serializeMarker({ prefix, status, fingerprintHash, style = 'html' }) {
  if (style === 'bitbucket') {
    const parts = [`\`${prefix}:${VERSION}:${status}\``];
    if (fingerprintHash) parts.push(`\`${prefix}:fingerprint=${fingerprintHash}\``);
    return parts.join(' ');
  }
  const lines = [`<!-- ${prefix}:${VERSION}:${status} -->`];
  if (fingerprintHash) {
    lines.push(`<!-- ${prefix}:fingerprint=${fingerprintHash} -->`);
  }
  return lines.join('\n');
}

/**
 * Serialize a bare key marker (e.g. `summary`) in the given wire style. Unlike
 * `serializeMarker` (status + fingerprint), this stamps a single versioned key
 * marker — used for the PR-level summary comment.
 *
 * @param {{ prefix: string, key: string, style?: 'html'|'bitbucket' }} opts
 * @returns {string}
 */
function serializeKeyMarker({ prefix, key, style = 'html' }) {
  return style === 'bitbucket'
    ? `\`${prefix}:${VERSION}:${key}\``
    : `<!-- ${prefix}:${VERSION}:${key} -->`;
}

/**
 * Rewrite every HTML-comment key marker (`<!-- prefix:vN:key -->`) in a body
 * into the target wire `style`. Bitbucket renders HTML comments as visible
 * text, so summary bodies built with the HTML marker must be restyled to the
 * inline-code form to stay tidy and consistent with findings/replies. No-op
 * for `style: 'html'`. Only touches key markers, not fingerprint markers.
 *
 * @param {string} body
 * @param {string} prefix
 * @param {'html'|'bitbucket'} style
 * @returns {string}
 */
function restyleKeyMarkers(body, prefix, style) {
  if (style === 'html' || typeof body !== 'string' || body.length === 0) return body;
  const escaped = prefix.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  const re = new RegExp(`<!--\\s*${escaped}:(v\\d+):([a-z][a-z0-9-]*)\\s*-->`, 'g');
  return body.replace(re, (_m, _ver, key) => serializeKeyMarker({ prefix, key, style }));
}

/**
 * True when a body carries any marker this bot stamps (a versioned key such as
 * a status or `summary`, or a fingerprint), in either wire form. Lets a
 * provider recognise its own comments without relying on author identity —
 * which Bitbucket repository/workspace access tokens don't expose at read time.
 *
 * @param {string} body
 * @param {string} prefix
 * @returns {boolean}
 */
function hasMarker(body, prefix) {
  if (typeof body !== 'string' || body.length === 0) return false;
  return getRegexes(prefix).anyRe.test(body);
}

module.exports = {
  parseMarkers, serializeMarker, serializeKeyMarker, restyleKeyMarkers, hasMarker, VERSION,
  __test__: { getRegexes },
};
