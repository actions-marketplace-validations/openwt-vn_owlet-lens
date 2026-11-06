'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cachePort = require('../../lib/port/cache-port.js');

function makeExistingStateRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ai-review-cp-'));
}

function makeFakeCache() {
  /** @type {{ restoreCalls: any[], saveCalls: any[], restoreReturn: any, restoreThrow: Error|null, saveThrow: Error|null }} */
  const state = {
    restoreCalls: [],
    saveCalls: [],
    restoreReturn: undefined,
    restoreThrow: null,
    saveThrow: null,
  };
  return {
    state,
    client: {
      restoreCache: async (paths, primaryKey, restoreKeys) => {
        state.restoreCalls.push({ paths, primaryKey, restoreKeys });
        if (state.restoreThrow) throw state.restoreThrow;
        return state.restoreReturn;
      },
      saveCache: async (paths, key) => {
        state.saveCalls.push({ paths, key });
        if (state.saveThrow) throw state.saveThrow;
        return 12345;
      },
    },
  };
}

function captureStderr(fn) {
  /** @type {string[]} */
  const lines = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (s) => { lines.push(String(s)); return true; };
  return Promise.resolve(fn()).finally(() => { process.stderr.write = orig; })
    .then(() => lines);
}

test('cache-port: restore returns no-op when GITHUB_ACTIONS != true', async () => {
  const fake = makeFakeCache();
  const r = await cachePort.restore({
    stateRoot: '/tmp/ai-review',
    repoId: '99', prNum: 42,
    env: { GITHUB_ACTIONS: 'false' },
    cacheClient: fake.client,
  });
  assert.deepEqual(r, { hit: false, key: null });
  assert.equal(fake.state.restoreCalls.length, 0);
});

test('cache-port: restore returns no-op + warn when repoId or prNum missing', async () => {
  const fake = makeFakeCache();
  let r;
  const lines = await captureStderr(async () => {
    r = await cachePort.restore({
      stateRoot: '/tmp/ai-review',
      repoId: '', prNum: 42,
      env: { GITHUB_ACTIONS: 'true' },
      cacheClient: fake.client,
    });
  });
  assert.deepEqual(r, { hit: false, key: null });
  assert.equal(fake.state.restoreCalls.length, 0);
  assert.ok(lines.some((l) => l.includes('"level":"warn"') && l.includes('cache-port.restore')));
});

test('cache-port: restore calls restoreCache with prefix restore-key on hit', async () => {
  const fake = makeFakeCache();
  fake.state.restoreReturn = 'ai-review-state-v1-99-pr-42-1700000000';
  const r = await cachePort.restore({
    stateRoot: '/tmp/ai-review',
    repoId: '99', prNum: 42,
    env: { GITHUB_ACTIONS: 'true' },
    cacheClient: fake.client,
  });
  assert.equal(r.hit, true);
  assert.equal(r.key, 'ai-review-state-v1-99-pr-42-1700000000');
  assert.deepEqual(fake.state.restoreCalls[0].paths, ['/tmp/ai-review']);
  assert.equal(fake.state.restoreCalls[0].primaryKey, 'ai-review-state-v1-99-pr-42-');
  assert.deepEqual(fake.state.restoreCalls[0].restoreKeys, ['ai-review-state-v1-99-pr-42-']);
});

test('cache-port: restore returns hit:false when restoreCache returns undefined (cache miss)', async () => {
  const fake = makeFakeCache();
  fake.state.restoreReturn = undefined;
  const r = await cachePort.restore({
    stateRoot: '/tmp/ai-review',
    repoId: '99', prNum: 42,
    env: { GITHUB_ACTIONS: 'true' },
    cacheClient: fake.client,
  });
  assert.equal(r.hit, false);
  assert.equal(r.key, null);
});

