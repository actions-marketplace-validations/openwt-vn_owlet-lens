'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// Inject a fake provider via the module the registry uses.
const providerIndex = require('../lib/providers/index.js');
const { runReview } = require('../ai-review.js');
const { InMemoryGitHub } = require('./contract/in-memory-github.js');

function withTempCwd(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-review-dry-'));
  fs.writeFileSync(path.join(tmp, 'ai-review.config.yaml'),
    'provider: github\nauth:\n  anthropicKey: ${ANTHROPIC_API_KEY}\n  token: ${GITHUB_TOKEN}\n',
  );
  try { return fn(tmp); } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

test('runReview --dry-run skips provider mutations and prints dryRun JSON', async () => {
  const fake = new InMemoryGitHub({ prNumber: 1 });
  fake.setFiles([{ filename: 'src/a.ts', status: 'added', patch: '@@ -0,0 +1,2 @@\n+line1\n+line2' }]);

  const origMake = providerIndex.makeProvider;
  providerIndex.makeProvider = () => ({
    getPRMetadata: async () => ({ id: '1', title: 'T', sourceBranch: 'h', targetBranch: 'b', sourceSha: 's1', targetSha: 's0', authorEmail: 'x', url: 'u' }),
    getDiff: async () => [{ path: 'src/a.ts', change: 'add', patch: '@@ -0,0 +1,2 @@\n+line1\n+line2' }],
    listThreads: async () => [],
    postThread: async () => { throw new Error('postThread should not be called in dry-run'); },
    replyToThread: async () => { throw new Error('replyToThread should not be called in dry-run'); },
    patchThreadStatus: async () => { throw new Error('patchThreadStatus should not be called in dry-run'); },
    upsertSummaryComment: async () => { throw new Error('upsertSummaryComment should not be called in dry-run'); },
  });

  // Stub LLM factory to deterministically return one finding.
  const llmIndex = require('../lib/llm/index.js');
  const origMakeLLM = llmIndex.makeLLMProvider;
  llmIndex.makeLLMProvider = () => ({
    call: async () => ({
      text: JSON.stringify({ summary: 's', findings: [
        { file: 'src/a.ts', line: 1, severity: 'HIGH', category: 'security', message: 'fake finding' },
      ]}),
      usage: { inputTokens: 10, outputTokens: 5 },
      cost: { inputCost: 0, outputCost: 0, totalCost: 0.001 },
    }),
  });

  let captured = '';
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s) => { captured += s; return true; };

  try {
    await withTempCwd(async (cwd) => {
      const code = await runReview({
        argv: ['review', '--dry-run'],
        env: {
          ANTHROPIC_API_KEY: 'k', GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r',
          GITHUB_REF: 'refs/pull/1/head',
        },
        cwd,
      });
      assert.equal(code, 0, 'dry-run should exit 0 even with new findings');
    });
  } finally {
    process.stdout.write = origWrite;
    providerIndex.makeProvider = origMake;
    llmIndex.makeLLMProvider = origMakeLLM;
  }

  const json = JSON.parse(captured.trim().split('\n').pop());
  assert.equal(json.dryRun, true);
  assert.ok(Array.isArray(json.wouldPost));
  assert.equal(json.wouldPost.length, 1);
  assert.equal(json.wouldPost[0].filePath, 'src/a.ts');
  assert.equal(json.wouldPost[0].line, 1);
  assert.equal(json.summaryAction, 'would-create');
});

const { runReply } = require('../ai-review.js');

