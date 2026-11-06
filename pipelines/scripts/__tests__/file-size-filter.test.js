// @ts-check
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { partitionBySize } = require('../lib/file-size-filter.js');

const mk = (path, patch) => ({ path, patch });

test('null cap disables filtering — all kept', () => {
  const diffs = [mk('a', 'x'.repeat(100)), mk('b', 'y'.repeat(5))];
  const { kept, skipped } = partitionBySize(diffs, null);
  assert.deepStrictEqual(kept, diffs);
  assert.deepStrictEqual(skipped, []);
});

test('zero / negative cap disables filtering', () => {
  const diffs = [mk('a', 'x'.repeat(100))];
  assert.deepStrictEqual(partitionBySize(diffs, 0).skipped, []);
  assert.deepStrictEqual(partitionBySize(diffs, -10).skipped, []);
  assert.deepStrictEqual(partitionBySize(diffs, 0).kept, diffs);
});

test('drops oversized files, keeps small ones; reports skipped paths', () => {
  const diffs = [mk('big', 'x'.repeat(50)), mk('small', 'y'.repeat(5)), mk('big2', 'z'.repeat(40))];
  const { kept, skipped } = partitionBySize(diffs, 10);
  assert.deepStrictEqual(kept.map((d) => d.path), ['small']);
  assert.deepStrictEqual(skipped, ['big', 'big2']);
});

test('boundary — patch exactly at cap is kept (strict greater-than)', () => {
  const diffs = [mk('eq', 'x'.repeat(10)), mk('over', 'x'.repeat(11))];
  const { kept, skipped } = partitionBySize(diffs, 10);
  assert.deepStrictEqual(kept.map((d) => d.path), ['eq']);
  assert.deepStrictEqual(skipped, ['over']);
});

test('size measured in UTF-8 bytes, not UTF-16 code units', () => {
  // '€' is 1 JS string char but 3 UTF-8 bytes. 4 chars = 12 bytes > cap 10.
  const diffs = [mk('multi', '€€€€')];
  const { kept, skipped } = partitionBySize(diffs, 10);
  assert.deepStrictEqual(kept, []);
  assert.deepStrictEqual(skipped, ['multi']);
});

test('missing / non-string patch counts as 0 bytes — kept', () => {
  const diffs = [{ path: 'nopatch' }, mk('empty', '')];
  const { kept, skipped } = partitionBySize(diffs, 5);
  assert.deepStrictEqual(kept.map((d) => d.path), ['nopatch', 'empty']);
  assert.deepStrictEqual(skipped, []);
});

test('does not mutate input array or its objects', () => {
  const diffs = [mk('a', 'x'.repeat(50)), mk('b', 'y'.repeat(5))];
  const before = JSON.stringify(diffs);
  partitionBySize(diffs, 10);
  assert.strictEqual(JSON.stringify(diffs), before);
});
