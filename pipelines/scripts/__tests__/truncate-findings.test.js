'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { truncateFindings } = require('../lib/noise-filter.js');

test('truncateFindings returns all when under limit', () => {
  const findings = [
    { severity: 'LOW', file: 'a.js' },
    { severity: 'HIGH', file: 'b.js' },
  ];
  const { kept, dropped } = truncateFindings(findings, 10);
  assert.equal(kept.length, 2);
  assert.equal(dropped, 0);
});

test('truncateFindings sorts by severity and truncates', () => {
  const findings = [
    { severity: 'LOW', file: 'a.js' },
    { severity: 'CRITICAL', file: 'b.js' },
    { severity: 'MEDIUM', file: 'c.js' },
    { severity: 'HIGH', file: 'd.js' },
  ];
  const { kept, dropped } = truncateFindings(findings, 2);
  assert.equal(kept.length, 2);
  assert.equal(dropped, 2);
  assert.equal(kept[0].severity, 'CRITICAL');
  assert.equal(kept[1].severity, 'HIGH');
});

test('truncateFindings no-ops when maxFindings is null/0/negative', () => {
  const findings = [{ severity: 'LOW' }, { severity: 'HIGH' }];
  assert.equal(truncateFindings(findings, null).dropped, 0);
  assert.equal(truncateFindings(findings, 0).dropped, 0);
  assert.equal(truncateFindings(findings, -1).dropped, 0);
});

test('truncateFindings does not mutate input', () => {
  const findings = [
    { severity: 'LOW', file: 'a.js' },
    { severity: 'HIGH', file: 'b.js' },
    { severity: 'CRITICAL', file: 'c.js' },
  ];
  const original = [...findings];
  truncateFindings(findings, 1);
  assert.deepEqual(findings, original);
});
