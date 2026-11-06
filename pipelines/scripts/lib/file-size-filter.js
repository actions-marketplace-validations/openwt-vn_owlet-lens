// @ts-check
'use strict';

/**
 * Partition diff files by patch size, bypassing files whose unified-diff text
 * exceeds `maxFileBytes` before they reach the LLM prompt. Size is the UTF-8
 * byte length of `patch` (what actually gets sent), not UTF-16 code units.
 *
 * A null / non-number / <= 0 cap disables filtering — every file is kept. A
 * missing or non-string `patch` counts as 0 bytes and is always kept. The
 * input array is never mutated.
 *
 * @template {{ path: string, patch?: string }} T
 * @param {T[]} diffs
 * @param {number|null|undefined} maxFileBytes
 * @returns {{ kept: T[], skipped: string[] }}
 */
function partitionBySize(diffs, maxFileBytes) {
  if (typeof maxFileBytes !== 'number' || maxFileBytes <= 0) {
    return { kept: [...diffs], skipped: [] };
  }
  const kept = [];
  const skipped = [];
  for (const d of diffs) {
    const bytes = typeof d.patch === 'string' ? Buffer.byteLength(d.patch, 'utf8') : 0;
    if (bytes > maxFileBytes) skipped.push(d.path);
    else kept.push(d);
  }
  return { kept, skipped };
}

module.exports = { partitionBySize };
