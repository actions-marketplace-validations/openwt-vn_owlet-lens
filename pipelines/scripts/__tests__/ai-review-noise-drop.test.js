// @ts-check
'use strict';

// Integration coverage for the noise-drop wiring in `runReview`'s
// post-validation loop (ai-review.js, right after `validateFindings`).
// noise-filter.test.js unit-tests `shouldDropAsNoise` in isolation with
// hand-built `opts` objects; it cannot prove that the REAL config
// (`review.testFileSeverityThreshold` / `review.noiseCategories` defaults,
// as resolved by the real `loadConfig` YAML path) actually flows through to
// the drop decision. These tests drive the real `runReview` end-to-end,
// mocking only the provider and LLM layers, following the exact pattern used
// in `ai-review.strict.test.js`.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const providerIndex = require('../lib/providers/index.js');
const llmIndex = require('../lib/llm/index.js');
const { runReview } = require('../ai-review.js');

/**
 * Drives a real `runReview({ argv: [..., '--dry-run'], env, cwd })` call
 * against a minimal-default real YAML config, with only the provider and
 * LLM layers mocked. Captures the single dry-run JSON line `runReview`
 * writes to stdout and returns it parsed.
 *
 * @param {{ diffPath: string, patch: string, finding: object }} args
 */
async function runDryRun({ diffPath, patch, finding }) {
  const origMakeProvider = providerIndex.makeProvider;
  const origMakeLLM = llmIndex.makeLLMProvider;

  providerIndex.makeProvider = () => ({
    getPRMetadata: async () => ({
      id: '42', title: 'T', sourceBranch: 'h', targetBranch: 'b',
      sourceSha: 's1', targetSha: 's0', authorEmail: 'x', url: 'u',
    }),
    getDiff: async () => [{ path: diffPath, change: 'add', patch }],
    listThreads: async () => [],
    postThread: async () => ({ threadId: 'T1', commentId: 1 }),
    replyToThread: async () => ({}),
    patchThreadStatus: async () => ({}),
    upsertSummaryComment: async () => ({ id: '1', action: 'created' }),
    renderSummaryMarker: () => '<!-- ai-review:v1:summary -->',
  });
  llmIndex.makeLLMProvider = () => ({
    call: async () => ({
      text: JSON.stringify({ summary: 's', findings: [finding] }),
      usage: { inputTokens: 10, outputTokens: 5 },
      cost: { inputCost: 0, outputCost: 0, totalCost: 0.001 },
    }),
  });

  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-review-noise-drop-'));
  fs.writeFileSync(path.join(cfgDir, 'ai-review.config.yaml'),
    'provider: github\nauth:\n  anthropicKey: ${ANTHROPIC_API_KEY}\n  token: ${GITHUB_TOKEN}\n',
  );

  const origWrite = process.stdout.write.bind(process.stdout);
  const writes = [];
  process.stdout.write = (chunk) => { writes.push(chunk); return true; };

  let code;
  try {
    code = await runReview({
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

  const jsonLine = writes.find((w) => typeof w === 'string' && w.includes('"dryRun"'));
  assert.ok(jsonLine, 'expected a dry-run JSON line on stdout');
  return { code, output: JSON.parse(jsonLine) };
}

test('runReview: MEDIUM finding on a test file is dropped end-to-end by the real testFileSeverityThreshold default (high)', async () => {
  const { output } = await runDryRun({
    diffPath: 'src/handler.test.js',
    patch: '@@ -0,0 +1,1 @@\n+const x = 1;\n',
    finding: {
      file: 'src/handler.test.js', line: 1, severity: 'MEDIUM', category: 'bug',
      message: 'possible issue in test setup',
    },
  });
  assert.deepEqual(output.wouldPost, [],
    'MEDIUM finding on a test file should be dropped by the default testFileSeverityThreshold (high) gate');
});

test('runReview: LOW/style finding on a non-test file is dropped end-to-end by the real noiseCategories default', async () => {
  const { output } = await runDryRun({
    diffPath: 'src/handler.js',
    patch: '@@ -0,0 +1,1 @@\n+const x = 1;\n',
    finding: {
      file: 'src/handler.js', line: 1, severity: 'LOW', category: 'style',
      message: 'minor style nit',
    },
  });
  assert.deepEqual(output.wouldPost, [],
    'LOW/style finding on a non-test file should be dropped by the default noiseCategories gate');
});
