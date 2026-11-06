// @ts-check
'use strict';

// Integration coverage for `review.tokenBudget` (issue #90): the config key
// must reach `runReviewPass` and drive overflow chunking. A regression in the
// wiring would silently keep the 512000 default and send a large PR whole — the
// exact failure #90 describes. Drives the real `runReview` end-to-end, mocking
// only the provider and LLM layers, following `ai-review-traced-imports.test.js`.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const providerIndex = require('../lib/providers/index.js');
const llmIndex = require('../lib/llm/index.js');
const { runReview } = require('../ai-review.js');
const { buildPrompt, estimateTokens, renderPrHeader } = require('../lib/prompt-builder.js');

const ADD2 = '@@ -0,0 +1,2 @@\n+const a = 1;\n+const b = 2;\n';

/**
 * Drive a real `runReview({ argv: [..., '--dry-run'] })` with two small changed
 * files, capturing every review-path LLM call.
 *
 * @param {number|null} tokenBudget `review.tokenBudget`; null omits the key.
 * @returns {Promise<Array<{ sys: string, user: string }>>}
 */
async function runWithBudget(tokenBudget) {
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
    getDiff: async () => [
      { path: 'src/a.js', change: 'add', patch: ADD2 },
      { path: 'src/b.js', change: 'add', patch: ADD2 },
    ],
    listThreads: async () => [],
    renderSummaryMarker: () => '<!-- ai-review:v1:summary -->',
  });
  llmIndex.makeLLMProvider = llmStub;

  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-review-budget-'));
  const cfg = 'provider: github\nauth:\n  anthropicKey: ${ANTHROPIC_API_KEY}\n  token: ${GITHUB_TOKEN}\n'
    + (tokenBudget == null ? '' : `review:\n  tokenBudget: ${tokenBudget}\n`);
  fs.writeFileSync(path.join(cfgDir, 'ai-review.config.yaml'), cfg);

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

  // Only the prompts carrying file diffs (main + overflow chunks). Reflection
  // never runs: there are no findings.
  return calls.filter((c) => c.user.includes('=== src/'));
}

test('runReview: a low review.tokenBudget moves overflow files to a chunk call', async () => {
  const prInfo = { prId: '42', title: 'T' };
  const sysTokens = estimateTokens(buildPrompt({ fileDiffs: [], prInfo }).systemPrompt);
  const headerTokens = estimateTokens(renderPrHeader(prInfo));
  const perFile = estimateTokens('1:+const a = 1;\n2:+const b = 2;\n') + estimateTokens('src/a.js') + 10;
  // System prompt + PR header + exactly one file fits; the second overflows into a chunk.
  const calls = await runWithBudget(sysTokens + headerTokens + perFile + 5);

  assert.equal(calls.length, 2, 'expected the main call plus one overflow chunk');
  assert.match(calls[0].user, /=== src\/a\.js ===/);
  assert.match(calls[1].user, /=== src\/b\.js ===/);
});

test('runReview: the default review.tokenBudget fits both small files in one call', async () => {
  const calls = await runWithBudget(null);
  assert.equal(calls.length, 1, 'a small PR must not be chunked at the 512000 default');
  assert.match(calls[0].user, /=== src\/a\.js ===/);
  assert.match(calls[0].user, /=== src\/b\.js ===/);
});
