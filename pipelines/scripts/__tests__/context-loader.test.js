'use strict';
const { describe, it } = require('node:test');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadCodingStandards, loadContextPaths, loadCodingStandardsArray, matchStandardsForFiles } = require('../lib/context-loader.js');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'context-loader-test-'));
}

function captureStderr(fn) {
  const orig = process.stderr.write.bind(process.stderr);
  const chunks = [];
  process.stderr.write = (chunk) => { chunks.push(String(chunk)); return true; };
  try {
    const result = fn();
    return { result, stderr: chunks.join('') };
  } finally {
    process.stderr.write = orig;
  }
}

test('loadCodingStandards returns empty for non-string configuredPath', () => {
  assert.equal(loadCodingStandards('/tmp', undefined), '');
  assert.equal(loadCodingStandards('/tmp', null), '');
  assert.equal(loadCodingStandards('/tmp', 42), '');
  assert.equal(loadCodingStandards('/tmp', []), '');
});

test('loadCodingStandards returns empty for blank/whitespace path', () => {
  assert.equal(loadCodingStandards('/tmp', ''), '');
  assert.equal(loadCodingStandards('/tmp', '   '), '');
});

test('loadCodingStandards reads relative path resolved against cwd', () => {
  const dir = makeTmpDir();
  fs.writeFileSync(path.join(dir, 'standards.md'), 'RULES_TOKEN');
  assert.equal(loadCodingStandards(dir, 'standards.md'), 'RULES_TOKEN');
});

test('loadCodingStandards reads absolute path directly', () => {
  const dir = makeTmpDir();
  const abs = path.join(dir, 'abs.md');
  fs.writeFileSync(abs, 'ABS_RULES');
  assert.equal(loadCodingStandards('/never/used', abs), 'ABS_RULES');
});

test('loadCodingStandards warns and returns empty for unreadable file', () => {
  const { result, stderr } = captureStderr(
    () => loadCodingStandards('/tmp', '/nonexistent/path/does-not-exist.md'),
  );
  assert.equal(result, '');
  const log = JSON.parse(stderr.trim());
  assert.equal(log.level, 'warn');
  assert.match(log.msg, /codingStandardsPath unreadable/);
  assert.equal(log.pathConfigured, '/nonexistent/path/does-not-exist.md');
});

test('loadContextPaths returns empty for non-array configuredPaths', () => {
  assert.equal(loadContextPaths('/tmp', undefined), '');
  assert.equal(loadContextPaths('/tmp', null), '');
  assert.equal(loadContextPaths('/tmp', 'string-not-array'), '');
});

test('loadContextPaths returns empty for empty array', () => {
  assert.equal(loadContextPaths('/tmp', []), '');
});

test('loadContextPaths skips non-string entries silently', () => {
  const dir = makeTmpDir();
  fs.writeFileSync(path.join(dir, 'a.md'), 'A_BODY');
  const out = loadContextPaths(dir, [42, 'a.md', null]);
  assert.ok(out.includes('=== a.md ===\nA_BODY'));
  assert.equal(out.split('===').length, 3);
});

test('loadContextPaths skips empty-string entries silently', () => {
  const dir = makeTmpDir();
  fs.writeFileSync(path.join(dir, 'a.md'), 'A_BODY');
  const out = loadContextPaths(dir, ['', '   ', 'a.md']);
  assert.ok(out.includes('=== a.md ==='));
  assert.ok(!out.includes('===  ==='));
});

test('loadContextPaths joins multiple files with blank-line separator and labels each', () => {
  const dir = makeTmpDir();
  fs.writeFileSync(path.join(dir, 'one.md'), 'ONE');
  fs.writeFileSync(path.join(dir, 'two.md'), 'TWO');
  const out = loadContextPaths(dir, ['one.md', 'two.md']);
  assert.equal(out, '=== one.md ===\nONE\n\n=== two.md ===\nTWO');
});

test('loadContextPaths accepts absolute paths', () => {
  const dir = makeTmpDir();
  const abs = path.join(dir, 'abs.md');
  fs.writeFileSync(abs, 'ABS_CTX');
  const out = loadContextPaths('/never/used', [abs]);
  assert.ok(out.includes(`=== ${abs} ===\nABS_CTX`));
});

test('loadContextPaths warns and skips unreadable entries but keeps readable ones', () => {
  const dir = makeTmpDir();
  fs.writeFileSync(path.join(dir, 'ok.md'), 'OK_BODY');
  const { result, stderr } = captureStderr(
    () => loadContextPaths(dir, ['missing.md', 'ok.md']),
  );
  assert.ok(result.includes('=== ok.md ===\nOK_BODY'));
  assert.ok(!result.includes('missing.md'));
  const log = JSON.parse(stderr.trim().split('\n')[0]);
  assert.equal(log.level, 'warn');
  assert.match(log.msg, /contextPath unreadable/);
  assert.equal(log.pathConfigured, 'missing.md');
});

test('loadContextPaths returns empty string when all entries are unreadable', () => {
  const { result, stderr } = captureStderr(
    () => loadContextPaths('/tmp', ['/nope/a.md', '/nope/b.md']),
  );
  assert.equal(result, '');
  const lines = stderr.trim().split('\n');
  assert.equal(lines.length, 2);
});

// --- loadCodingStandardsArray ---

