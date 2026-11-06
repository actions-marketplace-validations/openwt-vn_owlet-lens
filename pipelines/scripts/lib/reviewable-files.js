// @ts-check
'use strict';

const { partitionByExclude } = require('./path-exclude-filter.js');
const { partitionBySize } = require('./file-size-filter.js');
const { partitionBoilerplate } = require('./noise-filter.js');

/**
 * Split a PR's diffs into the files the LLM sees and the ones it must not
 * (excluded, oversized, boilerplate). One owner for the order and the config
 * keys, shared by the review pass and the review fingerprint, so "what was
 * reviewed" and "what the fingerprint covers" cannot drift apart.
 *
 * @template {{ path: string, patch?: string }} T
 * @param {T[]} diffs
 * @param {{ excludePaths?: string[], review: { maxFileBytes?: number|null, skipGeneratedFiles?: boolean } }} config
 * @returns {{ kept: T[], skipped: { exclude: string[], size: string[], boilerplate: string[] } }}
 */
function partitionReviewable(diffs, config) {
  const { kept: excludeKept, skipped: exclude } = partitionByExclude(diffs, config.excludePaths ?? []);
  const { kept: sizeKept, skipped: size } = partitionBySize(excludeKept, config.review.maxFileBytes);
  const { kept, skipped: boilerplate } = partitionBoilerplate(sizeKept, config.review.skipGeneratedFiles !== false);
  return { kept, skipped: { exclude, size, boilerplate } };
}

module.exports = { partitionReviewable };
