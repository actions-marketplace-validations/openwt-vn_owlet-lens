// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { redactDiffSecrets } = require('./diff-secret-redact.js');
const { createExcludeMatcher } = require('./path-exclude-filter.js');

const IMPORT_PATTERNS = [
  // ES import: import ... from './foo'
  /from\s+['"]([^'"]+)['"]/g,
  // require(): require('./foo')
  /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

const RESOLVE_EXTENSIONS = ['.js', '.ts', '.tsx', '.jsx', '.mjs', '.cjs', '.py', '.go', '.java', '.rs'];

/**
 * Extract import/require specifiers from a diff patch string. Only looks
 * at added lines (+) so we trace what the new code depends on, not removed deps.
 * Skips comment lines (// and * prefixed) to reduce false positives.
 *
 * @param {string} patch
 * @returns {string[]} raw specifiers (may be relative, package, or stdlib)
 */
function extractImportPaths(patch) {
  if (!patch) return [];
  const addedLines = patch
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .map((l) => l.slice(1))
    .filter((l) => {
      const trimmed = l.trimStart();
      return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('#');
    });
  const text = addedLines.join('\n');
  const seen = new Set();
  for (const re of IMPORT_PATTERNS) {
    const pattern = new RegExp(re.source, re.flags);
    let m;
    while ((m = pattern.exec(text)) !== null) {
      const spec = m[1];
      if (spec && !seen.has(spec)) seen.add(spec);
    }
  }
  return [...seen];
}

/**
 * Check that resolved path is safely within repo root.
 * @param {string} resolved - absolute path
 * @param {string} absRoot - absolute repo root
 * @returns {boolean}
 */
function isInsideRepo(resolved, absRoot) {
  try {
    const real = fs.realpathSync(resolved);
    const realRoot = fs.realpathSync(absRoot);
    return real.startsWith(realRoot + path.sep) || real === realRoot;
  } catch {
    const rel = path.relative(absRoot, resolved);
    return !rel.startsWith('..') && !path.isAbsolute(rel);
  }
}

/**
 * Resolve a relative import specifier to an absolute file path, trying
 * common extensions. Returns null if unresolvable (package imports, stdlib,
 * absolute paths, or paths escaping the repo root).
 *
 * @param {string} specifier
 * @param {string} fromFile - repo-relative path of the importing file
 * @param {string} repoRoot - absolute path to the repo checkout
 * @returns {string|null} repo-relative path or null
 */
function resolveImport(specifier, fromFile, repoRoot) {
  if (!specifier.startsWith('.')) return null;

  const dir = path.dirname(path.join(repoRoot, fromFile));
  const base = path.resolve(dir, specifier);
  const absRoot = path.resolve(repoRoot);

  if (!isInsideRepo(base, absRoot)) return null;

  if (path.extname(base) && RESOLVE_EXTENSIONS.includes(path.extname(base)) && fs.existsSync(base)) {
    return path.relative(repoRoot, base).replace(/\\/g, '/');
  }

  for (const ext of RESOLVE_EXTENSIONS) {
    const candidate = base + ext;
    if (fs.existsSync(candidate) && isInsideRepo(candidate, absRoot)) {
      return path.relative(repoRoot, candidate).replace(/\\/g, '/');
    }
  }

  for (const ext of RESOLVE_EXTENSIONS) {
    const candidate = path.join(base, `index${ext}`);
    if (fs.existsSync(candidate) && isInsideRepo(candidate, absRoot)) {
      return path.relative(repoRoot, candidate).replace(/\\/g, '/');
    }
  }

  return null;
}

/**
 * For a set of diff files, extract imports from their patches, resolve to
 * repo files, read content, and return as context entries. Deduplicates and
 * skips files that are already in the diff set or that `paths.exclude` keeps
 * out of the review.
 *
 * Traced file bodies go through the same `redactDiffSecrets` (SEC-4) pass as
 * the diffs they ride next to, so a secret hidden from the review prompt
 * cannot reappear via an import. The redactor is the diff one, not the log
 * one: it also covers token prefixes (ghp_/glpat-/AKIA/xox*), key=value
 * assignments, connection-string credentials and PEM blocks.
 *
 * `totalRedacted` counts the files actually read - i.e. the returned
 * `imports`. When `maxFiles` stops the scan early, the files never read were
 * never redacted either, so the count describes exactly the payload that was
 * sent.
 *
 * @param {{ path: string, patch?: string }[]} diffs
 * @param {string} repoRoot
 * @param {{ maxFiles?: number, maxBytesPerFile?: number, excludePatterns?: string[] }} [opts]
 * @returns {{ imports: { path: string, content: string }[], totalRedacted: number, excluded: string[] }}
 */
function traceImports(diffs, repoRoot, opts = {}) {
  const maxFiles = opts.maxFiles ?? 10;
  const maxBytesPerFile = opts.maxBytesPerFile ?? 32_000;
  const isExcluded = createExcludeMatcher(opts.excludePatterns);
  const changedPaths = new Set(diffs.map((d) => d.path));
  const seen = new Set();
  const result = [];
  /** @type {string[]} */
  const excluded = [];
  let totalRedacted = 0;

  for (const d of diffs) {
    const specifiers = extractImportPaths(d.patch);
    for (const spec of specifiers) {
      const resolved = resolveImport(spec, d.path, repoRoot);
      if (!resolved || changedPaths.has(resolved) || seen.has(resolved)) continue;
      seen.add(resolved);

      if (isExcluded && isExcluded(resolved)) {
        excluded.push(resolved);
        continue;
      }

      const absPath = path.join(repoRoot, resolved);
      try {
        const stat = fs.statSync(absPath);
        if (stat.size > maxBytesPerFile) continue;
        const { redacted, count } = redactDiffSecrets(fs.readFileSync(absPath, 'utf8'));
        totalRedacted += count;
        result.push({ path: resolved, content: redacted });
        if (result.length >= maxFiles) return { imports: result, totalRedacted, excluded };
      } catch { /* unreadable — skip */ }
    }
  }

  return { imports: result, totalRedacted, excluded };
}

/**
 * Build an undirected import graph among the files in a diff set. Uses only
 * diff patches (no fs). A relative specifier from file A is resolved
 * heuristically against the diff set paths (with RESOLVE_EXTENSIONS).
 *
 * @param {{ path: string, patch?: string }[]} diffs
 * @returns {Map<string, Set<string>>}
 */
function buildImportGraph(diffs) {
  const diffPaths = new Set(diffs.map((d) => d.path));
  /** @type {Map<string, Set<string>>} */
  const graph = new Map();
  const ensure = (/** @type {string} */ p) => { if (!graph.has(p)) graph.set(p, new Set()); };

  for (const d of diffs) {
    if (!d.patch) continue;
    const specifiers = extractImportPaths(d.patch);
    const fromDir = path.posix.dirname(d.path.replace(/\\/g, '/'));
    for (const spec of specifiers) {
      if (!spec.startsWith('.')) continue;
      const joined = path.posix.normalize(fromDir + '/' + spec).replace(/\\/g, '/');
      const target = resolveInDiffSet(joined, diffPaths);
      if (target && target !== d.path) {
        ensure(d.path); ensure(target);
        graph.get(d.path).add(target);
        graph.get(target).add(d.path);
      }
    }
  }
  return graph;
}

/**
 * Match a normalized specifier (no extension) against the diff set, trying
 * each known extension. Returns the matching diff path or null.
 *
 * @param {string} base - normalized posix path without extension
 * @param {Set<string>} diffPaths
 * @returns {string|null}
 */
function resolveInDiffSet(base, diffPaths) {
  if (diffPaths.has(base)) return base;
  for (const ext of RESOLVE_EXTENSIONS) {
    if (diffPaths.has(base + ext)) return base + ext;
  }
  return null;
}

module.exports = { extractImportPaths, resolveImport, traceImports, buildImportGraph };
