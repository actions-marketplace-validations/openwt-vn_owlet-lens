// @ts-check
'use strict';

const { ruleFingerprint } = require('./standards-block.js');

/**
 * @template {{ category: string, rule: string }} T
 * @param {T[]} rules
 * @param {{ learnedFingerprints: Set<string>, ignoreFingerprints: Set<string> }} opts
 * @returns {T[]}
 */
function filterNovel(rules, { learnedFingerprints, ignoreFingerprints }) {
  return rules.filter((r) => {
    const fp = ruleFingerprint(r.category, r.rule);
    return !learnedFingerprints.has(fp) && !ignoreFingerprints.has(fp);
  });
}

module.exports = { filterNovel };
