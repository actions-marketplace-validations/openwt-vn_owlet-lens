'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

function freshRequire(modPath) {
  delete require.cache[require.resolve(modPath)];
  return require(modPath);
}

function stubModule(modPath, exportsObj) {
  require.cache[require.resolve(modPath)] = {
    id: require.resolve(modPath),
    filename: require.resolve(modPath),
    loaded: true,
    exports: exportsObj,
    children: [],
    paths: [],
    parent: null,
  };
}

function setupStubs({ runReviewImpl, dryRun = false }) {
  const calls = [];
  stubModule('../lib/port/cache-port.js', {
    restore: async (opts) => { calls.push({ fn: 'restore', opts }); return { hit: false, key: null }; },
    save: async (opts) => { calls.push({ fn: 'save', opts }); },
  });
  stubModule('../ai-review.js', {
    runReview: async (args) => { calls.push({ fn: 'runReview', args }); return runReviewImpl(args); },
    runReply: async () => 0,
  });
  stubModule('@actions/core', {
    getInput: (name) => {
      if (name === 'anthropic-api-key') return 'test-key';
      if (name === 'subcommand') return 'review';
      if (name === 'config-path') return 'ai-review.config.yaml';
      if (name === 'provider') return 'github';
      if (name === 'github-token') return 'test-token';
      if (name === 'pr-number') return '42';
      return '';
    },
    getBooleanInput: (name) => name === 'dry-run' ? dryRun : false,
    setSecret: () => {},
    setOutput: () => {},
    setFailed: (m) => { calls.push({ fn: 'setFailed', m }); },
  });
  return calls;
}

const ACTION_ENTRY = path.resolve(__dirname, '../action-entry.js');

const ENV_KEYS = ['GITHUB_ACTIONS', 'GITHUB_REPOSITORY', 'GITHUB_REPOSITORY_ID', 'GITHUB_RUN_ID', 'GITHUB_REF', 'GITHUB_PR_NUMBER', 'RUNNER_TEMP', 'AI_REVIEW_STATE_ROOT'];

function snapshotEnv() {
  const snap = {};
  for (const k of ENV_KEYS) snap[k] = process.env[k];
  return snap;
}

function restoreEnv(snap) {
  for (const k of ENV_KEYS) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k];
  }
}

function setEnv() {
  process.env.GITHUB_ACTIONS = 'true';
  process.env.GITHUB_REPOSITORY = 'o/r';
  process.env.GITHUB_REPOSITORY_ID = '99';
  process.env.GITHUB_RUN_ID = '1700000000';
  process.env.GITHUB_REF = 'refs/pull/42/head';
}

test('action-entry: cachePort.restore called BEFORE runReview', async () => {
  const calls = setupStubs({ runReviewImpl: () => 0 });
  const snap = snapshotEnv();
  setEnv();
  const origExit = process.exit;
  process.exit = () => {};
  try {
    const mod = freshRequire(ACTION_ENTRY);
    await mod.main();
  } finally {
    process.exit = origExit;
    restoreEnv(snap);
  }
  const order = calls.map((c) => c.fn);
  const restoreIdx = order.indexOf('restore');
  const runIdx = order.indexOf('runReview');
  assert.ok(restoreIdx >= 0, 'restore was called');
  assert.ok(runIdx >= 0, 'runReview was called');
  assert.ok(restoreIdx < runIdx, `restore (${restoreIdx}) should precede runReview (${runIdx})`);
});

test('action-entry: cachePort.save called in finally even when runReview throws', async () => {
  const calls = setupStubs({ runReviewImpl: () => { throw new Error('boom'); } });
  const snap = snapshotEnv();
  setEnv();
  const origExit = process.exit;
  process.exit = () => {};
  try {
    const mod = freshRequire(ACTION_ENTRY);
    await mod.main().catch(() => {});
  } finally {
    process.exit = origExit;
    restoreEnv(snap);
  }
  assert.ok(calls.find((c) => c.fn === 'restore'), 'restore was called before throw');
  assert.ok(calls.find((c) => c.fn === 'save'), 'save called even after runReview threw');
});

