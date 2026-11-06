// @ts-check
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { isBoilerplateFile, partitionBoilerplate } = require('../lib/noise-filter.js');

describe('isBoilerplateFile', () => {
  it('matches boilerplate directories', () => {
    const yes = [
      'dist/bundle.js', 'pkg/dist/x.js',
      'build/output.js',
      'vendor/lib.js', 'node_modules_replacement/vendor/foo.js',
      'generated/schema.ts', 'src/generated/api.ts',
      '__mocks__/fs.js', 'pkg/__mocks__/sub/fs.js',
      'mocks/handler.js',
      'fixtures/user.json', 'test/fixtures/data.json',
      'migrations/0001_init.sql', 'db/migrations/0002_add.sql',
      '__snapshots__/App.test.js.snap',
    ];
    for (const p of yes) assert.equal(isBoilerplateFile(p), true, p);
  });

  it('matches boilerplate file extensions', () => {
    const yes = ['package.lock', 'yarn.lock', 'app.min.js', 'styles.min.css', 'schema.generated.ts', 'api.generated.go'];
    for (const p of yes) assert.equal(isBoilerplateFile(p), true, p);
  });

  it('does not match legitimate source paths that merely contain similar substrings', () => {
    const no = [
      'src/generated-components/Button.tsx', // "generated-" prefix, not the "generated" segment
      'src/vendors-list.ts',                  // "vendors" not "vendor"
      'src/mockingbird.ts',                   // "mocking" not "mocks"
      'src/fixtureless.ts',
      'src/service.js', 'lib/handler.go', 'app/views.py',
    ];
    for (const p of no) assert.equal(isBoilerplateFile(p), false, p);
  });

  it('returns false for non-string input', () => {
    assert.equal(isBoilerplateFile(/** @type {any} */ (null)), false);
    assert.equal(isBoilerplateFile(/** @type {any} */ (undefined)), false);
    assert.equal(isBoilerplateFile(/** @type {any} */ (42)), false);
  });
});

describe('partitionBoilerplate', () => {
  const mk = (path) => ({ path, patch: 'x' });

  it('disabled — keeps everything, skips nothing', () => {
    const diffs = [mk('dist/a.js'), mk('src/b.js')];
    const { kept, skipped } = partitionBoilerplate(diffs, false);
    assert.deepEqual(kept, diffs);
    assert.deepEqual(skipped, []);
  });

  it('enabled — bypasses boilerplate, keeps the rest', () => {
    const diffs = [mk('dist/a.js'), mk('src/b.js'), mk('vendor/c.js')];
    const { kept, skipped } = partitionBoilerplate(diffs, true);
    assert.deepEqual(kept.map((d) => d.path), ['src/b.js']);
    assert.deepEqual(skipped, ['dist/a.js', 'vendor/c.js']);
  });

  it('does not mutate the input array', () => {
    const diffs = [mk('src/b.js')];
    const before = JSON.stringify(diffs);
    partitionBoilerplate(diffs, true);
    assert.equal(JSON.stringify(diffs), before);
  });
});

const { shouldDropAsNoise } = require('../lib/noise-filter.js');

describe('shouldDropAsNoise', () => {
  const opts = { testFileSeverityThreshold: 'high', noiseCategories: ['style', 'naming'] };

  it('test file below threshold is dropped (LOW and MEDIUM at default high threshold)', () => {
    assert.equal(shouldDropAsNoise({ file: 'a.test.js', severity: 'LOW', category: 'bug' }, opts), 'test-threshold');
    assert.equal(shouldDropAsNoise({ file: 'a.test.js', severity: 'MEDIUM', category: 'bug' }, opts), 'test-threshold');
  });

  it('test file at or above threshold is kept', () => {
    assert.equal(shouldDropAsNoise({ file: 'a.test.js', severity: 'HIGH', category: 'bug' }, opts), null);
    assert.equal(shouldDropAsNoise({ file: 'a.test.js', severity: 'CRITICAL', category: 'bug' }, opts), null);
  });

  it('non-test file, LOW severity, category in noiseCategories is dropped', () => {
    assert.equal(shouldDropAsNoise({ file: 'src/a.js', severity: 'LOW', category: 'style' }, opts), 'noise-category');
    assert.equal(shouldDropAsNoise({ file: 'src/a.js', severity: 'LOW', category: 'naming' }, opts), 'noise-category');
  });

  it('non-test file, MEDIUM severity, category in noiseCategories is kept (gate is LOW-only)', () => {
    assert.equal(shouldDropAsNoise({ file: 'src/a.js', severity: 'MEDIUM', category: 'style' }, opts), null);
  });

  it('non-test file, LOW severity, category NOT in noiseCategories is kept', () => {
    assert.equal(shouldDropAsNoise({ file: 'src/a.js', severity: 'LOW', category: 'bug' }, opts), null);
  });

  it('empty noiseCategories disables the category gate but test-file gate still applies', () => {
    const disabledOpts = { testFileSeverityThreshold: 'high', noiseCategories: [] };
    assert.equal(shouldDropAsNoise({ file: 'src/a.js', severity: 'LOW', category: 'style' }, disabledOpts), null);
    assert.equal(shouldDropAsNoise({ file: 'a.test.js', severity: 'LOW', category: 'bug' }, disabledOpts), 'test-threshold');
  });

  it('missing category never matches noiseCategories', () => {
    assert.equal(shouldDropAsNoise({ file: 'src/a.js', severity: 'LOW' }, opts), null);
  });

  it('test file gate and category gate are independent — either can drop', () => {
    // bug category, not in noiseCategories, but still dropped by test-threshold gate
    assert.equal(shouldDropAsNoise({ file: 'a.test.js', severity: 'LOW', category: 'bug' }, opts), 'test-threshold');
  });
});