test('cache-port: restore swallows error and emits warn log', async () => {
  const fake = makeFakeCache();
  fake.state.restoreThrow = new Error('network down');
  let r;
  const lines = await captureStderr(async () => {
    r = await cachePort.restore({
      stateRoot: '/tmp/ai-review',
      repoId: '99', prNum: 42,
      env: { GITHUB_ACTIONS: 'true' },
      cacheClient: fake.client,
    });
  });
  assert.deepEqual(r, { hit: false, key: null });
  assert.ok(lines.some((l) => l.includes('"level":"warn"') && l.includes('network down')));
});

test('cache-port: save no-op when GITHUB_ACTIONS != true', async () => {
  const fake = makeFakeCache();
  await cachePort.save({
    stateRoot: '/tmp/ai-review',
    repoId: '99', prNum: 42, runId: '1700000000',
    dryRun: false,
    env: { GITHUB_ACTIONS: 'false' },
    cacheClient: fake.client,
  });
  assert.equal(fake.state.saveCalls.length, 0);
});

test('cache-port: save no-op when dryRun=true', async () => {
  const fake = makeFakeCache();
  await cachePort.save({
    stateRoot: '/tmp/ai-review',
    repoId: '99', prNum: 42, runId: '1700000000',
    dryRun: true,
    env: { GITHUB_ACTIONS: 'true' },
    cacheClient: fake.client,
  });
  assert.equal(fake.state.saveCalls.length, 0);
});

test('cache-port: save calls saveCache with run-id-suffixed primary key', async (t) => {
  const fake = makeFakeCache();
  const stateRoot = makeExistingStateRoot();
  t.after(() => fs.rmSync(stateRoot, { recursive: true, force: true }));
  await cachePort.save({
    stateRoot,
    repoId: '99', prNum: 42, runId: '1700000000',
    dryRun: false,
    env: { GITHUB_ACTIONS: 'true' },
    cacheClient: fake.client,
  });
  assert.equal(fake.state.saveCalls.length, 1);
  assert.deepEqual(fake.state.saveCalls[0].paths, [stateRoot]);
  assert.equal(fake.state.saveCalls[0].key, 'ai-review-state-v1-99-pr-42-1700000000');
});

test('cache-port: save warn+no-op when runId missing', async () => {
  const fake = makeFakeCache();
  const lines = await captureStderr(async () => {
    await cachePort.save({
      stateRoot: '/tmp/ai-review',
      repoId: '99', prNum: 42, runId: '',
      dryRun: false,
      env: { GITHUB_ACTIONS: 'true' },
      cacheClient: fake.client,
    });
  });
  assert.equal(fake.state.saveCalls.length, 0);
  assert.ok(lines.some((l) => l.includes('"level":"warn"') && l.includes('cache-port.save')));
});

test('cache-port: save swallows error and emits warn (no throw)', async (t) => {
  const fake = makeFakeCache();
  fake.state.saveThrow = new Error('quota exceeded');
  const stateRoot = makeExistingStateRoot();
  t.after(() => fs.rmSync(stateRoot, { recursive: true, force: true }));
  const lines = await captureStderr(async () => {
    await cachePort.save({
      stateRoot,
      repoId: '99', prNum: 42, runId: '1700000000',
      dryRun: false,
      env: { GITHUB_ACTIONS: 'true' },
      cacheClient: fake.client,
    });
  });
  assert.equal(fake.state.saveCalls.length, 1);
  assert.ok(lines.some((l) => l.includes('"level":"warn"') && l.includes('quota exceeded')));
});

test('cache-port: save skips with info log when stateRoot does not exist', async () => {
  const fake = makeFakeCache();
  const missing = path.join(os.tmpdir(), `ai-review-missing-${process.pid}-${Date.now()}`);
  const lines = await captureStderr(async () => {
    await cachePort.save({
      stateRoot: missing,
      repoId: '99', prNum: 42, runId: '1700000000',
      dryRun: false,
      env: { GITHUB_ACTIONS: 'true' },
      cacheClient: fake.client,
    });
  });
  assert.equal(fake.state.saveCalls.length, 0, 'saveCache must not be invoked when path missing');
  assert.ok(
    lines.some((l) => l.includes('"level":"info"') && l.includes('cache-port.save') && l.includes('does not exist')),
    'expected info log for missing-path skip',
  );
});
