// @ts-check
'use strict';

const { rankSeverity } = require('./config.js');
const { isTestFile } = require('./finding-validator.js');

// Path-segment bounded — "generated-components/" must NOT match "generated/".
const BOILERPLATE_DIR_RE = /(^|\/)(dist|build|vendor|generated|__mocks__|mocks|fixtures|migrations|__snapshots__)\//i;
const BOILERPLATE_FILE_RE = /\.lock$|\.min\.[^/.]+$|\.generated\.[^/.]+$/i;

/**
 * True when a path looks like generated/vendored/boilerplate content by
 * convention (extends the prompt's prior generated/vendor/lockfile/minified
 * skip-list — this makes it code-enforced and adds migrations/fixtures/
 * mocks/snapshots).
 *
 * @param {string} filePath
 * @returns {boolean}
 */
function isBoilerplateFile(filePath) {
  if (typeof filePath !== 'string') return false;
  return BOILERPLATE_DIR_RE.test(filePath) || BOILERPLATE_FILE_RE.test(filePath);
}

/**
 * Bypass boilerplate files before they reach the LLM prompt, same shape as
 * file-size-filter.js's partitionBySize. `enabled=false` disables filtering
 * entirely (review.skipGeneratedFiles: false).
 *
 * @template {{ path: string }} T
 * @param {T[]} diffs
 * @param {boolean} enabled
 * @returns {{ kept: T[], skipped: string[] }}
 */
function partitionBoilerplate(diffs, enabled) {
  if (!enabled) return { kept: [...diffs], skipped: [] };
  const kept = [];
  const skipped = [];
  for (const d of diffs) {
    if (isBoilerplateFile(d.path)) skipped.push(d.path);
    else kept.push(d);
  }
  return { kept, skipped };
}

/**
 * The reason a finding was dropped as noise — either it's on a test file
 * below the configured severity floor (`'test-threshold'`), or it's a
 * LOW-severity finding in a category the repo has opted to suppress
 * everywhere (`'noise-category'`). `null` when the finding should be kept.
 * Truthy check at call sites (`if (shouldDropAsNoise(...))`) still works
 * exactly the same as when this returned a boolean.
 *
 * @param {{ file: string, severity: string, category?: string }} finding
 * @param {{ testFileSeverityThreshold: string, noiseCategories: string[] }} opts
 * @returns {null | 'test-threshold' | 'noise-category'}
 */
function shouldDropAsNoise(finding, opts) {
  if (isTestFile(finding.file) && rankSeverity(finding.severity) < rankSeverity(opts.testFileSeverityThreshold)) {
    return 'test-threshold';
  }
  if (finding.severity === 'LOW' && opts.noiseCategories.includes(finding.category)) {
    return 'noise-category';
  }
  return null;
}

/**
 * Sort findings by severity descending (CRITICAL first) and truncate to
 * `maxFindings`. Returns a new array — does not mutate the input.
 *
 * @template {{ severity?: string }} T
 * @param {T[]} findings
 * @param {number|null|undefined} maxFindings
 * @returns {{ kept: T[], dropped: number }}
 */
function truncateFindings(findings, maxFindings) {
  if (!maxFindings || maxFindings <= 0 || findings.length <= maxFindings) {
    return { kept: findings, dropped: 0 };
  }
  const sorted = [...findings].sort((a, b) =>
    rankSeverity(b.severity) - rankSeverity(a.severity)
    || `${a.filePath}:${a.line}`.localeCompare(`${b.filePath}:${b.line}`));
  return { kept: sorted.slice(0, maxFindings), dropped: sorted.length - maxFindings };
}

module.exports = { isBoilerplateFile, partitionBoilerplate, shouldDropAsNoise, truncateFindings };
