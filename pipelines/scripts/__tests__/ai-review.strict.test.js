// @ts-check
'use strict';
const test = require('node:test');
const { describe, it } = test;
const assert = require('node:assert/strict');
const { parseArgs } = require('../ai-review.js');

describe('parseArgs --strict', () => {
  it('defaults strict to undefined when flag absent', () => {
    assert.equal(parseArgs(['review']).strict, undefined);
  });

  it('parses --strict as boolean true', () => {
    assert.equal(parseArgs(['review', '--strict']).strict, true);
  });

  it('parses --strict=true / --strict=false', () => {
    assert.equal(parseArgs(['review', '--strict=true']).strict, true);
    assert.equal(parseArgs(['review', '--strict=false']).strict, false);
  });

  it('--strict=false explicit override returns false (not undefined)', () => {
    const r = parseArgs(['review', '--strict=false']);
    assert.equal(r.strict, false);
  });
});

test('runReview --strict exits 8 when critical finding posted (above medium threshold)', async () => {
  const path = require('node:path');
  const fs = require('node:fs');
  const os = require('node:os');
  const providerIndex = require('../lib/providers/index.js');
  const llmIndex = require('../lib/llm/index.js');
  const { runReview } = require('../ai-review.js');

  let summaryBody = '';
  const origMake = providerIndex.makeProvider;
  const origMakeLLM = llmIndex.makeLLMProvider;
  providerIndex.makeProvider = () => ({
    getPRMetadata: async () => ({ id: '99', title: 'T', sourceBranch: 'h', targetBranch: 'b', sourceSha: 's1', targetSha: 's0', authorEmail: 'x', url: 'u' }),
    getDiff: async () => [{ path: 'src/x.js', change: 'add', patch: '@@ -0,0 +1,1 @@\n+const k = "hardcoded";\n' }],
    listThreads: async () => [],
    postThread: async () => ({ threadId: 'T1', commentId: 1 }),
    replyToThread: async () => ({}),
    patchThreadStatus: async () => ({}),
    upsertSummaryComment: async (_marker, body) => { summaryBody = body; return { id: '1', action: 'created' }; },
    renderSummaryMarker: () => '<!-- ai-review:v1:summary -->',
  });
  llmIndex.makeLLMProvider = () => ({
    call: async () => ({
      text: JSON.stringify({ summary: 's', findings: [
        { file: 'src/x.js', line: 1, severity: 'CRITICAL', category: 'security', message: 'hardcoded secret' },
      ]}),
      usage: { inputTokens: 10, outputTokens: 5 },
      cost: { inputCost: 0, outputCost: 0, totalCost: 0.001 },
    }),
  });

  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-review-strict-'));
  fs.writeFileSync(path.join(cfgDir, 'ai-review.config.yaml'),
    'provider: github\nauth:\n  anthropicKey: ${ANTHROPIC_API_KEY}\n  token: ${GITHUB_TOKEN}\n',
  );

  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = () => true;

  let code;
  try {
    code = await runReview({
      argv: ['review', '--strict'],
      env: {
        ANTHROPIC_API_KEY: 'k', GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r',
        GITHUB_REF: 'refs/pull/99/head',
      },
      cwd: cfgDir,
    });
  } finally {
    process.stdout.write = origWrite;
    providerIndex.makeProvider = origMake;
    llmIndex.makeLLMProvider = origMakeLLM;
    fs.rmSync(cfgDir, { recursive: true, force: true });
  }

  assert.equal(code, 8, 'exit 8 expected when strict + critical');
  assert.match(summaryBody, /Strict mode: 1 blocking finding/);
  assert.match(summaryBody, /severity ≥ `medium`/);
});

test('runReview --strict exits 0 when only low-severity finding found (dropped below medium threshold, never posted)', async () => {
  const path = require('node:path');
  const fs = require('node:fs');
  const os = require('node:os');
  const providerIndex = require('../lib/providers/index.js');
  const llmIndex = require('../lib/llm/index.js');
  const { runReview } = require('../ai-review.js');

  const origMake = providerIndex.makeProvider;
  const origMakeLLM = llmIndex.makeLLMProvider;
  providerIndex.makeProvider = () => ({
    getPRMetadata: async () => ({ id: '99', title: 'T', sourceBranch: 'h', targetBranch: 'b', sourceSha: 's1', targetSha: 's0', authorEmail: 'x', url: 'u' }),
    getDiff: async () => [{ path: 'src/y.js', change: 'add', patch: '@@ -0,0 +1,1 @@\n+let x;\n' }],
    listThreads: async () => [],
    postThread: async () => ({ threadId: 'T1', commentId: 1 }),
    replyToThread: async () => ({}),
    patchThreadStatus: async () => ({}),
    upsertSummaryComment: async () => ({ id: '1', action: 'created' }),
    renderSummaryMarker: () => '<!-- ai-review:v1:summary -->',
  });
  llmIndex.makeLLMProvider = () => ({
    call: async () => ({
      text: JSON.stringify({ summary: 's', findings: [
        { file: 'src/y.js', line: 1, severity: 'LOW', category: 'bug', message: 'unused var' },
      ]}),
      usage: { inputTokens: 10, outputTokens: 5 },
      cost: { inputCost: 0, outputCost: 0, totalCost: 0.001 },
    }),
  });

  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-review-strict-'));
  fs.writeFileSync(path.join(cfgDir, 'ai-review.config.yaml'),
    'provider: github\nauth:\n  anthropicKey: ${ANTHROPIC_API_KEY}\n  token: ${GITHUB_TOKEN}\n',
  );

  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = () => true;

  let code;
  try {
    code = await runReview({
      argv: ['review', '--strict'],
      env: {
        ANTHROPIC_API_KEY: 'k', GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r',
        GITHUB_REF: 'refs/pull/99/head',
      },
      cwd: cfgDir,
    });
  } finally {
    process.stdout.write = origWrite;
    providerIndex.makeProvider = origMake;
    llmIndex.makeLLMProvider = origMakeLLM;
    fs.rmSync(cfgDir, { recursive: true, force: true });
  }

  assert.equal(code, 0, 'exit 0 expected: low finding dropped below threshold, no activity');
});

