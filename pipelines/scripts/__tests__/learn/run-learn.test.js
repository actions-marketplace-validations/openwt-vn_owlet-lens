// @ts-check
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { __test__, runLearn } = require('../../ai-review.js');
const { runLearnWith } = __test__;

function fakeProvider({ canPropose = true, proposeResult = { url: 'http://pr/9' } } = {}) {
  const calls = { propose: 0 };
  return {
    calls,
    capabilities: { canProposeChanges: canPropose },
    async proposeStandardsChange() { calls.propose++; return proposeResult; },
  };
}

describe('runLearnWith', () => {
  const cfgLearn = { lookbackDays: 45, minWontfix: 2, minDistinctAuthors: 1, maxPrs: 200, branchPrefix: 'owlet-lens/learn', ignorePath: null };

  it('exits 0 and does NOT propose when provider cannot propose', async () => {
    const provider = fakeProvider({ canPropose: false });
    const code = await runLearnWith({
      provider, cfgLearn, dryRun: false,
      buildProposal: async () => ({ rules: [{}], newContent: 'x' }),
      readStandards: () => '# S', baseBranch: 'develop', standardsPath: 'coding-standards.md',
      nowISO: '2026-06-04T00:00:00Z',
    });
    assert.equal(code, 0);
    assert.equal(provider.calls.propose, 0);
  });

  it('exits 0 and does NOT propose on dry-run', async () => {
    const provider = fakeProvider();
    const code = await runLearnWith({
      provider, cfgLearn, dryRun: true,
      buildProposal: async () => ({ rules: [{ rule: 'r' }], newContent: 'NEW' }),
      readStandards: () => '# S', baseBranch: 'develop', standardsPath: 'coding-standards.md',
      nowISO: '2026-06-04T00:00:00Z',
    });
    assert.equal(code, 0);
    assert.equal(provider.calls.propose, 0);
  });

  it('exits 1 and proposes when novel rules exist', async () => {
    const provider = fakeProvider();
    const code = await runLearnWith({
      provider, cfgLearn, dryRun: false,
      buildProposal: async () => ({ rules: [{ rule: 'r' }], newContent: 'NEW' }),
      readStandards: () => '# S', baseBranch: 'develop', standardsPath: 'coding-standards.md',
      nowISO: '2026-06-04T00:00:00Z',
    });
    assert.equal(code, 1);
    assert.equal(provider.calls.propose, 1);
  });

  it('exits 0 when nothing to propose', async () => {
    const provider = fakeProvider();
    const code = await runLearnWith({
      provider, cfgLearn, dryRun: false,
      buildProposal: async () => null,
      readStandards: () => '# S', baseBranch: 'develop', standardsPath: 'coding-standards.md',
      nowISO: '2026-06-04T00:00:00Z',
    });
    assert.equal(code, 0);
    assert.equal(provider.calls.propose, 0);
  });

  it('throws on invalid nowISO (guards Date.parse NaN)', async () => {
    const provider = fakeProvider();
    await assert.rejects(() => runLearnWith({
      provider, cfgLearn, dryRun: false,
      buildProposal: async () => null,
      readStandards: () => '# S', baseBranch: 'develop', standardsPath: 'coding-standards.md',
      nowISO: 'not-a-date',
    }), /invalid nowISO/);
    assert.equal(provider.calls.propose, 0);
  });
});

describe('runLearnWith: spend reporting (issue #89)', () => {
  const cfgLearn = { lookbackDays: 45, minWontfix: 2, minDistinctAuthors: 1, maxPrs: 200, branchPrefix: 'owlet-lens/learn', ignorePath: null };
  const usage = { inputTokens: 100, outputTokens: 40, cost: 0.0024, models: ['deepseek-clusterer'] };
  const opts = {
    cfgLearn, readStandards: () => '# S', baseBranch: 'develop',
    standardsPath: 'coding-standards.md', nowISO: '2026-06-04T00:00:00Z', model: 'primary-model',
  };

  function captureStdout() {
    const orig = process.stdout.write.bind(process.stdout);
    const writes = [];
    process.stdout.write = (chunk) => { writes.push(String(chunk)); return true; };
    return { restore() { process.stdout.write = orig; }, writes };
  }

  it('reports clustering spend in stdout JSON and to recordUsage when proposing', async () => {
    const provider = fakeProvider();
    const seen = [];
    const out = captureStdout();
    try {
      const code = await runLearnWith({
        ...opts, provider, dryRun: false,
        buildProposal: async () => ({ rules: [{ rule: 'r' }], newContent: 'NEW', usage }),
        recordUsage: (spend) => seen.push(spend),
      });
      assert.equal(code, 1);
      const json = JSON.parse(out.writes.join('').trim());
      assert.equal(json.proposed, true);
      assert.equal(json.costUsd, 0.0024);
      assert.equal(json.model, 'deepseek-clusterer');
      assert.equal(json.inputTokens, 100);
      assert.equal(json.outputTokens, 40);
      assert.deepEqual(seen, [{ costUsd: 0.0024, model: 'deepseek-clusterer', inputTokens: 100, outputTokens: 40 }]);
    } finally { out.restore(); }
  });

  it('reports spend even when nothing gets proposed (clustered but deduped)', async () => {
    const provider = fakeProvider();
    const seen = [];
    const out = captureStdout();
    try {
      const code = await runLearnWith({
        ...opts, provider, dryRun: false,
        buildProposal: async () => ({ rules: null, newContent: null, usage }),
        recordUsage: (spend) => seen.push(spend),
      });
      assert.equal(code, 0);
      assert.equal(provider.calls.propose, 0);
      const json = JSON.parse(out.writes.join('').trim());
      assert.equal(json.proposed, false);
      assert.equal(json.costUsd, 0.0024);
      assert.equal(json.model, 'deepseek-clusterer');
      assert.equal(seen.length, 1);
      assert.equal(seen[0].costUsd, 0.0024);
    } finally { out.restore(); }
  });

  it('falls back to the configured model when usage lists no model', async () => {
    const provider = fakeProvider();
    const seen = [];
    const out = captureStdout();
    try {
      const code = await runLearnWith({
        ...opts, provider, dryRun: false,
        buildProposal: async () => ({
          rules: [{ rule: 'r' }], newContent: 'NEW',
          usage: { inputTokens: 1, outputTokens: 1, cost: 0, models: [] },
        }),
        recordUsage: (spend) => seen.push(spend),
      });
      assert.equal(code, 1);
      const json = JSON.parse(out.writes.join('').trim());
      assert.equal(json.model, 'primary-model');
      assert.equal(seen[0].model, 'primary-model');
    } finally { out.restore(); }
  });
});