test('runReply --dry-run prints verdicts without posting', async () => {
  const providerIndex = require('../lib/providers/index.js');
  const replyEvaluator = require('../lib/port/reply-evaluator.js');
  const origMake = providerIndex.makeProvider;
  const origEval = replyEvaluator.evaluate;

  providerIndex.makeProvider = () => ({
    listThreads: async () => [{
      id: 'T1', status: 'active', filePath: 'a.ts', line: 1,
      comments: [
        { id: '1', body: '**[HIGH/security]** issue\n<!-- ai-review:v1:active -->', isBot: true, createdAt: '2026-01-01T00:00:00Z', authorEmail: 'b' },
        { id: '2', body: 'fixed it', isBot: false, createdAt: '2026-01-02T00:00:00Z', authorEmail: 'd' },
      ],
      marker: { version: 'v1' },
    }],
    replyToThread: async () => { throw new Error('should not post in dry-run'); },
    patchThreadStatus: async () => { throw new Error('should not patch in dry-run'); },
    markers: {
      hasKey: () => false,
      appendKey: (/** @type {string} */ b, /** @type {string} */ k) => `${b}\n\n<!-- ai-review:v1:${k} -->`,
    },
  });
  replyEvaluator.evaluate = async () => ({ verdict: 'fixed', reasoning: 'looks fixed' });

  const path = require('node:path');
  const fs = require('node:fs');
  const os = require('node:os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-reply-dry-'));
  fs.writeFileSync(path.join(tmp, 'ai-review.config.yaml'),
    'provider: github\nauth:\n  anthropicKey: ${ANTHROPIC_API_KEY}\n  token: ${GITHUB_TOKEN}\n',
  );

  let captured = '';
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s) => { captured += s; return true; };

  try {
    const code = await runReply({
      argv: ['reply', '--dry-run'],
      env: {
        ANTHROPIC_API_KEY: 'k', GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r',
        GITHUB_REF: 'refs/pull/1/head',
      },
      cwd: tmp,
    });
    assert.equal(code, 0);
  } finally {
    process.stdout.write = origWrite;
    providerIndex.makeProvider = origMake;
    replyEvaluator.evaluate = origEval;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const json = JSON.parse(captured.trim().split('\n').pop());
  assert.equal(json.dryRun, true);
  assert.equal(json.wouldReply.length, 1);
  assert.equal(json.wouldReply[0].verdict, 'fixed');
});

const stateStore = require('../lib/port/state-store.js');

test('runReview appends invocation to state-store after Claude call', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-state-int-'));

  const providerIndex = require('../lib/providers/index.js');
  const llmIndex = require('../lib/llm/index.js');
  const origMake = providerIndex.makeProvider;
  const origMakeLLM = llmIndex.makeLLMProvider;

  providerIndex.makeProvider = () => ({
    getPRMetadata: async () => ({ id: '5', title: 'T', sourceBranch: 'h', targetBranch: 'b', sourceSha: 's1', targetSha: 's0', authorEmail: 'x', url: 'u' }),
    getDiff: async () => [],
    listThreads: async () => [],
    postThread: async () => ({}),
    replyToThread: async () => ({}),
    patchThreadStatus: async () => ({}),
    upsertSummaryComment: async () => ({ id: '1', action: 'created' }),
  });
  llmIndex.makeLLMProvider = () => ({
    call: async () => ({
      text: JSON.stringify({ summary: 's', findings: [] }),
      usage: { inputTokens: 10, outputTokens: 5 },
      cost: { inputCost: 0, outputCost: 0, totalCost: 0.0042 },
    }),
  });

  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-review-cfg-'));
  fs.writeFileSync(path.join(cfgDir, 'ai-review.config.yaml'),
    'provider: github\nauth:\n  anthropicKey: ${ANTHROPIC_API_KEY}\n  token: ${GITHUB_TOKEN}\n',
  );

  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = () => true;

  try {
    await runReview({
      argv: ['review'],
      env: {
        ANTHROPIC_API_KEY: 'k', GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r',
        GITHUB_REF: 'refs/pull/5/head', AI_REVIEW_STATE_ROOT: tmpRoot,
      },
      cwd: cfgDir,
    });
  } finally {
    process.stdout.write = origWrite;
    providerIndex.makeProvider = origMake;
    llmIndex.makeLLMProvider = origMakeLLM;
  }

  const rec = stateStore.load({ repo: 'o/r', prNumber: 5, root: tmpRoot });
  assert.equal(rec.invocations.length, 1);
  assert.equal(rec.invocations[0].type, 'review');
  assert.ok(rec.cumulativeCostUsd > 0);

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.rmSync(cfgDir, { recursive: true, force: true });
});
