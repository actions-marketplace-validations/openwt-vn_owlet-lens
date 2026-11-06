'use strict';

// The reply subcommand's audit entry. It used to read `meta.id` outside the
// block that declared `meta`; the ReferenceError was swallowed as a warn, so
// no reply audit line was ever written.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runReply } = require('../ai-review.js');
const providerIndex = require('../lib/providers/index.js');
const llmIndex = require('../lib/llm/index.js');

function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-reply-audit-'));
  const auditPath = path.join(tmp, 'audit.jsonl');
  fs.writeFileSync(
    path.join(tmp, 'ai-review.config.yaml'),
    'provider: github\nauth:\n  anthropicKey: ${ANTHROPIC_API_KEY}\n  token: ${GITHUB_TOKEN}\n'
      + `review:\n  auditLogPath: ${auditPath}\n`,
  );
  return { tmp, auditPath };
}

function botOnlyThread() {
  return {
    id: 'T1', status: 'active', filePath: 'src/a.js', line: 5,
    comments: [{ id: '1', isBot: true, body: 'finding<!-- ai-review:v1:active -->', createdAt: '2026-01-01' }],
    marker: { version: 'v1' },
  };
}

async function runWith(threads) {
  const { tmp, auditPath } = setup();
  const origMake = providerIndex.makeProvider;
  const origMakeLLM = llmIndex.makeLLMProvider;
  providerIndex.makeProvider = () => ({
    repoSlug: 'o/r',
    listThreads: async () => threads,
    getDiff: async () => [],
    getPRMetadata: async () => ({ id: '42', sourceSha: 'HEAD' }),
    getFileContent: async () => '',
    replyToThread: async () => ({}),
    patchThreadStatus: async () => undefined,
  });
  llmIndex.makeLLMProvider = () => ({ call: async () => ({ text: '{}', usage: {}, cost: { totalCost: 0 } }) });
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = () => true;
  try {
    const code = await runReply({
      argv: ['reply'],
      env: {
        ANTHROPIC_API_KEY: 'k', GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r',
        GITHUB_REF: 'refs/pull/7/head', AI_REVIEW_STATE_ROOT: tmp,
      },
      cwd: tmp,
    });
    const lines = fs.existsSync(auditPath)
      ? fs.readFileSync(auditPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
      : [];
    return { code, lines };
  } finally {
    process.stdout.write = origWrite;
    providerIndex.makeProvider = origMake;
    llmIndex.makeLLMProvider = origMakeLLM;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('runReply writes a reply audit entry with the PR id from PR metadata', async () => {
  const { code, lines } = await runWith([botOnlyThread()]);
  assert.equal(code, 0);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].event, 'reply');
  assert.equal(lines[0].prId, '42');
  assert.equal(lines[0].repo, 'o/r');
});

test('runReply writes a reply audit entry with the PR id from env when no AI threads exist', async () => {
  const { lines } = await runWith([]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].prId, 7);
});

