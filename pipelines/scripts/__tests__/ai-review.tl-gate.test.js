// @ts-check
'use strict';
const test = require('node:test');
const { describe, it } = test;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const providerIndex = require('../lib/providers/index.js');
const llmIndex = require('../lib/llm/index.js');

const ON = 'review:\n  tlGate:\n    enabled: true\n    leads: ["12345"]\n';

/**
 * Drive a real `runReview` against a stubbed provider/LLM and return the exit
 * code, the JSON line it printed, and everything the run touched.
 *
 * `targetConfig` is what the PR's TARGET branch holds; `prConfig` is what the
 * working folder (i.e. the PR checkout in CI) holds. `getDiff` is the tell for
 * "did the run spend a token": it is only reached after the LLM client is built,
 * so `diffsFetched === false` proves no LLM call happened.
 */
async function runWithGate({
  targetConfig,
  prConfig,
  trigger,
  note,
  noteWriteFails = false,
  upsertFails = false,
  env = {},
}) {
  const { runReview } = require('../ai-review.js');
  const origMake = providerIndex.makeProvider;
  const origMakeLLM = llmIndex.makeLLMProvider;
  const seen = { llmBuilt: 0, llmCalled: 0, diffsFetched: 0, upserts: [], targetReads: [] };

  providerIndex.makeProvider = () => ({
    getPRMetadata: async () => ({
      id: '7', title: 'T', sourceBranch: 'feat', targetBranch: 'main',
      sourceSha: 'SRC', targetSha: 'TARGET', authorEmail: 'a@b.c', url: 'u',
    }),
    // Only the target branch is readable: the gate must ask for the target ref,
    // so a stub that answers the source ref too would hide a wrong ref.
    getFileContent: async (filePath, ref) => {
      seen.targetReads.push({ filePath, ref });
      if (ref !== 'TARGET') return null;
      return targetConfig ?? null;
    },
    getTriggerInfo: async () => trigger ?? {
      manual: false, actorId: null, actorLabel: null, howToTurnOn: 'press the button',
    },
    findBotComment: async () => note ?? null,
    upsertSummaryComment: async (key, body) => {
      seen.upserts.push({ key, body });
      if ((key === 'tl-gate' && noteWriteFails) || (key !== 'tl-gate' && upsertFails)) {
        throw new Error('502 from provider');
      }
      return { id: '1', action: 'created' };
    },
    getDiff: async () => {
      seen.diffsFetched += 1;
      return [{ path: 'src/x.js', change: 'add', patch: '@@ -0,0 +1,1 @@\n+const a = 1;\n' }];
    },
    listThreads: async () => [],
    postThread: async () => ({ threadId: 'T1', commentId: 1 }),
    replyToThread: async () => ({}),
    patchThreadStatus: async () => ({}),
    renderSummaryMarker: (k) => `<!-- ai-review:v1:${k ?? 'summary'} -->`,
  });
  llmIndex.makeLLMProvider = () => {
    seen.llmBuilt += 1;
    return {
      call: async () => {
        seen.llmCalled += 1;
        return {
          text: JSON.stringify({ summary: 's', findings: [] }),
          usage: { inputTokens: 1, outputTokens: 1 },
          cost: { inputCost: 0, outputCost: 0, totalCost: 0 },
        };
      },
    };
  };

  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-review-gate-'));
  const base = 'provider: github\nauth:\n  anthropicKey: ${ANTHROPIC_API_KEY}\n  token: ${GITHUB_TOKEN}\n';
  fs.writeFileSync(path.join(cfgDir, 'ai-review.config.yaml'), prConfig ?? base);
  fs.writeFileSync(path.join(cfgDir, 'pr-own-copy.yaml'), targetConfig ?? '');

  const origWrite = process.stdout.write.bind(process.stdout);
  const writes = [];
  process.stdout.write = (chunk) => { writes.push(String(chunk)); return true; };

  let code;
  try {
    code = await runReview({
      argv: ['review'],
      env: {
        ANTHROPIC_API_KEY: 'k', GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r',
        GITHUB_REF: 'refs/pull/7/head',
        ...env,
      },
      cwd: cfgDir,
    });
  } finally {
    process.stdout.write = origWrite;
    providerIndex.makeProvider = origMake;
    llmIndex.makeLLMProvider = origMakeLLM;
    fs.rmSync(cfgDir, { recursive: true, force: true });
  }

  const line = writes.map((w) => w.trim()).find((w) => w.startsWith('{'));
  return { code, json: line ? JSON.parse(line) : null, ...seen };
}

