// @ts-check
'use strict';

// Integration coverage for the traced-import wiring in `runReview`
// (ai-review.js, the `traceImports(diffs, cwd, { excludePatterns })` call).
// import-tracer.test.js unit-tests the tracer in isolation; it cannot prove
// that the REAL config's `paths.exclude` reaches it, nor that the redacted
// content replaces what the tracer read. These tests drive the real
// `runReview` end-to-end, mocking only the provider and LLM layers, following
// the pattern in `ai-review-noise-drop.test.js`.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const providerIndex = require('../lib/providers/index.js');
const llmIndex = require('../lib/llm/index.js');
const { runReview } = require('../ai-review.js');

const SECRET = 'postgres://app:s3cretpass@db:5432/prod';

/**
 * Drive a real `runReview({ argv: [..., '--dry-run'] })` against a temp repo
 * whose working tree holds the imported files, capturing every prompt the
 * review/reply LLM layers received.
 *
 * @param {{ files: Record<string,string>, exclude: string[] }} args
 */
async function runWithTracedImports({ files, exclude }) {
  const origMakeProvider = providerIndex.makeProvider;
  const origMakeLLM = llmIndex.makeLLMProvider;

  const calls = [];
  const llmStub = () => ({
    call: async (sys, user) => {
      calls.push({ sys, user });
      return {
        text: JSON.stringify({ summary: 's', findings: [] }),
        usage: { inputTokens: 10, outputTokens: 5 },
        cost: { inputCost: 0, outputCost: 0, totalCost: 0.001 },
        model: 'stub-model',
      };
    },
  });

  providerIndex.makeProvider = () => ({
    getPRMetadata: async () => ({
      id: '42', title: 'T', sourceBranch: 'h', targetBranch: 'b',
      sourceSha: 's1', targetSha: 's0', authorEmail: 'x', url: 'u',
    }),
    getDiff: async () => [{
      path: 'src/app.js', change: 'modify',
      patch: "@@ -0,0 +1,2 @@\n+const db = require('../config/db');\n+require('./helper');\n",
    }],
    listThreads: async () => [],
    renderSummaryMarker: () => '<!-- ai-review:v1:summary -->',
  });
  llmIndex.makeLLMProvider = llmStub;

  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-review-traced-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(cfgDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  const excludeYaml = exclude.length > 0
    ? `paths:\n  exclude:\n${exclude.map((p) => `    - '${p}'`).join('\n')}\n`
    : '';
  fs.writeFileSync(
    path.join(cfgDir, 'ai-review.config.yaml'),
    'provider: github\nauth:\n  anthropicKey: ${ANTHROPIC_API_KEY}\n  token: ${GITHUB_TOKEN}\n' + excludeYaml,
  );

  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = () => true;

  try {
    await runReview({
      argv: ['review', '--dry-run'],
      env: {
        ANTHROPIC_API_KEY: 'k', GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r',
        GITHUB_REF: 'refs/pull/42/head',
      },
      cwd: cfgDir,
    });
  } finally {
    process.stdout.write = origWrite;
    providerIndex.makeProvider = origMakeProvider;
    llmIndex.makeLLMProvider = origMakeLLM;
    fs.rmSync(cfgDir, { recursive: true, force: true });
  }

  assert.ok(calls.length > 0, 'expected at least one LLM call');
  // The review call is the one carrying the PR diff.
  return calls.find((c) => c.user.includes('src/app.js')) ?? calls[0];
}

test('runReview: paths.exclude keeps an imported file out of the prompt', async () => {
  const call = await runWithTracedImports({
    files: {
      'config/db.js': `module.exports = { url: '${SECRET}' };\n`,
      'src/helper.js': 'module.exports = { helper: true };\n',
    },
    exclude: ['config/**'],
  });

  assert.ok(!call.user.includes('config/db.js'),
    'excluded imported file was appended to the review prompt');
  assert.ok(!call.user.includes('s3cretpass'),
    'excluded imported file leaked its secret into the review prompt');
  assert.ok(call.user.includes('src/helper.js'),
    'non-excluded imported file should still be appended');
});

test('runReview: a non-excluded imported file is appended, redacted', async () => {
  const call = await runWithTracedImports({
    files: {
      'config/db.js': `module.exports = { url: '${SECRET}' };\n`,
      'src/helper.js': 'module.exports = { helper: true };\n',
    },
    exclude: [],
  });

  assert.ok(call.user.includes('config/db.js'),
    'imported file should be appended when not excluded');
  assert.ok(!call.user.includes('s3cretpass'),
    'imported file reached the prompt with a clear-text password');
  assert.ok(call.user.includes('[REDACTED]'));
});

test('runReview: traced imports are marked read-only context', async () => {
  const call = await runWithTracedImports({
    files: { 'src/helper.js': 'module.exports = { helper: true };\n' },
    exclude: [],
  });

  assert.ok(call.user.includes('src/helper.js'));
  assert.ok(/Imported files \(read-only context, do NOT review these\)/.test(call.user));
});
