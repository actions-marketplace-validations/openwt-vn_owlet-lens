// @ts-check
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { filterNovel } = require('../../lib/learn/dedup.js');
const { ruleFingerprint } = require('../../lib/learn/standards-block.js');

describe('filterNovel', () => {
  it('drops rules whose fingerprint is already learned or ignored', () => {
    const rules = [
      { category: 'style', rule: 'Allow trailing commas' },
      { category: 'naming', rule: 'Use camelCase' },
      { category: 'style', rule: 'Ignored rule' },
    ];
    const learned = new Set([ruleFingerprint('naming', 'Use camelCase')]);
    const ignored = new Set([ruleFingerprint('style', 'Ignored rule')]);
    const out = filterNovel(rules, { learnedFingerprints: learned, ignoreFingerprints: ignored });
    assert.equal(out.length, 1);
    assert.equal(out[0].rule, 'Allow trailing commas');
  });

  it('handles empty sets', () => {
    const rules = [{ category: 'style', rule: 'r' }];
    const out = filterNovel(rules, { learnedFingerprints: new Set(), ignoreFingerprints: new Set() });
    assert.equal(out.length, 1);
  });
});
