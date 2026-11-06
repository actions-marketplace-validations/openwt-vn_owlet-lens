// @ts-check
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { applyThreshold } = require('../../lib/learn/threshold.js');

describe('applyThreshold', () => {
  const mk = (occ, authors) => ({ rule: 'r', occurrences: occ, distinctAuthors: authors });

  it('keeps clusters meeting both bars', () => {
    const out = applyThreshold([mk(2, 1), mk(1, 1), mk(3, 2)], { minWontfix: 2, minDistinctAuthors: 1 });
    assert.equal(out.length, 2);
  });
  it('enforces distinct authors bar', () => {
    const out = applyThreshold([mk(5, 1)], { minWontfix: 2, minDistinctAuthors: 2 });
    assert.equal(out.length, 0);
  });
});