describe('loadCodingStandardsArray', () => {
  it('loads all entries and returns array of { glob, content }', () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, 'java.md'), 'JAVA_RULES');
    fs.writeFileSync(path.join(dir, 'ts.md'), 'TS_RULES');
    const entries = [
      { glob: '*.java', path: 'java.md' },
      { glob: '*.ts', path: 'ts.md' },
    ];
    const result = loadCodingStandardsArray(dir, entries);
    assert.equal(result.length, 2);
    assert.equal(result[0].glob, '*.java');
    assert.equal(result[0].content, 'JAVA_RULES');
    assert.equal(result[1].glob, '*.ts');
    assert.equal(result[1].content, 'TS_RULES');
  });

  it('returns empty array for empty entries', () => {
    assert.deepEqual(loadCodingStandardsArray('/tmp', []), []);
  });

  it('returns empty array for non-array input', () => {
    assert.deepEqual(loadCodingStandardsArray('/tmp', null), []);
    assert.deepEqual(loadCodingStandardsArray('/tmp', undefined), []);
  });

  it('warns and skips unreadable files but keeps readable ones', () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, 'ok.md'), 'OK_RULES');
    const entries = [
      { glob: '*.java', path: 'missing.md' },
      { glob: '*.ts', path: 'ok.md' },
    ];
    const { result, stderr } = captureStderr(
      () => loadCodingStandardsArray(dir, entries),
    );
    assert.equal(result.length, 1);
    assert.equal(result[0].glob, '*.ts');
    assert.equal(result[0].content, 'OK_RULES');
    assert.ok(stderr.includes('codingStandards entry unreadable'));
  });

  it('resolves absolute paths directly', () => {
    const dir = makeTmpDir();
    const abs = path.join(dir, 'abs.md');
    fs.writeFileSync(abs, 'ABS_RULES');
    const entries = [{ glob: '*', path: abs }];
    const result = loadCodingStandardsArray('/never/used', entries);
    assert.equal(result.length, 1);
    assert.equal(result[0].content, 'ABS_RULES');
  });

  it('deduplicates by resolved absolute path', () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, 'shared.md'), 'SHARED');
    const entries = [
      { glob: '*.ts', path: 'shared.md' },
      { glob: '*', path: 'shared.md' },
    ];
    const result = loadCodingStandardsArray(dir, entries);
    assert.equal(result.length, 1);
    assert.equal(result[0].glob, '*.ts');
  });
});

// --- matchStandardsForFiles ---

describe('matchStandardsForFiles', () => {
  it('matches files against globs and returns concatenated content', () => {
    const loaded = [
      { glob: '*.java', content: 'JAVA_RULES' },
      { glob: '*.ts', content: 'TS_RULES' },
      { glob: '*', content: 'GENERAL' },
    ];
    const result = matchStandardsForFiles(loaded, ['src/App.ts', 'src/Main.java']);
    assert.ok(result.includes('JAVA_RULES'));
    assert.ok(result.includes('TS_RULES'));
    assert.ok(result.includes('GENERAL'));
  });

  it('uses matchBase so *.ts matches deep paths', () => {
    const loaded = [{ glob: '*.ts', content: 'TS_RULES' }];
    const result = matchStandardsForFiles(loaded, ['src/deep/nested/file.ts']);
    assert.ok(result.includes('TS_RULES'));
  });

  it('returns empty string when no files match any glob', () => {
    const loaded = [{ glob: '*.java', content: 'JAVA_RULES' }];
    const result = matchStandardsForFiles(loaded, ['src/app.py']);
    assert.equal(result, '');
  });

  it('returns empty string for empty loaded array', () => {
    assert.equal(matchStandardsForFiles([], ['src/app.ts']), '');
  });

  it('returns empty string for empty file list', () => {
    const loaded = [{ glob: '*', content: 'GENERAL' }];
    assert.equal(matchStandardsForFiles(loaded, []), '');
  });

  it('deduplicates content — same content matched by multiple files appears once', () => {
    const loaded = [{ glob: '*.ts', content: 'TS_RULES' }];
    const result = matchStandardsForFiles(loaded, ['a.ts', 'b.ts']);
    const count = result.split('TS_RULES').length - 1;
    assert.equal(count, 1, 'content should appear exactly once');
  });

  it('preserves array order in concatenation', () => {
    const loaded = [
      { glob: '*', content: 'GENERAL' },
      { glob: '*.ts', content: 'TS_RULES' },
    ];
    const result = matchStandardsForFiles(loaded, ['app.ts']);
    assert.ok(result.indexOf('GENERAL') < result.indexOf('TS_RULES'));
  });

  it('path-scoped globs work (src/api/**/*.ts)', () => {
    const loaded = [
      { glob: 'src/api/**/*.ts', content: 'API_RULES' },
      { glob: '*.ts', content: 'TS_RULES' },
    ];
    const apiResult = matchStandardsForFiles(loaded, ['src/api/users.ts']);
    assert.ok(apiResult.includes('API_RULES'));
    assert.ok(apiResult.includes('TS_RULES'));

    const otherResult = matchStandardsForFiles(loaded, ['src/utils/helper.ts']);
    assert.ok(!otherResult.includes('API_RULES'));
    assert.ok(otherResult.includes('TS_RULES'));
  });
});
