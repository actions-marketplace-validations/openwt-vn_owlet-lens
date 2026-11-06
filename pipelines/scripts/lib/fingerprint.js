// @ts-check
'use strict';

const crypto = require('node:crypto');

/**
 * Stable 16-hex-char content hash for a finding location + rule.
 * Used by both `review-state.reconcilePort` (core) and the GitHub/Azure
 * adapters (markers) so the same finding produces the same fingerprint
 * across runs and providers.
 *
 * @param {string} filePath
 * @param {number} line
 * @param {string} rule
 * @returns {string}
 */
function fingerprint(filePath, line, rule) {
  return crypto
    .createHash('sha256')
    .update(`${filePath}:${line}:${rule}`)
    .digest('hex')
    .slice(0, 16);
}

/**
 * SHA-256 hash of an arbitrary message string. Used by ai-review.js to
 * disambiguate distinct findings at the same file:line:category:severity.
 * Centralised here so all hashing strategy lives in one module.
 *
 * @param {string} msg
 * @param {number} [len=8]
 * @returns {string} hex digest truncated to `len` chars
 */
function hashMessage(msg, len = 8) {
  return crypto
    .createHash('sha256')
    .update(String(msg ?? ''))
    .digest('hex')
    .slice(0, len);
}

module.exports = { fingerprint, hashMessage };
