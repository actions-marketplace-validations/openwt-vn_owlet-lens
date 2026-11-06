// @ts-check
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { annotateDiff } = require('../lib/diff-annotate.js');

test('annotates added lines with new line numbers', () => {
  const diff = `@@ -1,2 +1,3 @@\n unchanged\n+added\n removed?`;
  const out = annotateDiff(diff);
  assert.match(out, /^1: unchanged/m);
  assert.match(out, /^2:\+added/m);
});

test('returns empty string for empty input', () => {
  assert.equal(annotateDiff(''), '');
  assert.equal(annotateDiff(null), '');
});

test('handles multiple hunks', () => {
  const diff = `@@ -1,1 +1,1 @@\n a\n@@ -10,1 +10,1 @@\n b`;
  const out = annotateDiff(diff);
  assert.match(out, /^1: a/m);
  assert.match(out, /^10: b/m);
});
