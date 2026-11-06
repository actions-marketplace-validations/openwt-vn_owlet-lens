// @ts-check
'use strict';

const path = require('node:path');
const { CONFIG, rankSeverity } = require('./config.js');
const { buildImportGraph, extractImportPaths } = require('./import-tracer.js');

function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / CONFIG.charsPerToken);
}

// Per-finding caps inside the summary. Keeps one pathological finding from
// consuming the whole budget and starving the remaining findings.
const SUMMARY_MESSAGE_CHARS = 160;
const SUMMARY_FIELD_CHARS = 200;

/** Truncate `text` to `max` chars, marking the cut with an ellipsis. */
function capText(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// The delimiter the summary is wrapped in (prompt-builder.js). Finding text is
// untrusted LLM output, so any occurrence of these tags inside a field is
// stripped — otherwise a crafted finding could close the block early and inject
// directives into later chunk prompts.
const SUMMARY_TAG_RE = /<\/?\s*already_found_findings\s*>/gi;

/**
 * Remove the <already_found_findings> delimiter from untrusted text. Exported
 * so prompt-builder reuses the same definition instead of duplicating the
 * literal regex.
 *
 * @param {string} text
 */
function stripSummaryTags(text) {
  return String(text ?? '').replace(SUMMARY_TAG_RE, '');
}

/** Collapse a field to one safe, delimiter-free line. */
function sanitizeField(value) {
  return stripSummaryTags(value).replace(/\s+/g, ' ').trim();
}

/**
 * Normalize a raw finding (`file`/`line`/`message`) to the fields the
 * summary renders. Every field is neutralized before it reaches the prompt:
 * `file`/`category`/`severity`/`message` are collapsed to one delimiter-free
 * line and length-capped so a single pathological field cannot blow the whole
 * summary budget, and `line` is coerced to a finite integer — a string `line`
 * containing a newline or a closing tag could otherwise forge an extra line or
 * break out of the <already_found_findings> block.
 *
 * @param {any} f
 */
function normalizeFinding(f) {
  return {
    file: capText(sanitizeField(f.file) || '(unknown)', SUMMARY_FIELD_CHARS),
    line: Number.isFinite(+f.line) ? Math.trunc(+f.line) : 0,
    severity: capText(sanitizeField(f.severity).toUpperCase() || 'UNKNOWN', SUMMARY_FIELD_CHARS),
    category: capText(sanitizeField(f.category) || 'unknown', SUMMARY_FIELD_CHARS),
    message: capText(sanitizeField(f.message), SUMMARY_MESSAGE_CHARS),
  };
}

/**
 * Compress prior findings into a compact, token-bounded list for injection
 * into the next chunk's prompt. One line per distinct `file:line:category`
 * (the category is reconcile's ruleId, severity is deliberately excluded so
 * re-graded findings still dedupe) so the model sees what was already
 * reported and stops duplicating it.
 *
 * When the budget cannot hold every finding, lines are dropped from the tail
 * and an omission note is appended, still within the budget. Findings are
 * ordered by severity first (matching Alibaba's compression prompt and
 * `truncateFindings`), so a tight budget drops LOW noise, never a CRITICAL.
 *
 * @param {Array<any>} findings
 * @param {{ maxTokens?: number, charsPerToken?: number }} [opts]
 * @returns {string} summary text, or '' when there is nothing to summarize
 */
function summarizeFindings(findings, opts = {}) {
  if (!Array.isArray(findings) || findings.length === 0) return '';
  const maxTokens = opts.maxTokens ?? CONFIG.chunkFindingsSummaryTokens;
  const charsPerToken = opts.charsPerToken ?? CONFIG.charsPerToken;
  const maxChars = maxTokens * charsPerToken;

  const ordered = findings
    .filter(Boolean)
    .map(normalizeFinding)
    .sort((a, b) => rankSeverity(b.severity) - rankSeverity(a.severity));

  const seen = new Set();
  const lines = [];
  for (const n of ordered) {
    const key = `${n.file}:${n.line}:${n.category}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`- [${n.severity}/${n.category}] ${n.file}:${n.line} — ${n.message}`);
  }
  if (lines.length === 0) return '';

  // Track the joined length incrementally. Recomputing join().length after
  // each single pop was O(n^2) on large finding sets.
  let total = lines.reduce((sum, line, i) => sum + line.length + (i > 0 ? 1 : 0), 0);
  let omitted = 0;
  while (lines.length > 0 && total > maxChars) {
    const dropped = lines.pop() ?? '';
    total -= dropped.length + (lines.length > 0 ? 1 : 0);
    omitted += 1;
  }
  if (lines.length === 0) return '';
  if (omitted === 0) return lines.join('\n');

  let note = `\n- (+${omitted} more findings not shown)`;
  while (lines.length > 0 && total + note.length > maxChars) {
    const dropped = lines.pop() ?? '';
    total -= dropped.length + (lines.length > 0 ? 1 : 0);
    omitted += 1;
    note = `\n- (+${omitted} more findings not shown)`;
  }
  if (lines.length === 0) return '';
  return lines.join('\n') + note;
}

/** @param {{ filePath: string, annotatedDiff: string }} f */
function fileTokens(f) {
  return estimateTokens(f.annotatedDiff) + estimateTokens(f.filePath) + 10;
}

const TEST_RE = /(?:\.test\.|\.spec\.|__tests__\/)/;

/**
 * Strip test markers from a path to get the "impl identity" for pairing.
 * `src/__tests__/foo.test.js` → `src/foo.js` (basename + parent dir).
 * @param {string} p
 * @returns {{ dir: string, base: string } | null}
 */
function implIdentity(p) {
  if (!TEST_RE.test(p)) return null;
  const posix = p.replace(/\\/g, '/');
  const base = path.posix.basename(posix).replace(/\.(test|spec)\./, '.');
  const dir = path.posix.dirname(posix).replace(/\/?__tests__\/?/, '/').replace(/\/+/g, '/').replace(/\/$/, '') || '.';
  return { dir, base };
}

/**
 * Build semantic file groups from import relationships and test+impl pairing.
 * Returns groups as arrays of fileDiff objects, sorted largest-first for
 * better bin-packing. Ungrouped files become singleton arrays.
 *
 * @param {{ path: string, patch?: string }[]} diffs  full PR diffs (for complete import graph)
 * @param {{ filePath: string, annotatedDiff: string }[]} fileDiffs  overflow files to partition
 * @returns {{ filePath: string, annotatedDiff: string }[][]}
 */
function buildFileGroups(diffs, fileDiffs) {
  const overflowPaths = new Set(fileDiffs.map((f) => f.filePath));
  const fileMap = new Map(fileDiffs.map((f) => [f.filePath, f]));

  // Build adjacency from import graph (edges between overflow files only)
  const importGraph = buildImportGraph(diffs);
  /** @type {Map<string, Set<string>>} */
  const adj = new Map();
  const ensure = (/** @type {string} */ p) => { if (!adj.has(p)) adj.set(p, new Set()); };

  for (const p of overflowPaths) {
    ensure(p);
    const neighbors = importGraph.get(p);
    if (neighbors) {
      for (const n of neighbors) {
        if (overflowPaths.has(n)) { ensure(n); adj.get(p).add(n); adj.get(n).add(p); }
      }
    }
  }

  // Add test+impl pairing edges
  const testFiles = [];
  const implFiles = [];
  for (const p of overflowPaths) {
    if (TEST_RE.test(p)) testFiles.push(p);
    else implFiles.push(p);
  }
  for (const t of testFiles) {
    const id = implIdentity(t);
    if (!id) continue;
    for (const impl of implFiles) {
      const implPosix = impl.replace(/\\/g, '/');
      const implBase = path.posix.basename(implPosix);
      const implDir = path.posix.dirname(implPosix);
      // ponytail: sibling/parent match only — no child-dir or cross-tree matching
      if (implBase === id.base && (implDir === id.dir || id.dir.startsWith(implDir + '/'))) {
        ensure(t); ensure(impl);
        adj.get(t).add(impl); adj.get(impl).add(t);
      }
    }
  }

  // BFS to find connected components
  const visited = new Set();
  const groups = [];
  for (const p of overflowPaths) {
    if (visited.has(p)) continue;
    const component = [];
    const queue = [p];
    visited.add(p);
    while (queue.length > 0) {
      const cur = queue.shift();
      component.push(fileMap.get(cur));
      for (const n of (adj.get(cur) ?? [])) {
        if (!visited.has(n)) { visited.add(n); queue.push(n); }
      }
    }
    groups.push(component);
  }

  // Sort largest group first for better bin-packing
  groups.sort((a, b) => {
    const ta = a.reduce((s, f) => s + fileTokens(f), 0);
    const tb = b.reduce((s, f) => s + fileTokens(f), 0);
    return tb - ta;
  });

  return groups;
}

/**
 * Partition file diffs into chunks that each fit within `tokenBudget`
 * (minus `reservedTokens` for the system prompt). When `groups` is provided,
 * tries to keep grouped files in the same chunk; falls back to splitting
 * groups that exceed the budget.
 *
 * @param {{ filePath: string, annotatedDiff: string }[]} fileDiffs
 * @param {{ tokenBudget?: number, reservedTokens?: number, groups?: { filePath: string, annotatedDiff: string }[][] }} [opts]
 * @returns {{ chunks: { filePath: string, annotatedDiff: string }[][], splitGroups: string[][] }}
 */
function chunkFileDiffs(fileDiffs, opts = {}) {
  const budget = opts.tokenBudget ?? CONFIG.tokenBudget;
  const reserved = opts.reservedTokens ?? 0;
  const available = budget - reserved;
  if (fileDiffs.length === 0) return { chunks: [], splitGroups: [] };
  if (available <= 0) return { chunks: fileDiffs.map((f) => [f]), splitGroups: [] };

  let units = opts.groups ?? fileDiffs.map((f) => [f]);

  // Validate groups cover fileDiffs exactly — fall back on mismatch
  if (opts.groups) {
    const flat = opts.groups.flat();
    const expected = new Set(fileDiffs.map((f) => f.filePath));
    const groupPaths = new Set(flat.map((f) => f.filePath));
    if (flat.length !== fileDiffs.length || groupPaths.size !== expected.size || [...groupPaths].some((p) => !expected.has(p))) {
      process.stderr.write(JSON.stringify({ level: 'warn', msg: 'chunk.groups.mismatch', expected: fileDiffs.length, got: flat.length, ts: new Date().toISOString() }) + '\n');
      units = fileDiffs.map((f) => [f]);
    }
  }

  const chunks = [];
  /** @type {string[][]} */
  const splitGroups = [];
  let current = [];
  let currentTokens = 0;

  for (const group of units) {
    const groupTokens = group.reduce((s, f) => s + fileTokens(f), 0);

    if (groupTokens > available) {
      if (group.length > 1) splitGroups.push(group.map((f) => f.filePath));
      if (current.length > 0) { chunks.push(current); current = []; currentTokens = 0; }
      for (const file of group) {
        const ft = fileTokens(file);
        if (ft > available) {
          if (current.length > 0) { chunks.push(current); current = []; currentTokens = 0; }
          chunks.push([file]);
          continue;
        }
        if (current.length > 0 && currentTokens + ft > available) {
          chunks.push(current); current = []; currentTokens = 0;
        }
        current.push(file);
        currentTokens += ft;
      }
      continue;
    }

    if (current.length > 0 && currentTokens + groupTokens > available) {
      chunks.push(current); current = []; currentTokens = 0;
    }
    current.push(...group);
    currentTokens += groupTokens;
  }
  if (current.length > 0) chunks.push(current);
  return { chunks, splitGroups };
}

module.exports = { chunkFileDiffs, buildFileGroups, summarizeFindings, stripSummaryTags };
