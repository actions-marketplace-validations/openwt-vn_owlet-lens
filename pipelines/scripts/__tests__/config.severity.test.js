'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { SEVERITY_RANK, rankSeverity } = require('../lib/config.js');

describe('SEVERITY_RANK', () => {
  it('orders severities low<medium<high<critical', () => {
    assert.equal(SEVERITY_RANK.low, 1);
    assert.equal(SEVERITY_RANK.medium, 2);
    assert.equal(SEVERITY_RANK.high, 3);
    assert.equal(SEVERITY_RANK.critical, 4);
  });
});

describe('rankSeverity', () => {
  it('returns numeric rank for known severity (case-insensitive)', () => {
    assert.equal(rankSeverity('LOW'), 1);
    assert.equal(rankSeverity('medium'), 2);
    assert.equal(rankSeverity('High'), 3);
    assert.equal(rankSeverity('CRITICAL'), 4);
  });

  it('returns 0 for unknown / missing / null severity', () => {
    assert.equal(rankSeverity('UNKNOWN'), 0);
    assert.equal(rankSeverity(''), 0);
    assert.equal(rankSeverity(null), 0);
    assert.equal(rankSeverity(undefined), 0);
    assert.equal(rankSeverity('hyperbolic'), 0);
  });
});
