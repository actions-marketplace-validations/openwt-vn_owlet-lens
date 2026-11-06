// @ts-check
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const providerIndex = require('../lib/providers/index.js');
const llmIndex = require('../lib/llm/index.js');

const BASE_CONFIG = 'provider: github\nauth:\n  anthropicKey: ${ANTHROPIC_API_KEY}\n  token: ${GITHUB_TOKEN}\n';
const PATCH_V1 = '@@ -10,2 +10,3 @@\n ctx\n+const a = 1;\n ctx\n';
// The same PR change after a merge from the target branch: hunk moved, context changed.
const PATCH_AFTER_MERGE = '@@ -40,2 +40,3 @@\n other\n+const a = 1;\n other\n';
const PATCH_NEW_WORK = '@@ -10,2 +10,3 @@\n ctx\n+const a = 2;\n ctx\n';

/**
 * A PR whose comments survive between runs, so a second `runReview` sees what
 * the first one wrote — the marker is the run's only memory (ADR-0001).
 */
function makePr() {
  return { comments: /** @type {Array<{ key: string, body: string, editedByOther: boolean }>} */ ([]) };
}

/**
 * @param {{
 *   pr: ReturnType<typeof makePr>,
 *   patch?: string,
 *   config?: string,
 *   argv?: string[],
 *   env?: Record<string, string>,
 *   trigger?: { manual: boolean },
 *   postFails?: boolean,
 *   findThrows?: boolean,
 *   findings?: any[],
 *   files?: Record<string, string>,
 *   threads?: any[],
 * }} opts `files` are extra working-folder files, keyed by relative path.
 */
