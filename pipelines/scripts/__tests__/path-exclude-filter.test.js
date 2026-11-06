'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { partitionByExclude } = require('../lib/path-exclude-filter.js');

const diffs = [
  { path: 'src/app.js', patch: '+a' },
  { path: 'src/app.test.ts', patch: '+b' },
  { path: 'dist/bundle.js', patch: '+c' },
  { path: 'backend/service.js', patch: '+d' },
];

test('empty exclude list keeps all files', () => {
  const { kept, skipped } = partitionByExclude(diffs, []);
  assert.equal(kept.length, 4);
  assert.equal(skipped.length, 0);
});

test('null/undefined exclude list keeps all files', () => {
  assert.equal(partitionByExclude(diffs, null).kept.length, 4);
  assert.equal(partitionByExclude(diffs, undefined).kept.length, 4);
});

test('excludes matching glob patterns', () => {
  const { kept, skipped } = partitionByExclude(diffs, ['**/*.test.ts', '**/dist/**']);
  assert.deepEqual(skipped, ['src/app.test.ts', 'dist/bundle.js']);
  assert.equal(kept.length, 2);
  assert.equal(kept[0].path, 'src/app.js');
  assert.equal(kept[1].path, 'backend/service.js');
});

test('does not mutate input array', () => {
  const input = [...diffs];
  partitionByExclude(input, ['**/*.test.ts']);
  assert.equal(input.length, 4);
});

test('single pattern works', () => {
  const { skipped } = partitionByExclude(diffs, ['**/dist/**']);
  assert.deepEqual(skipped, ['dist/bundle.js']);
});

test('trailing-slash directory pattern is normalized to glob', () => {
  const { skipped } = partitionByExclude(diffs, ['dist/']);
  assert.deepEqual(skipped, ['dist/bundle.js']);
});

test('bare directory name without glob is normalized', () => {
  const { skipped } = partitionByExclude(diffs, ['dist']);
  assert.deepEqual(skipped, ['dist/bundle.js']);
});

test('bare filename matches the file, not a directory', () => {
  const files = [{ path: 'package.json', patch: '+a' }, { path: 'src/app.js', patch: '+b' }];
  const { skipped } = partitionByExclude(files, ['package.json']);
  assert.deepEqual(skipped, ['package.json']);
});

test('negation prefix is stripped to prevent filter inversion', () => {
  const { skipped } = partitionByExclude(diffs, ['!dist']);
  assert.deepEqual(skipped, ['dist/bundle.js']);
});

test('empty and whitespace patterns are ignored', () => {
  const { kept } = partitionByExclude(diffs, ['', '  ', '**/dist/**']);
  assert.equal(kept.length, 3);
});
