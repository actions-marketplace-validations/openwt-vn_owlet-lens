'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runReply } = require('../ai-review.js');
const providerIndex = require('../lib/providers/index.js');
const llmIndex = require('../lib/llm/index.js');

function makeTmpConfigDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-reply-ctx-'));
  fs.writeFileSync(
    path.join(tmp, 'ai-review.config.yaml'),
    'provider: github\nauth:\n  anthropicKey: ${ANTHROPIC_API_KEY}\n  token: ${GITHUB_TOKEN}\n',
  );
  return tmp;
}

function makeFakeProvider({ threads = [], diff = [], pr = { sourceSha: 'HEADSHA' }, getFileContent } = {}) {
  const calls = { getDiff: 0, getPRMetadata: 0, getFileContent: 0 };
  return {
    calls,
    listThreads: async () => threads,
    getDiff: async () => { calls.getDiff += 1; return diff; },
    getPRMetadata: async () => { calls.getPRMetadata += 1; return pr; },
    getFileContent: async (p, ref) => {
      calls.getFileContent += 1;
      return getFileContent ? getFileContent(p, ref) : 'content';
    },
    replyToThread: async () => ({ id: 'r' }),
    patchThreadStatus: async () => undefined,
  };
}

function makeFakeLLM({ text = '{"verdict":"active","reasoning":"r"}', capturePrompts } = {}) {
  return {
    call: async (sys, usr, opts) => {
      if (capturePrompts) capturePrompts.push({ sys, usr, opts });
      return { text, cost: { totalCost: 0.0001 }, usage: {} };
    },
  };
}

function aiThread(overrides = {}) {
  return {
    id: 'T1', status: 'active', filePath: 'src/a.js', line: 5,
    comments: [
      { id: '1', isBot: true, body: 'finding<!-- ai-review:v1:active -->', createdAt: '2026-01-01', authorEmail: 'bot' },
      { id: '2', isBot: false, body: 'fixed it', createdAt: '2026-01-02', authorEmail: 'dev' },
    ],
    marker: { version: 'v1' },
    ...overrides,
  };
}

function withFakes(fakes, fn) {
  const origMake = providerIndex.makeProvider;
  const origMakeLLM = llmIndex.makeLLMProvider;
  providerIndex.makeProvider = () => fakes.provider;
  llmIndex.makeLLMProvider = () => fakes.llmProvider;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      providerIndex.makeProvider = origMake;
      llmIndex.makeLLMProvider = origMakeLLM;
    });
}