describe('runReview — the TL gate off (today\u2019s behaviour)', () => {
  it('no config on the target branch: reviews exactly as before', async () => {
    const r = await runWithGate({ targetConfig: null });
    assert.equal(r.code, 0);
    assert.equal(r.llmCalled, 1, 'the LLM must run');
    assert.equal(r.json.tlGate.on, true);
    assert.equal(r.json.tlGate.reason, 'switch-off');
  });

  it('the switch off on the target branch: reviews, and writes no gate comment', async () => {
    const r = await runWithGate({ targetConfig: 'review:\n  strict: false\n' });
    assert.equal(r.code, 0);
    assert.equal(r.llmCalled, 1);
    assert.equal(r.upserts.filter((u) => u.key === 'tl-gate').length, 0);
  });

  it('the PR\u2019s own config switching the gate off is ignored (the target branch decides)', async () => {
    const r = await runWithGate({
      prConfig: 'provider: github\nauth:\n  anthropicKey: ${ANTHROPIC_API_KEY}\n  token: ${GITHUB_TOKEN}\nreview:\n  tlGate:\n    enabled: false\n    leads: []\n',
      targetConfig: ON,
    });
    assert.equal(r.code, 0);
    assert.equal(r.llmCalled, 0, 'the PR must not be able to switch its own gate off');
    assert.equal(r.json.tlGate.on, false);
    assert.equal(r.json.tlGate.reason, 'waiting');
  });

  it('a stubbed provider without getFileContent leaves the gate off and reviews', async () => {
    // The pre-existing suite's stubbed providers have no getFileContent; they must
    // keep behaving exactly as they did before this feature existed.
    const { runReview } = require('../ai-review.js');
    const origMake = providerIndex.makeProvider;
    const origMakeLLM = llmIndex.makeLLMProvider;
    let called = 0;
    providerIndex.makeProvider = () => ({
      getPRMetadata: async () => ({ id: '7', title: 'T', sourceBranch: 'f', targetBranch: 'main', sourceSha: 'S', targetSha: 'T', authorEmail: 'a', url: 'u' }),
      getDiff: async () => [{ path: 'src/x.js', change: 'add', patch: '@@ -0,0 +1,1 @@\n+const a = 1;\n' }],
      listThreads: async () => [],
      upsertSummaryComment: async () => ({ id: '1', action: 'created' }),
      renderSummaryMarker: () => '<!-- ai-review:v1:summary -->',
    });
    llmIndex.makeLLMProvider = () => ({ call: async () => { called += 1; return { text: JSON.stringify({ summary: 's', findings: [] }), usage: { inputTokens: 1, outputTokens: 1 }, cost: { inputCost: 0, outputCost: 0, totalCost: 0 } }; } });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-review-gate-nofile-'));
    fs.writeFileSync(path.join(dir, 'ai-review.config.yaml'), 'provider: github\nauth:\n  anthropicKey: ${ANTHROPIC_API_KEY}\n  token: ${GITHUB_TOKEN}\nreview:\n  tlGate:\n    enabled: true\n    leads: ["1"]\n');
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = () => true;
    let code;
    try {
      code = await runReview({ argv: ['review'], env: { ANTHROPIC_API_KEY: 'k', GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r', GITHUB_REF: 'refs/pull/7/head' }, cwd: dir });
    } finally {
      process.stdout.write = origWrite;
      providerIndex.makeProvider = origMake;
      llmIndex.makeLLMProvider = origMakeLLM;
      fs.rmSync(dir, { recursive: true, force: true });
    }
    assert.equal(code, 0);
    assert.equal(called, 1, 'a provider that cannot read the target config must not hold back a review');
  });
});

describe('runReview — the TL gate on, no press yet', () => {
  it('no LLM call, exit 0, and a waiting comment that says how to turn it on', async () => {
    const r = await runWithGate({ targetConfig: ON });
    assert.equal(r.code, 0, 'waiting for a team lead is the configured behaviour, not a failure');
    assert.equal(r.llmBuilt, 0, 'no LLM client may be built for a held-back PR');
    assert.equal(r.llmCalled, 0);
    assert.equal(r.diffsFetched, 0);
    const gate = r.upserts.filter((u) => u.key === 'tl-gate');
    assert.equal(gate.length, 1);
    assert.match(gate[0].body, /waiting for a team lead/i);
    assert.match(gate[0].body, /press the button/);
    assert.match(gate[0].body, /ai-review:v1:tl-gate/);
    assert.equal(r.json.tlGate.on, false);
    assert.equal(r.json.tlGate.noteAction, 'created');
    assert.equal(r.json.tlGate.noteFailed, false);
  });

  it('reads the switch from the target sha, not the source sha', async () => {
    const r = await runWithGate({ targetConfig: ON });
    assert.deepEqual(r.targetReads, [{ filePath: 'ai-review.config.yaml', ref: 'TARGET' }]);
  });

  it('a failed waiting comment stays a warn, not a failed build', async () => {
    const r = await runWithGate({ targetConfig: ON, noteWriteFails: true });
    assert.equal(r.code, 0, 'the repository is behaving as it configured; the build must stay green');
    assert.equal(r.json.tlGate.noteAction, null);
    assert.equal(r.json.tlGate.noteFailed, true, 'the failed write is reported, even though the exit code stays 0');
  });

  it('a held run still lands in the audit trail: "why did the AI not review?" stays answerable', async () => {
    const auditPath = path.join(os.tmpdir(), `ai-review-gate-audit-${process.pid}.jsonl`).replace(/\\/g, '/');
    fs.rmSync(auditPath, { force: true });
    const r = await runWithGate({
      prConfig: 'provider: github\nauth:\n  anthropicKey: ${ANTHROPIC_API_KEY}\n  token: ${GITHUB_TOKEN}\nreview:\n  auditLogPath: ' + auditPath + '\n',
      targetConfig: ON,
    });
    assert.equal(r.code, 0, 'the audit write must never turn a held run into a failure');
    assert.equal(r.json.auditLogged, true);
    const entries = fs.readFileSync(auditPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const entry = entries.find((e) => e.prId === '7');
    assert.equal(entry.event, 'review');
    assert.equal(entry.tlGate.on, false);
    assert.equal(entry.tlGate.reason, 'waiting');
    fs.rmSync(auditPath, { force: true });
  });

  it('an enabled switch with an empty lead list is a config error (exit 2)', async () => {
    const r = await runWithGate({
      targetConfig: 'review:\n  tlGate:\n    enabled: true\n    leads: []\n',
    });
    assert.equal(r.code, 2);
    assert.equal(r.llmCalled, 0);
  });

  it('a malformed tlGate block is a config error (exit 2), never a silent off', async () => {
    const r = await runWithGate({ targetConfig: 'review:\n  tlGate: "yes please"\n' });
    assert.equal(r.code, 2);
  });

  it('a YAML .nan lead is the same config error (exit 2): it never becomes the string "NaN"', async () => {
    // js-yaml parses `.nan` as the number NaN; parseGateConfig rejects the
    // number before any String(id) could turn it into a configured-looking lead.
    const r = await runWithGate({ targetConfig: 'review:\n  tlGate:\n    enabled: true\n    leads: [.nan]\n' });
    assert.equal(r.code, 2);
  });
});

describe('runReview — the button press', () => {
  it('a listed lead pressing reviews the PR and writes the "AI on" note', async () => {
    const r = await runWithGate({
      targetConfig: ON,
      trigger: { manual: true, actorId: '12345', actorLabel: 'Ada', howToTurnOn: 'press the button' },
    });
    assert.equal(r.llmCalled, 1, 'a lead press reviews as today');
    const gate = r.upserts.filter((u) => u.key === 'tl-gate');
    assert.equal(gate.length, 1);
    assert.match(gate[0].body, /Ada/);
    assert.match(gate[0].body, /12345/);
    assert.equal(r.json.tlGate.on, true);
    assert.equal(r.json.tlGate.reason, 'lead-press');
    assert.equal(r.json.tlGate.wroteNote, true);
  });

  it('the note is written before the diff is fetched, so a later crash still leaves the PR on', async () => {
    // Order matters: the note is the gate\u2019s only memory, so it must not be the
    // last thing the run does.
    const order = [];
    const { runReview } = require('../ai-review.js');
    const origMake = providerIndex.makeProvider;
    const origMakeLLM = llmIndex.makeLLMProvider;
    providerIndex.makeProvider = () => ({
      getPRMetadata: async () => ({ id: '7', title: 'T', sourceBranch: 'f', targetBranch: 'main', sourceSha: 'S', targetSha: 'TARGET', authorEmail: 'a', url: 'u' }),
      getFileContent: async (_p, ref) => (ref === 'TARGET' ? ON : null),
      getTriggerInfo: async () => ({ manual: true, actorId: '12345', actorLabel: 'Ada', howToTurnOn: 'x' }),
      findBotComment: async () => null,
      upsertSummaryComment: async (key) => {
        order.push(key);
        return { id: '1', action: 'created' };
      },
      getDiff: async () => { order.push('diff'); return [{ path: 'src/x.js', change: 'add', patch: '@@ -0,0 +1,1 @@\n+const a = 1;\n' }]; },
      listThreads: async () => [],
      renderSummaryMarker: (k) => `<!-- ai-review:v1:${k ?? 'summary'} -->`,
    });
    llmIndex.makeLLMProvider = () => ({ call: async () => { order.push('llm'); return { text: JSON.stringify({ summary: 's', findings: [] }), usage: { inputTokens: 1, outputTokens: 1 }, cost: { inputCost: 0, outputCost: 0, totalCost: 0 } }; } });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-review-gate-order-'));
    fs.writeFileSync(path.join(dir, 'ai-review.config.yaml'), 'provider: github\nauth:\n  anthropicKey: ${ANTHROPIC_API_KEY}\n  token: ${GITHUB_TOKEN}\n');
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = () => true;
    try {
      await runReview({ argv: ['review'], env: { ANTHROPIC_API_KEY: 'k', GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r', GITHUB_REF: 'refs/pull/7/head' }, cwd: dir });
    } finally {
      process.stdout.write = origWrite;
      providerIndex.makeProvider = origMake;
      llmIndex.makeLLMProvider = origMakeLLM;
      fs.rmSync(dir, { recursive: true, force: true });
    }
    assert.deepEqual(order.slice(0, 3), ['tl-gate', 'diff', 'llm']);
  });

  it('a press by someone not on the list spends no token, explains why, and exits 0', async () => {
    const r = await runWithGate({
      targetConfig: ON,
      trigger: { manual: true, actorId: '999', actorLabel: 'Bob', howToTurnOn: 'press the button' },
    });
    assert.equal(r.code, 0);
    assert.equal(r.llmCalled, 0);
    const gate = r.upserts.filter((u) => u.key === 'tl-gate');
    assert.equal(gate.length, 1);
    assert.match(gate[0].body, /Bob/);
    assert.match(gate[0].body, /not in `review\.tlGate\.leads`/);
    assert.equal(r.json.tlGate.reason, 'not-lead');
  });

  it('a press the platform reports no id for is refused rather than trusted', async () => {
    const r = await runWithGate({
      targetConfig: ON,
      trigger: { manual: true, actorId: null, actorLabel: null, howToTurnOn: 'press the button' },
    });
    assert.equal(r.code, 0);
    assert.equal(r.llmCalled, 0);
    assert.equal(r.json.tlGate.reason, 'unknown-pressor');
  });

  it('an unknown presser still reviews when the "AI on" note is already on the PR', async () => {
    const r = await runWithGate({
      targetConfig: ON,
      trigger: { manual: true, actorId: null, actorLabel: null, howToTurnOn: 'press the button' },
      note: { id: '9', body: '<!-- ai-review:v1:tl-gate -->\n<!-- ai-review:v1:tl-on -->', createdAt: '', editedByOther: false },
    });
    assert.equal(r.code, 0);
    assert.equal(r.llmCalled, 1, 'docs/config.md run table: the note already on the PR reviews as before');
    assert.equal(r.json.tlGate.reason, 'note');
  });

  it('a lost "AI on" note is a partial failure (exit 6): it is the gate\u2019s only memory', async () => {
    const r = await runWithGate({
      targetConfig: ON,
      trigger: { manual: true, actorId: '12345', actorLabel: 'Ada', howToTurnOn: 'x' },
      noteWriteFails: true,
    });
    assert.equal(r.code, 6);
    assert.equal(r.llmCalled, 1, 'this run\u2019s own review still happened');
    assert.equal(r.json.failures, 1);
    assert.equal(r.json.tlGate.wroteNote, false);
  });
});

describe('runReview — the note already on the PR', () => {
  it('an existing note turns every later push on without any press', async () => {
    const r = await runWithGate({
      targetConfig: ON,
      note: { id: '9', body: '<!-- ai-review:v1:tl-gate -->\n<!-- ai-review:v1:tl-on -->', createdAt: '', editedByOther: false },
    });
    assert.equal(r.llmCalled, 1);
    assert.equal(r.json.tlGate.reason, 'note');
    assert.equal(r.json.tlGate.wroteNote, false, 'the note is not rewritten on every push');
    assert.equal(r.upserts.filter((u) => u.key === 'tl-gate').length, 0);
  });

  it('a note someone with write access edited is ignored', async () => {
    const r = await runWithGate({
      targetConfig: ON,
      note: { id: '9', body: '<!-- ai-review:v1:tl-gate -->\n<!-- ai-review:v1:tl-on -->', createdAt: '', editedByOther: true },
    });
    assert.equal(r.code, 0);
    assert.equal(r.llmCalled, 0, 'an edited note is not the bot\u2019s own record');
    assert.equal(r.json.tlGate.reason, 'waiting');
  });
});
