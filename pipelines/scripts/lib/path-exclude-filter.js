// @ts-check
'use strict';

const minimatch = require('minimatch');

/**
 * Normalize a user-supplied glob so directory-style patterns work as expected.
 * `dist/` or bare `dist` → `dist/**`; already-globbed patterns pass through.
 */
function normalizePattern(p) {
  const s = p.startsWith('!') ? p.slice(1) : p;
  if (!s || !s.trim()) return null;
  if (s.endsWith('/')) return `${s}**`;
  if (!s.includes('*') && !s.includes('?') && !s.includes('{')) {
    return s.includes('.') ? s : `${s}/**`;
  }
  return s;
}

/**
 * Compile an exclude-glob list into a predicate. Returns null when the list is
 * empty/unusable, so callers can skip the per-path test entirely instead of
 * running a matcher that can never match. Shared by `partitionByExclude` and
 * the import tracer, so a traced import is excluded by exactly the same globs
 * that exclude a diff.
 *
 * @param {string[]|undefined|null} excludePatterns
 * @returns {((p: string) => boolean)|null}
 */
function createExcludeMatcher(excludePatterns) {
  if (!Array.isArray(excludePatterns) || excludePatterns.length === 0) return null;
  const normalized = excludePatterns.map(normalizePattern).filter(Boolean);
  if (normalized.length === 0) return null;
  const matchers = normalized.map((p) => new minimatch.Minimatch(p, { dot: true, nocomment: true }));
  return (p) => matchers.some((m) => m.match(p));
}

/**
 * Partition diff files by exclude-glob patterns. Paths matching ANY pattern
 * in `excludePatterns` are dropped. An empty / falsy pattern list keeps
 * everything. The input array is never mutated.
 *
 * @template {{ path: string }} T
 * @param {T[]} diffs
 * @param {string[]} excludePatterns
 * @returns {{ kept: T[], skipped: string[] }}
 */
function partitionByExclude(diffs, excludePatterns) {
  const isExcluded = createExcludeMatcher(excludePatterns);
  if (!isExcluded) return { kept: [...diffs], skipped: [] };
  const kept = [];
  const skipped = [];
  for (const d of diffs) {
    if (isExcluded(d.path)) skipped.push(d.path);
    else kept.push(d);
  }
  return { kept, skipped };
}

module.exports = { partitionByExclude, createExcludeMatcher };