test('runReply: fetches PR diff + metadata exactly once across N threads', async () => {
  const provider = makeFakeProvider({
    threads: [aiThread({ id: 'T1' }), aiThread({ id: 'T2', filePath: 'src/b.js' })],
    diff: [
      { path: 'src/a.js', change: 'modify', patch: '@@ a @@' },
      { path: 'src/b.js', change: 'modify', patch: '@@ b @@' },
    ],
  });
  const llmProvider = makeFakeLLM();
  const tmp = makeTmpConfigDir();
  try {
    await withFakes({ provider, llmProvider }, () => runReply({
      argv: ['reply', '--dry-run'],
      env: {
        ANTHROPIC_API_KEY: 'k', GITHUB_TOKEN: 't',
        GITHUB_REPOSITORY: 'o/r', GITHUB_REF: 'refs/pull/1/head',
      },
      cwd: tmp,
    }));
    assert.equal(provider.calls.getDiff, 1);
    assert.equal(provider.calls.getPRMetadata, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('runReply: forwards fullThread + codeSnippet + diffSlice into evaluator prompt', async () => {
  const captured = [];
  const provider = makeFakeProvider({
    threads: [aiThread()],
    diff: [{ path: 'src/a.js', change: 'modify', patch: '@@ unified diff @@' }],
    getFileContent: () => Array.from({ length: 12 }, (_, i) => `line${i + 1}`).join('\n'),
  });
  const llmProvider = makeFakeLLM({ capturePrompts: captured });
  const tmp = makeTmpConfigDir();
  try {
    await withFakes({ provider, llmProvider }, () => runReply({
      argv: ['reply', '--dry-run'],
      env: {
        ANTHROPIC_API_KEY: 'k', GITHUB_TOKEN: 't',
        GITHUB_REPOSITORY: 'o/r', GITHUB_REF: 'refs/pull/1/head',
      },
      cwd: tmp,
    }));
    assert.equal(captured.length, 1);
    assert.ok(captured[0].usr.includes('## Full thread transcript'));
    assert.ok(captured[0].usr.includes('## Current code at finding location'));
    assert.ok(captured[0].usr.includes('## Diff slice'));
    assert.ok(captured[0].usr.includes('@@ unified diff @@'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('runReply: getDiff throw → warn and continue with minimal context', async () => {
  const provider = makeFakeProvider({ threads: [aiThread()] });
  provider.getDiff = async () => { throw new Error('boom'); };
  const captured = [];
  const llmProvider = makeFakeLLM({ capturePrompts: captured });

  const origStderr = process.stderr.write.bind(process.stderr);
  const stderrLines = [];
  process.stderr.write = (chunk) => { stderrLines.push(String(chunk)); return true; };

  const tmp = makeTmpConfigDir();
  try {
    await withFakes({ provider, llmProvider }, () => runReply({
      argv: ['reply', '--dry-run'],
      env: {
        ANTHROPIC_API_KEY: 'k', GITHUB_TOKEN: 't',
        GITHUB_REPOSITORY: 'o/r', GITHUB_REF: 'refs/pull/1/head',
      },
      cwd: tmp,
    }));
  } finally {
    process.stderr.write = origStderr;
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  const warned = stderrLines.some((l) => l.includes('PR diff/head fetch failed'));
  assert.ok(warned, 'warn logged when getDiff fails');
  assert.equal(captured.length, 1, 'evaluator still ran');
  assert.ok(!captured[0].usr.includes('## Diff slice'), 'no diff slice when diff fetch failed');
});

test('runReply: loads codingStandards + contextPaths from config and forwards into LLM system prompt', async () => {
  const captured = [];
  const provider = makeFakeProvider({
    threads: [aiThread()],
    diff: [{ path: 'src/a.js', change: 'modify', patch: '@@ a @@' }],
  });
  const llmProvider = makeFakeLLM({ capturePrompts: captured });

  // Build a temp config dir with coding-standards + context files referenced
  // from ai-review.config.yaml. runReply should resolve them relative to cwd.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-reply-cs-'));
  fs.writeFileSync(path.join(tmp, 'standards.md'), 'PROJECT_STANDARDS_SENTINEL_TOKEN\n');
  fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), 'PROJECT_CONTEXT_SENTINEL_TOKEN\n');
  fs.writeFileSync(
    path.join(tmp, 'ai-review.config.yaml'),
    'provider: github\n'
      + 'auth:\n  anthropicKey: ${ANTHROPIC_API_KEY}\n  token: ${GITHUB_TOKEN}\n'
      + 'review:\n'
      + '  codingStandardsPath: ./standards.md\n'
      + '  contextPaths:\n    - ./CLAUDE.md\n',
  );

  try {
    await withFakes({ provider, llmProvider }, () => runReply({
      argv: ['reply', '--dry-run'],
      env: {
        ANTHROPIC_API_KEY: 'k', GITHUB_TOKEN: 't',
        GITHUB_REPOSITORY: 'o/r', GITHUB_REF: 'refs/pull/1/head',
      },
      cwd: tmp,
    }));
    assert.equal(captured.length, 1, 'evaluator called exactly once');
    assert.ok(captured[0].sys.includes('PROJECT_STANDARDS_SENTINEL_TOKEN'),
      'coding-standards content reached the LLM system prompt');
    assert.ok(captured[0].sys.includes('PROJECT_CONTEXT_SENTINEL_TOKEN'),
      'projectContext content reached the LLM system prompt');
    assert.ok(captured[0].sys.includes('=== BEGIN PROJECT CODING STANDARDS (reference only'),
      'coding-standards wrapped in reference-only delimiter');
    assert.ok(captured[0].sys.includes('=== BEGIN PROJECT CONTEXT (reference only'),
      'projectContext wrapped in reference-only delimiter');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