test('action-entry: cachePort.save receives dryRun=true when input set', async () => {
  const calls = setupStubs({ runReviewImpl: () => 0, dryRun: true });
  const snap = snapshotEnv();
  setEnv();
  const origExit = process.exit;
  process.exit = () => {};
  try {
    const mod = freshRequire(ACTION_ENTRY);
    await mod.main();
  } finally {
    process.exit = origExit;
    restoreEnv(snap);
  }
  const saveCall = calls.find((c) => c.fn === 'save');
  assert.ok(saveCall, 'save was called');
  assert.equal(saveCall.opts.dryRun, true);
});

test('action-entry: restore and save use RUNNER_TEMP/ai-review as the state root', async () => {
  const calls = setupStubs({ runReviewImpl: () => 0 });
  const snap = snapshotEnv();
  setEnv();
  process.env.RUNNER_TEMP = '/runner/_work/_temp';
  delete process.env.AI_REVIEW_STATE_ROOT;
  const origExit = process.exit;
  process.exit = () => {};
  try {
    const mod = freshRequire(ACTION_ENTRY);
    await mod.main();
  } finally {
    process.exit = origExit;
    restoreEnv(snap);
  }
  const expected = path.join('/runner/_work/_temp', 'ai-review');
  assert.equal(calls.find((c) => c.fn === 'restore').opts.stateRoot, expected);
  assert.equal(calls.find((c) => c.fn === 'save').opts.stateRoot, expected);
});

function setupLearnStubs() {
  const calls = [];
  stubModule('../lib/port/cache-port.js', {
    restore: async (opts) => { calls.push({ fn: 'restore', opts }); return { hit: false, key: null }; },
    save: async (opts) => { calls.push({ fn: 'save', opts }); },
  });
  stubModule('../ai-review.js', {
    runReview: async () => { calls.push({ fn: 'runReview' }); return 0; },
    runReply: async () => 0,
    runLearn: async (args) => { calls.push({ fn: 'runLearn', args }); return 0; },
  });
  stubModule('@actions/core', {
    getInput: (name) => {
      if (name === 'subcommand') return 'learn';
      if (name === 'config-path') return 'ai-review.config.yaml';
      if (name === 'provider') return 'github';
      if (name === 'github-token') return 'test-token';
      if (name === 'deepseek-api-key') return 'dk';
      return ''; // notably: no pr-number
    },
    getBooleanInput: () => false,
    setSecret: () => {},
    setOutput: () => {},
    setFailed: (m) => { calls.push({ fn: 'setFailed', m }); },
  });
  return calls;
}

test('action-entry: learn dispatches runLearn without a PR, no cache, no setFailed', async () => {
  const calls = setupLearnStubs();
  const snap = snapshotEnv();
  process.env.GITHUB_ACTIONS = 'true';
  process.env.GITHUB_REPOSITORY = 'o/r';
  // deliberately no GITHUB_REF / GITHUB_PR_NUMBER — learn must not need them.
  delete process.env.GITHUB_REF;
  delete process.env.GITHUB_PR_NUMBER;
  const origExit = process.exit;
  process.exit = () => {};
  try {
    const mod = freshRequire(ACTION_ENTRY);
    await mod.main();
  } finally {
    process.exit = origExit;
    restoreEnv(snap);
  }
  const fns = calls.map((c) => c.fn);
  assert.ok(fns.includes('runLearn'), 'runLearn was dispatched');
  assert.ok(!fns.includes('setFailed'), 'no PR-gate failure');
  assert.ok(!fns.includes('restore') && !fns.includes('save'), 'per-PR cache skipped for learn');
  assert.ok(!fns.includes('runReview'), 'did not fall through to review');
  const learnCall = calls.find((c) => c.fn === 'runLearn');
  assert.deepEqual(learnCall.args.argv, ['learn', '--config=ai-review.config.yaml', '--provider=github']);
});
