'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { extractImportPaths, resolveImport, traceImports, buildImportGraph } = require('../lib/import-tracer.js');

test('extractImportPaths finds ES imports from added lines', () => {
  const patch = [
    "+import { foo } from './utils';",
    "+import bar from '../lib/bar';",
    "-import old from './old';",
  ].join('\n');
  const result = extractImportPaths(patch);
  assert.ok(result.includes('./utils'));
  assert.ok(result.includes('../lib/bar'));
  assert.ok(!result.includes('./old'));
});

test('extractImportPaths finds require() calls', () => {
  const patch = "+const x = require('./helper');";
  const result = extractImportPaths(patch);
  assert.ok(result.includes('./helper'));
});

test('extractImportPaths deduplicates', () => {
  const patch = "+import a from './x';\n+const b = require('./x');";
  const result = extractImportPaths(patch);
  assert.equal(result.filter((s) => s === './x').length, 1);
});

test('extractImportPaths returns empty for null/empty', () => {
  assert.deepEqual(extractImportPaths(null), []);
  assert.deepEqual(extractImportPaths(''), []);
});

test('resolveImport resolves relative path with extension', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'imp-trace-'));
  fs.mkdirSync(path.join(tmp, 'src'));
  fs.writeFileSync(path.join(tmp, 'src', 'helper.js'), 'module.exports = {}');
  const result = resolveImport('./helper', 'src/main.js', tmp);
  assert.equal(result, 'src/helper.js');
  fs.rmSync(tmp, { recursive: true });
});

test('resolveImport tries extensions', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'imp-trace-'));
  fs.mkdirSync(path.join(tmp, 'src'));
  fs.writeFileSync(path.join(tmp, 'src', 'util.ts'), 'export const a = 1');
  const result = resolveImport('./util', 'src/main.js', tmp);
  assert.equal(result, 'src/util.ts');
  fs.rmSync(tmp, { recursive: true });
});

test('resolveImport returns null for package imports', () => {
  assert.equal(resolveImport('lodash', 'src/main.js', '/tmp'), null);
  assert.equal(resolveImport('node:fs', 'src/main.js', '/tmp'), null);
});

test('traceImports reads imported files and excludes changed files', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'imp-trace-'));
  fs.mkdirSync(path.join(tmp, 'src'));
  fs.writeFileSync(path.join(tmp, 'src', 'dep.js'), 'module.exports = { ok: true }');
  fs.writeFileSync(path.join(tmp, 'src', 'changed.js'), '// changed');

  const diffs = [
    { path: 'src/main.js', patch: "+const dep = require('./dep');\n+const c = require('./changed');" },
    { path: 'src/changed.js', patch: '+// modified' },
  ];

  const { imports } = traceImports(diffs, tmp);
  assert.equal(imports.length, 1);
  assert.equal(imports[0].path, 'src/dep.js');
  assert.ok(imports[0].content.includes('ok: true'));
  fs.rmSync(tmp, { recursive: true });
});

// --- #82: traced imports are redacted with the SEC-4 diff redactor, and honour paths.exclude ---

test('traceImports redacts connection-string credentials via the diff redactor', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'imp-trace-'));
  fs.mkdirSync(path.join(tmp, 'config'));
  fs.writeFileSync(
    path.join(tmp, 'config', 'db.js'),
    "module.exports = { url: 'postgres://app:s3cretpass@db:5432/prod' };\n",
  );

  const diffs = [{ path: 'src/app.js', patch: "+const db = require('../config/db');" }];
  const { imports, totalRedacted } = traceImports(diffs, tmp);

  assert.equal(imports.length, 1);
  assert.equal(imports[0].path, 'config/db.js');
  assert.ok(!imports[0].content.includes('s3cretpass'), 'password survived redaction');
  assert.ok(imports[0].content.includes('[REDACTED]'));
  assert.ok(totalRedacted > 0, 'redaction count not reported');
  fs.rmSync(tmp, { recursive: true });
});