// ---------------------------------------------------------------------------
// Strict gate vs write failures. The gate is decided from the action plan
// before anything is posted, so a run can hold a blocking finding AND have a
// write fail. 8 has to win: action-entry.js fails the job for any code > 1
// except 6, so returning 6 would let the gate be bypassed by an unrelated
// write error.
// ---------------------------------------------------------------------------

const STRICT_CRITICAL = {
  file: 'src/x.js', line: 1, severity: 'CRITICAL', category: 'security',
  message: 'hardcoded secret',
};
const STRICT_MEDIUM = {
  file: 'src/x.js', line: 1, severity: 'MEDIUM', category: 'bug', message: 'issue',
};

const writeBoom = async () => { throw new Error('502 from provider'); };

/** Drive a real `runReview` with one write path failing. Returns the exit code and JSON. */
async function runWithFailingWrite({ strict, finding, postThreadImpl, upsertImpl }) {
  const path = require('node:path');
  const fs = require('node:fs');
  const os = require('node:os');
  const providerIndex = require('../lib/providers/index.js');
  const llmIndex = require('../lib/llm/index.js');
  const { runReview } = require('../ai-review.js');

  const origMake = providerIndex.makeProvider;
  const origMakeLLM = llmIndex.makeLLMProvider;
  providerIndex.makeProvider = () => ({
    getPRMetadata: async () => ({ id: '99', title: 'T', sourceBranch: 'h', targetBranch: 'b', sourceSha: 's1', targetSha: 's0', authorEmail: 'x', url: 'u' }),
    getDiff: async () => [{ path: 'src/x.js', change: 'add', patch: '@@ -0,0 +1,1 @@\n+const k = "hardcoded";\n' }],
    listThreads: async () => [],
    postThread: postThreadImpl ?? (async () => ({ threadId: 'T1', commentId: 1 })),
    replyToThread: async () => ({}),
    patchThreadStatus: async () => ({}),
    upsertSummaryComment: upsertImpl ?? (async () => ({ id: '1', action: 'created' })),
    renderSummaryMarker: () => '<!-- ai-review:v1:summary -->',
  });
  llmIndex.makeLLMProvider = () => ({
    call: async () => ({
      text: JSON.stringify({ summary: 's', findings: [finding] }),
      usage: { inputTokens: 10, outputTokens: 5 },
      cost: { inputCost: 0, outputCost: 0, totalCost: 0.001 },
    }),
  });

  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-review-strict-'));
  fs.writeFileSync(path.join(cfgDir, 'ai-review.config.yaml'),
    'provider: github\nauth:\n  anthropicKey: ${ANTHROPIC_API_KEY}\n  token: ${GITHUB_TOKEN}\n',
  );

  const origWrite = process.stdout.write.bind(process.stdout);
  const writes = [];
  process.stdout.write = (chunk) => { writes.push(String(chunk)); return true; };

  try {
    const code = await runReview({
      argv: strict ? ['review', '--strict'] : ['review'],
      env: {
        ANTHROPIC_API_KEY: 'k', GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r',
        GITHUB_REF: 'refs/pull/99/head',
      },
      cwd: cfgDir,
    });
    const line = writes.map((w) => w.trim()).find((w) => w.startsWith('{'));
    return { code, output: line ? JSON.parse(line) : null };
  } finally {
    process.stdout.write = origWrite;
    providerIndex.makeProvider = origMake;
    llmIndex.makeLLMProvider = origMakeLLM;
    fs.rmSync(cfgDir, { recursive: true, force: true });
  }
}

test('runReview: strict gate wins over a failed write (exit 8, not 6)', async () => {
  const { code, output } = await runWithFailingWrite({
    strict: true, finding: STRICT_CRITICAL, postThreadImpl: writeBoom,
  });
  assert.equal(code, 8, 'a blocking finding must fail CI even when a write failed');
  assert.equal(output.strict.triggered, true);
  assert.equal(output.failures, 1, 'the failure must stay visible in the JSON');
});

test('runReview: a failed write without a strict gate still exits 6', async () => {
  const { code, output } = await runWithFailingWrite({
    strict: false, finding: STRICT_MEDIUM, postThreadImpl: writeBoom,
  });
  assert.equal(code, 6);
  assert.equal(output.strict.triggered, false);
  assert.equal(output.failures, 1);
});

test('runReview: a failed summary upsert also yields to the strict gate', async () => {
  const { code, output } = await runWithFailingWrite({
    strict: true, finding: STRICT_CRITICAL, upsertImpl: writeBoom,
  });
  assert.equal(code, 8);
  assert.equal(output.failures, 1);
});
