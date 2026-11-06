// @ts-check
'use strict';

/**
 * @template {{ occurrences: number, distinctAuthors: number }} T
 * @param {T[]} clusters
 * @param {{ minWontfix: number, minDistinctAuthors: number }} opts
 * @returns {T[]}
 */
function applyThreshold(clusters, { minWontfix, minDistinctAuthors }) {
  return clusters.filter(
    (c) => c.occurrences >= minWontfix && c.distinctAuthors >= minDistinctAuthors,
  );
}

module.exports = { applyThreshold };