test('traceImports redacts token shapes the log redactor misses', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'imp-trace-'));
  fs.mkdirSync(path.join(tmp, 'src'));
  fs.writeFileSync(
    path.join(tmp, 'src', 'creds.js'),
    [
      "const gh = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';",
      "const gl = 'glpat-ABCDEFGHIJKLMNOPQRST';",
      "const pw = process.env.DB_PASSWORD;",
      'const password = "hunter2hunter2hunter2";',
      '',
    ].join('\n'),
  );

  const diffs = [{ path: 'src/main.js', patch: "+const c = require('./creds');" }];
  const { imports, totalRedacted } = traceImports(diffs, tmp);

  const content = imports[0].content;
  assert.ok(!content.includes('ghp_abcdefghijklmnopqrstuvwxyz0123456789'));
  assert.ok(!content.includes('glpat-ABCDEFGHIJKLMNOPQRST'));
  assert.ok(!content.includes('hunter2hunter2hunter2'));
  assert.ok(totalRedacted >= 3, `expected >= 3 redactions, got ${totalRedacted}`);
  fs.rmSync(tmp, { recursive: true });
});

test('traceImports skips files matching paths.exclude', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'imp-trace-'));
  fs.mkdirSync(path.join(tmp, 'config'));
  fs.mkdirSync(path.join(tmp, 'src'));
  fs.writeFileSync(path.join(tmp, 'config', 'db.js'), 'module.exports = {}');
  fs.writeFileSync(path.join(tmp, 'src', 'ok.js'), 'module.exports = { ok: 1 }');

  const diffs = [{
    path: 'src/main.js',
    patch: "+const db = require('../config/db');\n+const ok = require('./ok');",
  }];

  const { imports, excluded } = traceImports(diffs, tmp, { excludePatterns: ['config/**'] });

  assert.deepEqual(imports.map((i) => i.path), ['src/ok.js']);
  assert.deepEqual(excluded, ['config/db.js']);
  fs.rmSync(tmp, { recursive: true });
});

test('traceImports reports zero redactions for clean content', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'imp-trace-'));
  fs.mkdirSync(path.join(tmp, 'src'));
  fs.writeFileSync(path.join(tmp, 'src', 'dep.js'), 'module.exports = { ok: true }');

  const { imports, totalRedacted, excluded } = traceImports(
    [{ path: 'src/main.js', patch: "+require('./dep');" }], tmp,
  );

  assert.equal(imports.length, 1);
  assert.equal(totalRedacted, 0);
  assert.deepEqual(excluded, []);
  fs.rmSync(tmp, { recursive: true });
});

test('traceImports redacts a PEM private key stored in an imported file', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'imp-trace-'));
  fs.mkdirSync(path.join(tmp, 'src'));
  fs.writeFileSync(
    path.join(tmp, 'src', 'key.js'),
    [
      'const key = `',
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn',
      '-----END RSA PRIVATE KEY-----',
      '`;',
      '',
    ].join('\n'),
  );

  const { imports, totalRedacted } = traceImports(
    [{ path: 'src/main.js', patch: "+const k = require('./key');" }], tmp,
  );

  assert.ok(!imports[0].content.includes('MIIEpA'), 'private key body leaked');
  assert.ok(imports[0].content.includes('[REDACTED-PEM-BEGIN]'));
  assert.equal(totalRedacted, 1);
  fs.rmSync(tmp, { recursive: true });
});

