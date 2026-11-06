// @ts-check
'use strict';

// Run-lifecycle unit tests: the cross-cutting concerns (error→exit-code
// cascade, state-store append, audit-log write, repo resolution) shared by
// every subcommand.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  runLifecycle, createLifecycle, reportFatalError, exitCodeFor, describeError,
} = require('../lib/run-lifecycle.js');
const stateStore = require('../lib/port/state-store.js');
const {
  ConfigError, AuthError, ProviderError, LLMError, ValidationError,
} = require('../lib/errors.js');

function captureStderr(fn) {
  const lines = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => { lines.push(String(chunk)); return true; };
  try {
    return { result: fn(), lines };
  } finally {
    process.stderr.write = orig;
  }
}

describe('error → exit code cascade', () => {
  it('maps each typed error to its documented exit code', () => {
    assert.equal(exitCodeFor(new ConfigError('x')), 2);
    assert.equal(exitCodeFor(new AuthError('x', { provider: 'github' })), 3);
    assert.equal(exitCodeFor(new ProviderError('x', { provider: 'github' })), 4);
    assert.equal(exitCodeFor(new LLMError('x')), 5);
    assert.equal(exitCodeFor(new ValidationError('x')), 7);
  });

  it('matches AuthError before its ProviderError parent (exit 3, not 4)', () => {
    assert.equal(describeError(new AuthError('x', { provider: 'github' })).label, 'auth error');
    assert.equal(exitCodeFor(new AuthError('x', { provider: 'github' })), 3);
  });

  it('falls back to exit 4 with an unexpected label for unknown errors', () => {
    assert.equal(exitCodeFor(new TypeError('boom')), 4);
    assert.equal(describeError(new TypeError('boom')).label, 'unexpected (TypeError)');
  });

  it('reportFatalError logs one structured line and returns the code', () => {
    const { result, lines } = captureStderr(() =>
      reportFatalError(new ConfigError('bad config'), { durationMs: 12 }));
    assert.equal(result, 2);
    const rec = JSON.parse(lines[0]);
    assert.equal(rec.level, 'error');
    assert.equal(rec.msg, 'config error');
    assert.equal(rec.errName, 'ConfigError');
    assert.equal(rec.errMessage, 'bad config');
    assert.equal(rec.durationMs, 12);
  });

  it('runLifecycle returns the success code from the runner', async () => {
    const code = await runLifecycle({ env: {} }, async () => 1);
    assert.equal(code, 1);
  });

  it('runLifecycle hands the context to the runner and catches thrown errors', async () => {
    const orig = process.stderr.write.bind(process.stderr);
    const lines = [];
    process.stderr.write = (chunk) => { lines.push(String(chunk)); return true; };
    let sawContext = false;
    let code;
    try {
      code = await runLifecycle({ env: {} }, async (life) => {
        sawContext = typeof life.elapsedMs === 'function';
        throw new ValidationError('nope');
      });
    } finally {
      process.stderr.write = orig;
    }
    assert.equal(sawContext, true);
    assert.equal(code, 7);
    assert.equal(JSON.parse(lines[0]).msg, 'validation error');
  });
});

describe('createLifecycle.appendState', () => {
  it('appends an invocation when a repo and PR are present', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-state-'));
    try {
      const life = createLifecycle({ env: { GITHUB_REPOSITORY: 'o/r' } });
      const next = life.appendState({
        prNumber: 5,
        root,
        invocation: { type: 'review', ts: '2026-01-01T00:00:00Z', costUsd: 0.5, model: 'm' },
      });
      assert.ok(next);
      assert.equal(next.invocations.length, 1);
      const rec = stateStore.load({ repo: 'o/r', prNumber: 5, root });
      assert.equal(rec.invocations[0].type, 'review');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('defaults the state root to RUNNER_TEMP/ai-review', () => {
    const runnerTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-runner-temp-'));
    try {
      const life = createLifecycle({ env: { GITHUB_REPOSITORY: 'o/r', RUNNER_TEMP: runnerTemp } });
      life.appendState({
        prNumber: 5,
        invocation: { type: 'review', ts: '2026-01-01T00:00:00Z', costUsd: 0.5, model: 'm' },
      });
      const root = path.join(runnerTemp, 'ai-review');
      assert.ok(fs.existsSync(stateStore._statePathFor({ repo: 'o/r', prNumber: 5, root })));
    } finally {
      fs.rmSync(runnerTemp, { recursive: true, force: true });
    }
  });

  it('is a no-op when disabled, or when repo/PR are missing', () => {
    const life = createLifecycle({ env: { GITHUB_REPOSITORY: 'o/r' } });
    const inv = { type: 'reply', ts: 'x', costUsd: 0, model: 'm' };
    assert.equal(life.appendState({ prNumber: 5, invocation: inv, enabled: false }), null);
    assert.equal(life.appendState({ prNumber: 0, invocation: inv }), null);
    const noRepo = createLifecycle({ env: {} });
    assert.equal(noRepo.appendState({ prNumber: 5, invocation: inv }), null);
  });

  it('warns instead of throwing when the store append fails', () => {
    const orig = stateStore.append;
    stateStore.append = () => { throw new Error('disk full'); };
    try {
      const life = createLifecycle({ env: { GITHUB_REPOSITORY: 'o/r' } });
      const { result, lines } = captureStderr(() => life.appendState({
        prNumber: 5,
        invocation: { type: 'reply', ts: 'x', costUsd: 0, model: 'm' },
      }));
      assert.equal(result, null);
      const rec = JSON.parse(lines[0]);
      assert.equal(rec.level, 'warn');
      assert.equal(rec.msg, 'state-store append failed (reply)');
      assert.equal(rec.errMessage, 'disk full');
    } finally {
      stateStore.append = orig;
    }
  });
});

describe('createLifecycle.writeAudit', () => {
  it('appends a JSONL entry tagged with the caller-supplied repo', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-audit-'));
    const logPath = path.join(dir, 'audit.jsonl');
    try {
      const life = createLifecycle({ env: {} });
      const ok = life.writeAudit({ path: logPath, entry: { event: 'review', prId: 5 }, repo: 'o/r' });
      assert.equal(ok, true);
      const rec = JSON.parse(fs.readFileSync(logPath, 'utf8').trim());
      assert.equal(rec.event, 'review');
      assert.equal(rec.repo, 'o/r');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('tags the entry with a null repo when the caller has none', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-audit-norepo-'));
    const logPath = path.join(dir, 'audit.jsonl');
    try {
      const life = createLifecycle({ env: {} });
      assert.equal(life.writeAudit({ path: logPath, entry: { event: 'review' } }), true);
      const rec = JSON.parse(fs.readFileSync(logPath, 'utf8').trim());
      assert.equal(rec.repo, null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is a no-op without a path or when disabled', () => {
    const life = createLifecycle({ env: {} });
    assert.equal(life.writeAudit({ entry: { event: 'review' } }), false);
    assert.equal(life.writeAudit({ path: 'x.jsonl', entry: {}, enabled: false }), false);
  });

  it('warns instead of throwing when the write fails', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-audit-err-'));
    try {
      const life = createLifecycle({ env: {} });
      // A path pointing at an existing directory makes appendFileSync fail.
      const { result, lines } = captureStderr(() =>
        life.writeAudit({ path: dir, entry: { event: 'reply' } }));
      assert.equal(result, false);
      const rec = JSON.parse(lines[0]);
      assert.equal(rec.level, 'warn');
      assert.equal(rec.msg, 'audit-log.write.failed');
      assert.equal(rec.event, 'reply');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