async function run({ pr, patch = PATCH_V1, config = BASE_CONFIG, argv = [], env = {}, trigger, postFails = false, findThrows = false, findings = [], files = {}, threads = [] }) {
  const { runReview } = require('../ai-review.js');
  const origMake = providerIndex.makeProvider;
  const origMakeLLM = llmIndex.makeLLMProvider;
  const seen = { llmCalled: 0, threadsListed: 0, upserts: /** @type {string[]} */ ([]) };

  providerIndex.makeProvider = () => ({
    getPRMetadata: async () => ({
      id: '7', title: 'T', sourceBranch: 'feat', targetBranch: 'develop',
      sourceSha: 'SRC', targetSha: 'TARGET', authorEmail: 'a@b.c', url: 'u',
    }),
    getFileContent: async () => null,
    getTriggerInfo: async () => ({ manual: false, actorId: null, actorLabel: null, howToTurnOn: 'x', ...trigger }),
    findBotComment: async (/** @type {string} */ key) => {
      if (findThrows) throw new Error('502 from provider');
      const hit = pr.comments.find((c) => c.body.includes(`ai-review:v1:${key} `));
      return hit ? { id: '1', body: hit.body, createdAt: '', editedByOther: hit.editedByOther } : null;
    },
    upsertSummaryComment: async (/** @type {string} */ key, /** @type {string} */ body) => {
      seen.upserts.push(key);
      const i = pr.comments.findIndex((c) => c.key === key);
      if (i >= 0) pr.comments[i] = { key, body, editedByOther: false };
      else pr.comments.push({ key, body, editedByOther: false });
      return { id: '1', action: i >= 0 ? 'updated' : 'created' };
    },
    getDiff: async () => [{ path: 'src/x.js', change: 'modify', patch }],
    listThreads: async () => { seen.threadsListed += 1; return threads; },
    postThread: async () => { if (postFails) throw new Error('502'); return { id: 'T1' }; },
    postThreadsBatch: async (/** @type {any[]} */ ts) => ts.map(() => (postFails ? { ok: false, error: new Error('502') } : { ok: true, value: { id: 'T1' } })),
    replyToThread: async () => ({ id: 'R1' }),
    patchThreadStatus: async () => ({}),
    renderSummaryMarker: (/** @type {string|undefined} */ k) => `<!-- ai-review:v1:${k ?? 'summary'} -->`,
  });
  llmIndex.makeLLMProvider = () => ({
    call: async () => {
      seen.llmCalled += 1;
      return {
        text: JSON.stringify({ summary: 's', findings }),
        usage: { inputTokens: 1, outputTokens: 1 },
        cost: { inputCost: 0, outputCost: 0, totalCost: 0 },
      };
    },
  });

  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-review-skip-'));
  fs.writeFileSync(path.join(cfgDir, 'ai-review.config.yaml'), config);
  for (const [rel, content] of Object.entries(files)) fs.writeFileSync(path.join(cfgDir, rel), content);
  const origWrite = process.stdout.write.bind(process.stdout);
  const writes = /** @type {string[]} */ ([]);
  process.stdout.write = (/** @type {any} */ chunk) => { writes.push(String(chunk)); return true; };
  let code;
  try {
    code = await runReview({
      argv: ['review', ...argv],
      env: {
        ANTHROPIC_API_KEY: 'k', GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r', GITHUB_REF: 'refs/pull/7/head',
        AI_REVIEW_STATE_ROOT: path.join(cfgDir, 'state'), ...env,
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

const reviewedKey = (/** @type {ReturnType<typeof makePr>} */ pr) =>
  /ai-review:v1:(reviewed-[a-f0-9]+)/.exec(pr.comments.find((c) => c.key === 'summary')?.body ?? '')?.[1] ?? null;

// CRITICAL so the reflection filter (ADR-0009) passes it through untouched.
const BLOCKING = [{ file: 'src/x.js', line: 11, severity: 'CRITICAL', category: 'security', message: 'hardcoded secret' }];

describe('runReview — review.skipUnchanged', () => {
  it('a full review stamps the summary with the review fingerprint', async () => {
    const pr = makePr();
    const r = await run({ pr });
    assert.equal(r.code, 0);
    assert.equal(r.llmCalled, 1);
    assert.match(reviewedKey(pr) ?? '', /^reviewed-[a-f0-9]{32}$/);
  });

  it('a push that is only a merge from the target skips: no LLM, no threads read, no writes, exit 0', async () => {
    const pr = makePr();
    await run({ pr });
    const r = await run({ pr, patch: PATCH_AFTER_MERGE });
    assert.equal(r.code, 0);
    assert.equal(r.llmCalled, 0);
    assert.equal(r.threadsListed, 0);
    assert.deepEqual(r.upserts, []);
    assert.equal(r.json.skipped, 'no-net-change');
    assert.match(r.json.fingerprint, /^[a-f0-9]{32}$/);
  });

  it('new work in the PR reviews', async () => {
    const pr = makePr();
    await run({ pr });
    const r = await run({ pr, patch: PATCH_NEW_WORK });
    assert.equal(r.llmCalled, 1);
    assert.equal(r.json.skipped, undefined);
  });

  it('a config change reviews', async () => {
    const pr = makePr();
    await run({ pr });
    const r = await run({ pr, config: `${BASE_CONFIG}review:\n  severityThreshold: high\n` });
    assert.equal(r.llmCalled, 1);
  });

  it('a contextPaths document change reviews', async () => {
    const pr = makePr();
    const cfg = `${BASE_CONFIG}review:\n  contextPaths:\n    - ./ctx.md\n`;
    await run({ pr, config: cfg, files: { 'ctx.md': 'Architecture v1' } });
    const r = await run({ pr, config: cfg, files: { 'ctx.md': 'Architecture v2' } });
    assert.equal(r.llmCalled, 1);
  });

  it('review.skipUnchanged: false always reviews', async () => {
    const pr = makePr();
    const off = `${BASE_CONFIG}review:\n  skipUnchanged: false\n`;
    await run({ pr, config: off });
    const r = await run({ pr, config: off });
    assert.equal(r.llmCalled, 1);
  });

  it('a marker someone else edited is not trusted', async () => {
    const pr = makePr();
    await run({ pr });
    pr.comments[0] = { ...pr.comments[0], editedByOther: true };
    const r = await run({ pr });
    assert.equal(r.llmCalled, 1);
  });

  for (const [name, wrap] of /** @type {Array<[string, (k: string) => string]>} */ ([
    ['in prose', (k) => `see ai-review:v1:${k} in log`],
    ['as the prefix of a longer key', (k) => `<!-- ai-review:v1:${k}0 -->`],
  ])) {
    it(`a fingerprint mentioned ${name}, not as its own marker, reviews`, async () => {
      const pr = makePr();
      await run({ pr });
      const key = reviewedKey(pr);
      assert.ok(key);
      // The trailing bare key is also prose; it lets the stub lookup find the comment.
      pr.comments[0] = { ...pr.comments[0], body: `${wrap(key)} ai-review:v1:${key} ` };
      const r = await run({ pr });
      assert.equal(r.llmCalled, 1);
    });
  }

  it('a failed marker lookup fails open to a review', async () => {
    const pr = makePr();
    await run({ pr });
    const r = await run({ pr, findThrows: true });
    assert.equal(r.llmCalled, 1);
  });

  for (const [name, opts] of /** @type {Array<[string, any]>} */ ([
    ['--force-review', { argv: ['--force-review'] }],
    ['AI_REVIEW_FORCE=1', { env: { AI_REVIEW_FORCE: '1' } }],
    ['a manual run (TL press, GitHub re-run, GitLab manual job)', { trigger: { manual: true } }],
  ])) {
    it(`${name} reviews even when unchanged`, async () => {
      const pr = makePr();
      await run({ pr });
      const r = await run({ pr, ...opts });
      assert.equal(r.llmCalled, 1);
    });
  }

  it('a run with a failed write does not stamp the fingerprint, so the next push retries', async () => {
    const pr = makePr();
    const r = await run({ pr, findings: BLOCKING, postFails: true });
    assert.equal(r.code, 6);
    assert.equal(reviewedKey(pr), null);
  });

  it('a strict run (exit 8) still stamps the fingerprint', async () => {
    const pr = makePr();
    const r = await run({ pr, findings: BLOCKING, config: `${BASE_CONFIG}review:\n  strict: true\n` });
    assert.equal(r.code, 8);
    assert.notEqual(reviewedKey(pr), null);
  });

  it('a skip lands in the audit log at zero cost', async () => {
    const pr = makePr();
    const auditDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-review-skip-audit-'));
    const auditPath = path.join(auditDir, 'audit.jsonl');
    const cfg = `${BASE_CONFIG}review:\n  auditLogPath: ${auditPath}\n`;
    try {
      await run({ pr, config: cfg });
      const r = await run({ pr, config: cfg, patch: PATCH_AFTER_MERGE });
      assert.equal(r.json.auditLogged, true);
      const last = JSON.parse(fs.readFileSync(auditPath, 'utf8').trim().split('\n').pop() ?? '{}');
      assert.equal(last.skipped, 'no-net-change');
      assert.equal(last.costUsd, 0);
    } finally {
      fs.rmSync(auditDir, { recursive: true, force: true });
    }
  });
});

// Issue strict-gate-persistent/01: a blocking thread an earlier run raised keeps
// strict red until it is fixed or argued to wontfix, on a full run and a skip.
describe('runReview — strict stays red while a blocking thread is open', () => {
  const STRICT = `${BASE_CONFIG}review:\n  strict: true\n`;
  /** @param {string} status */
  const openHigh = (status = 'active') => [{
    id: 'T9', status, filePath: 'src/old.js', line: 4,
    comments: [{ id: 'c1', isBot: true, authorEmail: 'bot', body: '[Owlet Lens] **[HIGH/bug]** null deref' }],
    marker: { fingerprint: 'deadbeef', version: 'v1' },
  }];

  it('a full review with no new findings still exits 8, the blocker marked carried', async () => {
    const r = await run({ pr: makePr(), config: STRICT, threads: openHigh() });
    assert.equal(r.code, 8);
    assert.equal(r.json.strict.blockingFindings[0].carried, true);
  });

  it('the summary says the blocker is from an earlier run', async () => {
    const pr = makePr();
    await run({ pr, config: STRICT, threads: openHigh() });
    assert.match(pr.comments.find((c) => c.key === 'summary')?.body ?? '', /1 from earlier runs, still open/);
  });

  it('a thread argued to wontfix no longer blocks', async () => {
    const r = await run({ pr: makePr(), config: STRICT, threads: openHigh('wontfix') });
    assert.equal(r.code, 0);
  });

  it('a skipped push exits 8 while the blocker is open, reading threads once', async () => {
    const pr = makePr();
    await run({ pr, config: STRICT });
    const r = await run({ pr, config: STRICT, patch: PATCH_AFTER_MERGE, threads: openHigh() });
    assert.equal(r.json.skipped, 'no-net-change');
    assert.equal(r.code, 8);
    assert.equal(r.threadsListed, 1);
    assert.equal(r.llmCalled, 0);
  });

  it('a skipped push exits 0 once the blocker is fixed', async () => {
    const pr = makePr();
    await run({ pr, config: STRICT });
    const r = await run({ pr, config: STRICT, patch: PATCH_AFTER_MERGE, threads: openHigh('fixed') });
    assert.equal(r.json.skipped, 'no-net-change');
    assert.equal(r.code, 0);
  });
});
