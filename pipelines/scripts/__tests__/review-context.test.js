// @ts-check
'use strict';
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadReviewContext } = require('../lib/review-context.js');
const { renderLearnedBlock } = require('../lib/learn/standards-block.js');

const DIFFS = [{ path: 'src/x.js', patch: "@@ -0,0 +1 @@\n+const y = require('./y.js');\n" }];

/** @param {string} dir @param {Record<string, string>} files */
function writeTree(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
}

/** @param {string} cwd @param {object} review */
function load(cwd, review) {
  const events = /** @type {Array<{ level: string, msg: string, fields?: Record<string, any> }>} */ ([]);
  const ctx = loadReviewContext({
    cwd,
    config: { paths: { exclude: [] }, review: { codingStandardsPath: null, contextPaths: [], ...review } },
    diffs: DIFFS,
    log: (level, msg, fields) => events.push({ level, msg, fields }),
  });
  return { ctx, msgs: events.map((e) => e.msg), events };
}

describe('loadReviewContext', () => {
  /** @type {string} */
  let cwd;
  beforeEach(() => { cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'review-ctx-')); });
  afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

  it('an empty folder yields empty context and no logs', () => {
    const { ctx, msgs } = load(cwd, {});
    assert.deepEqual(ctx.tracedImports, []);
    assert.equal(ctx.suppressionContext, '');
    assert.deepEqual(msgs, []);
  });

  it('logs CODEOWNERS owners of the changed files', () => {
    writeTree(cwd, { CODEOWNERS: 'src/ @team-a\n' });
    const { events } = load(cwd, {});
    const ev = events.find((e) => e.msg === 'review.codeowners');
    // owners is a null-prototype map; spread it to compare by value.
    assert.deepEqual({ ...ev?.fields?.owners }, { '@team-a': 1 });
  });

  it('traces a relative import of a changed file', () => {
    writeTree(cwd, { 'src/x.js': "const y = require('./y.js');\n", 'src/y.js': 'module.exports = 1;\n' });
    const { ctx, msgs } = load(cwd, {});
    assert.deepEqual(ctx.tracedImports.map((t) => t.path), ['src/y.js']);
    assert.ok(msgs.includes('review.imports.traced'));
  });

  it('glob-scoped standards keep only entries whose glob matches a changed file', () => {
    writeTree(cwd, { 'js.md': 'JS RULES', 'py.md': 'PY RULES' });
    const { ctx, msgs } = load(cwd, {
      _codingStandards: [{ glob: '**/*.js', path: 'js.md' }, { glob: '**/*.py', path: 'py.md' }],
    });
    assert.equal(ctx.codingStandards, 'JS RULES');
    assert.ok(msgs.includes('review.codingStandards.glob'));
  });

  it('a single standards file is loaded, and its learned rules become the suppression section', () => {
    const learned = renderLearnedBlock([{ category: 'style', rule: 'Allow trailing commas', evidencePrs: ['12', '13'] }]);
    writeTree(cwd, { 'standards.md': `# Rules\n\n${learned}\n` });
    const { ctx, msgs } = load(cwd, { codingStandardsPath: 'standards.md' });
    assert.match(String(ctx.codingStandards), /# Rules/);
    assert.match(ctx.suppressionContext, /Allow trailing commas/);
    assert.ok(msgs.includes('review.suppression.loaded'));
  });
});