test('runReply attributes the answering model (failover) to state, audit and stdout', async () => {
  // A reply whose provider failed over to a fallback model must record the
  // model that actually answered — not config.reply.model — plus its tokens.
  const { tmp, auditPath } = setup();
  const origMake = providerIndex.makeProvider;
  const origMakeLLM = llmIndex.makeLLMProvider;
  providerIndex.makeProvider = () => ({
    repoSlug: 'o/r',
    listThreads: async () => [threadAfterDevReply()],
    getDiff: async () => [],
    getPRMetadata: async () => ({ id: '42', sourceSha: 'HEAD' }),
    getFileContent: async () => '',
    markers: codec,
    replyToThread: async () => ({}),
    patchThreadStatus: async () => undefined,
  });
  llmIndex.makeLLMProvider = () => ({
    call: async () => ({
      text: '{"verdict":"fixed","reasoning":"ok"}',
      usage: { inputTokens: 120, outputTokens: 30 },
      cost: { totalCost: 0.0012 },
      model: 'fallback-answered',
    }),
  });
  const origWrite = process.stdout.write.bind(process.stdout);
  const writes = [];
  process.stdout.write = (chunk) => { writes.push(String(chunk)); return true; };
  try {
    const code = await runReply({
      argv: ['reply'],
      env: {
        ANTHROPIC_API_KEY: 'k', GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r',
        GITHUB_REF: 'refs/pull/7/head', AI_REVIEW_STATE_ROOT: tmp,
      },
      cwd: tmp,
    });
    assert.equal(code, 0);
    const out = JSON.parse(writes.map((w) => w.trim()).find((w) => w.startsWith('{')));
    assert.equal(out.model, 'fallback-answered');
    assert.equal(out.costUsd, 0.0012);
    assert.equal(out.inputTokens, 120);
    assert.equal(out.outputTokens, 30);
    const lines = fs.readFileSync(auditPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines[0].event, 'reply');
    assert.equal(lines[0].model, 'fallback-answered');
    assert.equal(lines[0].costUsd, 0.0012);
    assert.equal(lines[0].inputTokens, 120);
    assert.equal(lines[0].outputTokens, 30);
    const { load } = require('../lib/port/state-store.js');
    const rec = load({ repo: 'o/r', prNumber: 7, root: tmp });
    const last = rec.invocations[rec.invocations.length - 1];
    assert.equal(last.type, 'reply');
    assert.equal(last.model, 'fallback-answered');
    assert.equal(last.costUsd, 0.0012);
  } finally {
    process.stdout.write = origWrite;
    providerIndex.makeProvider = origMake;
    llmIndex.makeLLMProvider = origMakeLLM;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('runReply still lists the configured model when the provider omits it', async () => {
  const { lines } = await runWith([threadAfterDevReply()]);
  assert.equal(lines[0].model, 'claude-haiku-4-5-20251001');
  assert.equal(lines[0].costUsd, 0);
});

// ---------------------------------------------------------------------------
// Failure accounting and the half-applied-verdict repair.
//
// A failed reply or status write is a failed item (ADR-0013) and has to reach
// the exit code the way `review` does. And because the verdict reply is posted
// before the status change, a run whose status update failed leaves a verdict
// on a still-active thread; a later run has to apply the status without
// re-evaluating it with the LLM.
// ---------------------------------------------------------------------------

const { makeMarkerCodec } = require('../lib/marker-codec.js');

const codec = makeMarkerCodec({ prefix: 'ai-review', style: 'html' });
const boom = async () => { throw new Error('502 from provider'); };

/** Thread with a bot finding, a developer reply, and optionally a bot verdict. */
function threadAfterDevReply({ verdict } = {}) {
  const comments = [
    { id: '1', isBot: true, body: 'finding<!-- ai-review:v1:active -->', createdAt: '2026-01-01' },
    { id: '2', isBot: false, body: 'we fixed this', createdAt: '2026-01-02' },
  ];
  if (verdict) {
    comments.push({
      id: '3', isBot: true,
      // Literal, not built with the production formatter: a test that reuses
      // the writer cannot catch a change to the wire format, which is exactly
      // what the repair path depends on. This pins it independently.
      body: codec.appendKey(`_AI verdict:_ \`${verdict}\` — because`, 'verdict'),
      createdAt: '2026-01-03',
    });
  }
  return {
    id: 'T1', status: 'active', filePath: 'src/a.js', line: 5,
    comments, marker: { version: 'v1' },
  };
}

/**
 * Drive a real `runReply` with a controllable provider. `llm` counts calls so
 * the repair path can be shown not to spend one.
 */
async function runReplyCase({ threads, replyImpl, patchImpl, dryRun = false, llmText = '{"verdict":"fixed","reasoning":"ok"}' }) {
  const { tmp } = setup();
  const origMake = providerIndex.makeProvider;
  const origMakeLLM = llmIndex.makeLLMProvider;
  providerIndex.makeProvider = () => ({
    listThreads: async () => threads(),
    getDiff: async () => [],
    getPRMetadata: async () => ({ id: '42', sourceSha: 'HEAD' }),
    getFileContent: async () => '',
    markers: codec,
    replyToThread: replyImpl ?? (async () => ({})),
    patchThreadStatus: patchImpl ?? (async () => undefined),
  });
  const calls = { llm: 0 };
  llmIndex.makeLLMProvider = () => ({
    call: async () => { calls.llm += 1; return { text: llmText, usage: {}, cost: { totalCost: 0 } }; },
  });

  const origWrite = process.stdout.write.bind(process.stdout);
  const writes = [];
  process.stdout.write = (chunk) => { writes.push(String(chunk)); return true; };
  try {
    const code = await runReply({
      argv: dryRun ? ['reply', '--dry-run'] : ['reply'],
      env: {
        ANTHROPIC_API_KEY: 'k', GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r',
        GITHUB_REF: 'refs/pull/7/head', AI_REVIEW_STATE_ROOT: tmp,
      },
      cwd: tmp,
    });
    const line = writes.map((w) => w.trim()).find((w) => w.startsWith('{'));
    return { code, output: line ? JSON.parse(line) : null, calls };
  } finally {
    process.stdout.write = origWrite;
    providerIndex.makeProvider = origMake;
    llmIndex.makeLLMProvider = origMakeLLM;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('runReply: a failed reply write counts toward exit 6', async () => {
  const { code, output } = await runReplyCase({
    threads: () => [threadAfterDevReply()], replyImpl: boom,
  });
  assert.equal(code, 6, 'a failed write must fail the run like review does');
  assert.equal(output.writeFailures, 1);
});

test('runReply: a failed status write counts toward exit 6', async () => {
  const { code, output } = await runReplyCase({
    threads: () => [threadAfterDevReply()], patchImpl: boom,
  });
  assert.equal(code, 6);
  assert.equal(output.writeFailures, 1);
});

test('runReply: a clean run still exits 0', async () => {
  const { code, output } = await runReplyCase({ threads: () => [threadAfterDevReply()] });
  assert.equal(code, 0);
  assert.equal(output.processed, 1);
  assert.equal(output.writeFailures, 0);
});

test('runReply: a half-applied verdict is repaired without an LLM call', async () => {
  const patches = [];
  const { code, output, calls } = await runReplyCase({
    threads: () => [threadAfterDevReply({ verdict: 'fixed' })],
    patchImpl: async (id, status) => { patches.push({ id, status }); },
  });
  assert.equal(code, 0);
  assert.equal(calls.llm, 0, 'the repair must not spend an LLM call');
  assert.equal(patches.length, 1);
  assert.equal(patches[0].status, 'fixed');
  assert.equal(output.processed, 0);
});

test('runReply: a wontfix verdict is repaired too', async () => {
  const patches = [];
  const { code } = await runReplyCase({
    threads: () => [threadAfterDevReply({ verdict: 'wontfix' })],
    patchImpl: async (id, status) => { patches.push(status); },
  });
  assert.equal(code, 0);
  assert.deepEqual(patches, ['wontfix']);
});

test('runReply: a failed repair counts toward exit 6', async () => {
  const { code, output } = await runReplyCase({
    threads: () => [threadAfterDevReply({ verdict: 'fixed' })], patchImpl: boom,
  });
  assert.equal(code, 6);
  assert.equal(output.writeFailures, 1);
});

test('runReply: an `active` verdict is not repaired', async () => {
  // The original run intentionally skipped the status change for `active`.
  const patches = [];
  const { code } = await runReplyCase({
    threads: () => [threadAfterDevReply({ verdict: 'active' })],
    patchImpl: async (id, status) => { patches.push(status); },
  });
  assert.equal(code, 0);
  assert.deepEqual(patches, []);
});

test('runReply: a verdict marker with unreadable prose is not guessed at', async () => {
  const patches = [];
  const { code, calls } = await runReplyCase({
    threads: () => {
      const t = threadAfterDevReply();
      t.comments.push({
        id: '3', isBot: true,
        body: codec.appendKey('no verdict line here', 'verdict'),
        createdAt: '2026-01-03',
      });
      return [t];
    },
    patchImpl: async (id, status) => { patches.push(status); },
  });
  assert.equal(code, 0);
  assert.deepEqual(patches, [], 'a malformed marker must not flip a thread');
  assert.equal(calls.llm, 0, 'a recorded verdict must not be re-evaluated');
});

test('runReply: a bot comment with no verdict marker is still evaluated', async () => {
  // Guard for changing `.some()` to "keep the last": a bot comment that is not
  // a verdict must not be mistaken for one.
  const patches = [];
  const { code, output } = await runReplyCase({
    threads: () => {
      const t = threadAfterDevReply();
      t.comments.push({ id: '3', isBot: true, body: 'just a bot note', createdAt: '2026-01-03' });
      return [t];
    },
    patchImpl: async (id, status) => { patches.push(status); },
  });
  assert.equal(code, 0);
  assert.deepEqual(patches, ['fixed']);
  assert.equal(output.processed, 1);
});

test('runReply: --dry-run does not write the repair', async () => {
  const patches = [];
  const { code } = await runReplyCase({
    threads: () => [threadAfterDevReply({ verdict: 'fixed' })],
    patchImpl: async (id, status) => { patches.push(status); },
    dryRun: true,
  });
  assert.equal(code, 0);
  assert.deepEqual(patches, [], 'a dry run must not mutate the provider');
});

test('runReply: the repair converges instead of re-patching every run', async () => {
  // Models the provider semantics that matter here:
  //  - patchThreadStatus appends a status marker unless skipMarkerReply is set
  //    (all four providers do: github-write.js, bitbucket-write.js, gitlab.js,
  //    azure-devops.js).
  //  - listThreads derives the thread status from the last status marker
  //    (github-threads.js latestStatus), falling back to 'active'.
  // A repair that writes no marker leaves the thread looking active, so the
  // next run patches it again - forever.
  const thread = threadAfterDevReply();
  const deriveStatus = () => {
    let latest = null;
    for (const c of thread.comments) {
      const s = codec.parse(c.body ?? '').status;
      if (s) latest = s;
    }
    return latest ?? 'active';
  };

  const patchCalls = [];
  const provider = () => ({
    listThreads: async () => { thread.status = deriveStatus(); return [thread]; },
    getDiff: async () => [],
    getPRMetadata: async () => ({ id: '42', sourceSha: 'HEAD' }),
    getFileContent: async () => '',
    markers: codec,
    replyToThread: async (_id, body) => {
      thread.comments.push({ id: `c${thread.comments.length}`, isBot: true, body, createdAt: '2026-01-04' });
      return {};
    },
    patchThreadStatus: async (_id, status, opts) => {
      patchCalls.push(status);
      if (patchCalls.length === 1) throw new Error('502 from provider');
      if (opts?.skipMarkerReply !== true) {
        thread.comments.push({
          id: `c${thread.comments.length}`, isBot: true,
          body: codec.statusReplyBody(status), createdAt: '2026-01-05',
        });
      }
      return undefined;
    },
  });

  const { tmp } = setup();
  const origMake = providerIndex.makeProvider;
  const origMakeLLM = llmIndex.makeLLMProvider;
  providerIndex.makeProvider = provider;
  llmIndex.makeLLMProvider = () => ({
    call: async () => ({ text: '{"verdict":"fixed","reasoning":"ok"}', usage: {}, cost: { totalCost: 0 } }),
  });
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = () => true;
  const env = {
    ANTHROPIC_API_KEY: 'k', GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r',
    GITHUB_REF: 'refs/pull/7/head', AI_REVIEW_STATE_ROOT: tmp,
  };

  try {
    await runReply({ argv: ['reply'], env, cwd: tmp });  // 1: reply lands, patch fails
    await runReply({ argv: ['reply'], env, cwd: tmp });  // 2: repair applies the status
    assert.equal(deriveStatus(), 'fixed', 'the repair must leave the thread in the target status');

    const before = patchCalls.length;
    const code3 = await runReply({ argv: ['reply'], env, cwd: tmp }); // 3: nothing left to do
    assert.equal(patchCalls.length, before, 'run 3 must not patch again');
    assert.equal(code3, 0);
  } finally {
    process.stdout.write = origWrite;
    providerIndex.makeProvider = origMake;
    llmIndex.makeLLMProvider = origMakeLLM;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('runReply: the issue reproduction, run end to end', async () => {
  // replyToThread succeeds, then patchThreadStatus returns 502; the next run
  // applies the status. The thread is shared between runs so run 2 sees what
  // run 1 actually left behind rather than a hand-built verdict comment.
  const thread = threadAfterDevReply();
  const patchStatuses = [];
  let llmCalls = 0;

  const provider = () => ({
    listThreads: async () => [thread],
    getDiff: async () => [],
    getPRMetadata: async () => ({ id: '42', sourceSha: 'HEAD' }),
    getFileContent: async () => '',
    markers: codec,
    replyToThread: async (_id, body) => {
      // The verdict reply lands; its key marker does not change thread status.
      thread.comments.push({ id: `c${thread.comments.length}`, isBot: true, body, createdAt: '2026-01-04' });
      return {};
    },
    patchThreadStatus: async (_id, status) => {
      patchStatuses.push(status);
      if (patchStatuses.length === 1) throw new Error('502 from provider');
      return undefined;
    },
  });

  const { tmp } = setup();
  const origMake = providerIndex.makeProvider;
  const origMakeLLM = llmIndex.makeLLMProvider;
  providerIndex.makeProvider = provider;
  llmIndex.makeLLMProvider = () => ({
    call: async () => { llmCalls += 1; return { text: '{"verdict":"fixed","reasoning":"ok"}', usage: {}, cost: { totalCost: 0 } }; },
  });
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = () => true;
  const env = {
    ANTHROPIC_API_KEY: 'k', GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r',
    GITHUB_REF: 'refs/pull/7/head', AI_REVIEW_STATE_ROOT: tmp,
  };

  try {
    const code1 = await runReply({ argv: ['reply'], env, cwd: tmp });
    assert.equal(code1, 6, 'run 1 must exit 6');
    assert.equal(thread.status, 'active');
    assert.ok(codec.hasKey(thread.comments[thread.comments.length - 1].body, 'verdict'));
    assert.equal(codec.parse(thread.comments[thread.comments.length - 1].body).status, null);

    const callsAfterRun1 = llmCalls;
    const code2 = await runReply({ argv: ['reply'], env, cwd: tmp });
    assert.equal(code2, 0, 'run 2 must recover');
    assert.equal(llmCalls, callsAfterRun1, 'the repair must not spend an LLM call');
    assert.deepEqual(patchStatuses, ['fixed', 'fixed'], 'run 2 retries the same status');
  } finally {
    process.stdout.write = origWrite;
    providerIndex.makeProvider = origMake;
    llmIndex.makeLLMProvider = origMakeLLM;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