describe('runLearn', () => {
  it('runLearn returns 2 (ConfigError) when standards file is missing', async () => {
    const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'learnrun-'));
    fs.writeFileSync(path.join(dir, 'ai-review.config.yaml'),
      'provider: bitbucket\nreview:\n  provider: anthropic\n  codingStandardsPath: ./does-not-exist.md\n');
    const code = await runLearn({
      argv: ['learn', '--provider=bitbucket'],
      cwd: dir,
      env: { ANTHROPIC_API_KEY: 'k', BITBUCKET_TOKEN: 't', BITBUCKET_WORKSPACE: 'ws', BITBUCKET_REPO_SLUG: 'repo' },
    });
    assert.equal(code, 2);
  });

  it('writes a learn audit entry with cost and model (issue #89)', async () => {
    const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
    const providerIndex = require('../../lib/providers/index.js');
    const llmIndex = require('../../lib/llm/index.js');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'learn-audit-'));
    const auditPath = path.join(tmp, 'audit.jsonl');
    fs.writeFileSync(path.join(tmp, 'ai-review.config.yaml'),
      'provider: github\n'
        + 'auth:\n  anthropicKey: ${ANTHROPIC_API_KEY}\n  token: ${GITHUB_TOKEN}\n'
        + `review:\n  auditLogPath: ${auditPath}\n  codingStandardsPath: ./standards.md\n`
        + '  learn:\n    lookbackDays: 45\n    minWontfix: 2\n    minDistinctAuthors: 1\n');
    fs.writeFileSync(path.join(tmp, 'standards.md'), '# Standards\n');

    const origMake = providerIndex.makeProvider;
    const origMakeLLM = llmIndex.makeLLMProvider;
    providerIndex.makeProvider = () => ({
      repoSlug: 'o/r',
      capabilities: { canProposeChanges: true },
      getDefaultBranch: async () => 'main',
      // Empty harvest → buildProposal short-circuits before any LLM call, so
      // the audit entry proves the wiring exists with a zero-cost run.
      listMergedPRs: async () => [],
      listThreadsForPR: async () => [],
    });
    llmIndex.makeLLMProvider = () => ({
      call: async () => ({ text: '{}', usage: {}, cost: { totalCost: 0 }, model: 'clusterer' }),
    });

    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = () => true;
    try {
      const code = await runLearn({
        argv: ['learn'],
        env: { ANTHROPIC_API_KEY: 'k', GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r', AI_REVIEW_STATE_ROOT: tmp },
        cwd: tmp,
      });
      assert.equal(code, 0);
      const lines = fs.readFileSync(auditPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      assert.equal(lines.length, 1);
      assert.equal(lines[0].event, 'learn');
      assert.equal(lines[0].repo, 'o/r');
      assert.equal(lines[0].model, 'claude-opus-4-7');
      assert.equal(lines[0].costUsd, 0);
      assert.equal(lines[0].inputTokens, 0);
      assert.equal(lines[0].outputTokens, 0);
    } finally {
      process.stdout.write = origWrite;
      providerIndex.makeProvider = origMake;
      llmIndex.makeLLMProvider = origMakeLLM;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('learnPrBody', () => {
  const { learnPrBody } = __test__;

  it('renders rules as a Markdown table with one row each', () => {
    const body = learnPrBody([
      { category: 'performance', rule: 'Keep it atomic', rationale: 'sync contract', evidencePrs: ['2509'] },
      { category: 'bug', rule: 'Use unsignedInteger', rationale: 'matches increments id', evidencePrs: ['2476', '2501'] },
    ]);
    assert.match(body, /\| # \| Category \| Rule \| Why \| Evidence \|/);
    assert.match(body, /\|---\|/);
    assert.match(body, /\| 1 \| performance \| Keep it atomic \| sync contract \| #2509 \|/);
    assert.match(body, /\| 2 \| bug \| Use unsignedInteger \| matches increments id \| #2476, #2501 \|/);
  });

  it('escapes pipes and flattens newlines so a cell cannot break the table', () => {
    const body = learnPrBody([
      { category: 'style', rule: 'a | b', rationale: 'line1\nline2', evidencePrs: [] },
    ]);
    assert.match(body, /\| 1 \| style \| a \\\| b \| line1 line2 \|  \|/);
    // body row count: header + separator + 1 data row in the table region
    assert.equal((body.match(/^\|/gm) || []).length, 3);
  });
});
