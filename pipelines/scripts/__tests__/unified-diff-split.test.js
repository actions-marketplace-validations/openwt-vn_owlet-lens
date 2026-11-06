// @ts-check
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { splitUnifiedDiff } = require('../lib/unified-diff-split.js');

test('splits a single modified file', () => {
  const diff = [
    'diff --git a/src/a.js b/src/a.js',
    'index 111..222 100644',
    '--- a/src/a.js',
    '+++ b/src/a.js',
    '@@ -1,2 +1,2 @@',
    '-old',
    '+new',
    ' ctx',
  ].join('\n');
  const out = splitUnifiedDiff(diff);
  assert.equal(out.length, 1);
  assert.equal(out[0].path, 'src/a.js');
  assert.equal(out[0].change, 'modify');
  assert.equal(out[0].oldPath, undefined);
  assert.match(out[0].patch, /^@@ -1,2 \+1,2 @@/m);
  assert.match(out[0].patch, /\+new/);
});

test('splits multiple files into separate entries', () => {
  const diff = [
    'diff --git a/x.js b/x.js',
    '--- a/x.js',
    '+++ b/x.js',
    '@@ -1 +1 @@',
    '-a',
    '+b',
    'diff --git a/y.js b/y.js',
    '--- a/y.js',
    '+++ b/y.js',
    '@@ -1 +1 @@',
    '-c',
    '+d',
  ].join('\n');
  const out = splitUnifiedDiff(diff);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((f) => f.path), ['x.js', 'y.js']);
});

test('detects added file', () => {
  const diff = [
    'diff --git a/new.js b/new.js',
    'new file mode 100644',
    'index 000..222',
    '--- /dev/null',
    '+++ b/new.js',
    '@@ -0,0 +1 @@',
    '+hello',
  ].join('\n');
  const out = splitUnifiedDiff(diff);
  assert.equal(out[0].change, 'add');
  assert.equal(out[0].path, 'new.js');
});

test('detects deleted file', () => {
  const diff = [
    'diff --git a/gone.js b/gone.js',
    'deleted file mode 100644',
    '--- a/gone.js',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-bye',
  ].join('\n');
  const out = splitUnifiedDiff(diff);
  assert.equal(out[0].change, 'delete');
  assert.equal(out[0].path, 'gone.js');
});

test('detects rename with oldPath', () => {
  const diff = [
    'diff --git a/old/name.js b/new/name.js',
    'similarity index 95%',
    'rename from old/name.js',
    'rename to new/name.js',
    'index 111..222 100644',
    '--- a/old/name.js',
    '+++ b/new/name.js',
    '@@ -1 +1 @@',
    '-x',
    '+y',
  ].join('\n');
  const out = splitUnifiedDiff(diff);
  assert.equal(out[0].change, 'rename');
  assert.equal(out[0].path, 'new/name.js');
  assert.equal(out[0].oldPath, 'old/name.js');
});

test('strips git quotes from paths with spaces (--- / +++ lines)', () => {
  const diff = [
    'diff --git "a/my file.js" "b/my file.js"',
    'index 111..222 100644',
    '--- "a/my file.js"',
    '+++ "b/my file.js"',
    '@@ -1 +1 @@',
    '-x',
    '+y',
  ].join('\n');
  const out = splitUnifiedDiff(diff);
  assert.equal(out.length, 1);
  assert.equal(out[0].path, 'my file.js');
  assert.equal(out[0].change, 'modify');
});

test('strips git quotes from the diff --git header fallback (added file)', () => {
  const diff = [
    'diff --git "a/new file.js" "b/new file.js"',
    'new file mode 100644',
    '--- /dev/null',
    '+++ "b/new file.js"',
    '@@ -0,0 +1 @@',
    '+hi',
  ].join('\n');
  const out = splitUnifiedDiff(diff);
  assert.equal(out[0].path, 'new file.js');
  assert.equal(out[0].change, 'add');
});

test('returns empty array for empty diff', () => {
  assert.deepEqual(splitUnifiedDiff(''), []);
  assert.deepEqual(splitUnifiedDiff('   \n'), []);
});

test('binary/mode-only file yields entry with empty patch hunks', () => {
  const diff = [
    'diff --git a/img.png b/img.png',
    'index 111..222 100644',
    'Binary files a/img.png and b/img.png differ',
  ].join('\n');
  const out = splitUnifiedDiff(diff);
  assert.equal(out.length, 1);
  assert.equal(out[0].path, 'img.png');
  assert.equal(out[0].change, 'modify');
});