test('traceImports redacts an inline (escaped) PEM in an imported file', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'imp-trace-'));
  fs.mkdirSync(path.join(tmp, 'config'));
  fs.writeFileSync(
    path.join(tmp, 'config', 'keys.js'),
    'module.exports = { cert: "-----BEGIN RSA PRIVATE KEY-----\\nMIIEpAIBAAKCAQEA0Z3VS5JJ\\n-----END RSA PRIVATE KEY-----" };\n',
  );

  const { imports, totalRedacted } = traceImports(
    [{ path: 'src/main.js', patch: "+const k = require('../config/keys');" }], tmp,
  );

  assert.ok(!imports[0].content.includes('MIIEpAIBAAKCAQEA0Z3VS5JJ'), 'key body leaked');
  assert.ok(imports[0].content.includes('[REDACTED-PEM]'));
  assert.equal(totalRedacted, 1);
  fs.rmSync(tmp, { recursive: true });
});

test('traceImports respects maxFiles limit', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'imp-trace-'));
  fs.mkdirSync(path.join(tmp, 'src'));
  fs.writeFileSync(path.join(tmp, 'src', 'a.js'), 'a');
  fs.writeFileSync(path.join(tmp, 'src', 'b.js'), 'b');
  fs.writeFileSync(path.join(tmp, 'src', 'c.js'), 'c');

  const diffs = [{
    path: 'src/main.js',
    patch: "+require('./a');\n+require('./b');\n+require('./c');",
  }];

  const { imports } = traceImports(diffs, tmp, { maxFiles: 2 });
  assert.equal(imports.length, 2);
  fs.rmSync(tmp, { recursive: true });
});

test('resolveImport blocks traversal outside repo root', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'imp-trace-'));
  fs.mkdirSync(path.join(tmp, 'src'));
  assert.equal(resolveImport('../../etc/passwd', 'src/main.js', tmp), null);
  assert.equal(resolveImport('../../../.env', 'src/main.js', tmp), null);
  fs.rmSync(tmp, { recursive: true });
});

test('resolveImport rejects absolute specifiers', () => {
  assert.equal(resolveImport('/etc/passwd', 'src/main.js', '/tmp'), null);
  assert.equal(resolveImport('/home/user/.ssh/id_rsa', 'src/main.js', '/tmp'), null);
});

test('resolveImport enforces extension whitelist on direct match', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'imp-trace-'));
  fs.mkdirSync(path.join(tmp, 'src'));
  fs.writeFileSync(path.join(tmp, 'src', 'secrets.json'), '{"key":"val"}');
  assert.equal(resolveImport('./secrets.json', 'src/main.js', tmp), null);
  fs.rmSync(tmp, { recursive: true });
});

test('extractImportPaths skips comment lines', () => {
  const patch = [
    "+// import './legacy';",
    "+  * import './jsdoc-example';",
    "+import { real } from './actual';",
  ].join('\n');
  const result = extractImportPaths(patch);
  assert.ok(!result.includes('./legacy'));
  assert.ok(!result.includes('./jsdoc-example'));
  assert.ok(result.includes('./actual'));
});

// --- buildImportGraph tests ---

test('buildImportGraph creates bidirectional edges for mutual imports', () => {
  const diffs = [
    { path: 'src/a.js', patch: "+const b = require('./b');" },
    { path: 'src/b.js', patch: "+const a = require('./a');" },
  ];
  const graph = buildImportGraph(diffs);
  assert.ok(graph.get('src/a.js')?.has('src/b.js'));
  assert.ok(graph.get('src/b.js')?.has('src/a.js'));
});

test('buildImportGraph ignores imports to files outside diff set', () => {
  const diffs = [
    { path: 'src/a.js', patch: "+const ext = require('./external');" },
    { path: 'src/b.js', patch: '+// no imports' },
  ];
  const graph = buildImportGraph(diffs);
  assert.equal(graph.get('src/a.js')?.size ?? 0, 0);
});

test('buildImportGraph returns empty map when no relative imports', () => {
  const diffs = [
    { path: 'src/a.js', patch: "+const fs = require('node:fs');" },
    { path: 'src/b.js', patch: "+import lodash from 'lodash';" },
  ];
  const graph = buildImportGraph(diffs);
  assert.equal(graph.size, 0);
});
