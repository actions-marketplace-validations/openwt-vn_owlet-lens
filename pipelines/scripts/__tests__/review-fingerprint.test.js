// @ts-check
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { computeReviewFingerprint, normalizePatch } = require('../lib/review-fingerprint.js');

const CONFIG = Object.freeze({
  provider: 'github',
  auth: { anthropicKey: 'k1', token: 't1' },
  paths: { exclude: ['dist/**'] },
  review: { model: 'm1', skipGeneratedFiles: true, maxFileBytes: null, severityThreshold: 'medium' },
});

/** @param {string} path @param {string} patch @param {object} [extra] */
const file = (path, patch, extra = {}) => ({ path, change: 'modify', patch, ...extra });
/** @param {any[]} diffs @param {object} [over] */
const fp = (diffs, over = {}) =>computeReviewFingerprint({ diffs, config: CONFIG, standards: 'S', ...over });

describe('normalizePatch', () => {
  it('keeps added and removed lines, drops hunk headers and context', () => {
    const n = normalizePatch('@@ -1,3 +1,3 @@\n ctx\n-old\n+new\n ctx2\n');
    assert.deepEqual(n, { added: ['new'], removed: ['old'] });
  });

  it('ignores file headers before the first hunk but counts a removed "-- x" line after it', () => {
    const n = normalizePatch('--- a/f\n+++ b/f\n@@ -1 +1 @@\n--- x\n+++ y\n');
    assert.deepEqual(n, { added: ['++ y'], removed: ['-- x'] });
  });

  it('ignores the "no newline" marker', () => {
    const n = normalizePatch('@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n');
    assert.deepEqual(n, { added: ['b'], removed: ['a'] });
  });
});

describe('computeReviewFingerprint', () => {
  const before = [file('src/a.js', '@@ -10,3 +10,4 @@\n ctx\n+added();\n ctx\n')];

  it('is a 32-char lowercase hex string', () => {
    assert.match(fp(before), /^[a-f0-9]{32}$/);
  });

  it('a merge from the target that shifts line numbers and context leaves it unchanged', () => {
    const after = [file('src/a.js', '@@ -42,3 +42,4 @@\n other ctx\n+added();\n more ctx\n')];
    assert.equal(fp(after), fp(before));
  });

  it('a changed added line changes it', () => {
    assert.notEqual(fp([file('src/a.js', '@@ -10,3 +10,4 @@\n ctx\n+added2();\n ctx\n')]), fp(before));
  });

  it('a changed removed line changes it (conflict resolution / evil merge)', () => {
    const a = [file('src/a.js', '@@ -1 +1 @@\n-x\n+y\n')];
    const b = [file('src/a.js', '@@ -1 +1 @@\n-z\n+y\n')];
    assert.notEqual(fp(a), fp(b));
  });

  it('does not depend on file order', () => {
    const x = file('a.js', '@@ -0,0 +1 @@\n+1\n');
    const y = file('b.js', '@@ -0,0 +1 @@\n+2\n');
    assert.equal(fp([x, y]), fp([y, x]));
  });

  it('change status and rename source count', () => {
    const p = '@@ -0,0 +1 @@\n+1\n';
    assert.notEqual(fp([file('a.js', p)]), fp([file('a.js', p, { change: 'add' })]));
    assert.notEqual(
      fp([file('b.js', p, { change: 'rename', oldPath: 'a.js' })]),
      fp([file('b.js', p, { change: 'rename', oldPath: 'c.js' })]),
    );
  });

  it('ignores files the LLM never sees (paths.exclude, generated files)', () => {
    const extra = [
      file('dist/bundle.js', '@@ -0,0 +1 @@\n+minified\n'),
      file('yarn.lock', '@@ -0,0 +1 @@\n+lock\n'),
    ];
    assert.equal(fp([...before, ...extra]), fp(before));
  });

  it('a config change changes it, an auth change does not', () => {
    const reviewChanged = { ...CONFIG, review: { ...CONFIG.review, severityThreshold: 'high' } };
    const modelChanged = { ...CONFIG, review: { ...CONFIG.review, model: 'm2' } };
    const authChanged = { ...CONFIG, auth: { anthropicKey: 'other', token: 'other' } };
    assert.notEqual(fp(before, { config: reviewChanged }), fp(before));
    assert.notEqual(fp(before, { config: modelChanged }), fp(before));
    assert.equal(fp(before, { config: authChanged }), fp(before));
  });

  it('config key order does not matter', () => {
    const reordered = { review: CONFIG.review, paths: CONFIG.paths, auth: CONFIG.auth, provider: 'github' };
    assert.equal(fp(before, { config: reordered }), fp(before));
  });

  it('a coding-standards change changes it', () => {
    assert.notEqual(fp(before, { standards: 'S2' }), fp(before));
  });
});
