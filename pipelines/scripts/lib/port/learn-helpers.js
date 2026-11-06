// @ts-check
'use strict';

const sb = require('../learn/standards-block.js');

const IGNORE_RE = /<!--\s*ai-review:learned-rule=([a-f0-9]{16})\s*-->/g;

/** Parse fingerprints out of an ignore-list file's text (same marker form). */
function parseIgnoreFingerprints(ignoreText) {
  const set = new Set();
  if (typeof ignoreText !== 'string') return set;
  let m; IGNORE_RE.lastIndex = 0;
  while ((m = IGNORE_RE.exec(ignoreText)) !== null) set.add(m[1]);
  return set;
}

module.exports = {
  extractLearnedBlock: sb.extractLearnedBlock,
  parseRuleFingerprints: sb.parseRuleFingerprints,
  parseLearnedRules: sb.parseLearnedRules,
  spliceLearnedBlock: sb.spliceLearnedBlock,
  parseIgnoreFingerprints,
};
