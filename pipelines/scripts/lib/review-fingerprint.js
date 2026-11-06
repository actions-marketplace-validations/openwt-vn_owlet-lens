// @ts-check
'use strict';

const crypto = require('node:crypto');
const { partitionReviewable } = require('./reviewable-files.js');

/**
 * Review fingerprint (CONTEXT.md): one hash of everything a review pass's
 * outcome depends on that a push can change — the PR's own changes, the config
 * and the prompt's documents (coding standards, learned suppressions,
 * `review.contextPaths` files). Two runs with the same fingerprint would send
 * the LLM the same work, except traced import bodies, so the second one can be
 * skipped (ADR-0015).
 *
 * Traced imports are left out on purpose: a merge from the target usually
 * changes files the PR imports, and hashing them would stop the skip firing in
 * exactly the merge-from-target case it exists for (accepted risk, ADR-0015).
 *
 * Bumped when the hashed shape changes, so an old marker never matches.
 */
const FINGERPRINT_VERSION = 1;
const FINGERPRINT_HEX_LENGTH = 32;

/**
 * The PR's own changes in one file's patch: added and removed lines, in order.
 * Hunk headers and context lines are dropped on purpose — a merge from the
 * target branch shifts both without changing what the PR itself changed.
 * Anything before the first hunk is a file header (`--- a/x`, `+++ b/x`), so a
 * removed line that happens to start with `--` is still counted after it.
 *
 * @param {string} patch
 * @returns {{ added: string[], removed: string[] }}
 */
function normalizePatch(patch) {
  const added = [];
  const removed = [];
  let inHunk = false;
  for (const line of String(patch ?? '').split('\n')) {
    if (line.startsWith('@@')) { inHunk = true; continue; }
    if (!inHunk) continue;
    if (line.startsWith('+')) added.push(line.slice(1));
    else if (line.startsWith('-')) removed.push(line.slice(1));
  }
  return { added, removed };
}

/**
 * JSON with object keys sorted at every level, so a reordered YAML file hashes
 * the same.
 *
 * @param {unknown} value
 * @returns {string}
 */
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.keys(value).sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(/** @type {Record<string, unknown>} */ (value)[k])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * @param {{
 *   diffs: Array<{ path: string, change: string, patch: string, oldPath?: string }>,
 *   config: { auth?: unknown, paths?: { exclude?: string[] }, review: { maxFileBytes?: number|null, skipGeneratedFiles?: boolean } },
 *   standards: unknown,
 * }} input `config` is the effective config; `auth` is left out so a rotated
 *   key does not force a review. `standards` is the non-diff prompt inputs
 *   that are documents: coding standards, learned suppressions and
 *   `review.contextPaths` documents. Traced imports do not belong here (see
 *   module doc).
 * @returns {string} lowercase hex, {@link FINGERPRINT_HEX_LENGTH} chars — the
 *   key-marker grammar (`[a-z][a-z0-9-]*`) takes it as a `reviewed-<hex>` key.
 */
function computeReviewFingerprint({ diffs, config, standards }) {
  const { kept } = partitionReviewable(diffs, { excludePaths: config.paths?.exclude, review: config.review });
  const files = kept
    .map((d) => ({ path: d.path, change: d.change, oldPath: d.oldPath ?? null, ...normalizePatch(d.patch) }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const { auth: _auth, ...configWithoutAuth } = config;
  const payload = stableStringify({ v: FINGERPRINT_VERSION, files, config: configWithoutAuth, standards });
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, FINGERPRINT_HEX_LENGTH);
}

module.exports = { computeReviewFingerprint, normalizePatch };
