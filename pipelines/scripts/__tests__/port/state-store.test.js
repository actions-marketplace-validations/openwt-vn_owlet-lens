'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { load, append, _statePathFor, resolveStateRoot } = require('../../lib/port/state-store.js');

function withTempRoot(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-state-'));
  try { return fn(tmp); } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

test('load returns empty record for unknown PR', async () => {
  await withTempRoot((root) => {
    const r = load({ repo: 'o/r', prNumber: 1, root });
    assert.equal(r.version, 1);
    assert.equal(r.repo, 'o/r');
    assert.equal(r.prNumber, 1);
    assert.equal(r.cumulativeCostUsd, 0);
    assert.deepEqual(r.invocations, []);
  });
});

test('append writes and returns updated record', async () => {
  await withTempRoot((root) => {
    const inv = { type: 'review', ts: '2026-05-08T10:00:00Z', costUsd: 0.012, model: 'claude-opus-4-7' };
    const r = append({ repo: 'o/r', prNumber: 7, root }, inv);
    assert.equal(r.invocations.length, 1);
    assert.equal(r.cumulativeCostUsd, 0.012);
    const r2 = load({ repo: 'o/r', prNumber: 7, root });
    assert.deepEqual(r2.invocations, [inv]);
  });
});

test('append accumulates across calls', async () => {
  await withTempRoot((root) => {
    append({ repo: 'o/r', prNumber: 7, root }, { type: 'review', ts: 't1', costUsd: 0.01, model: 'm' });
    const r = append({ repo: 'o/r', prNumber: 7, root }, { type: 'reply', ts: 't2', costUsd: 0.001, model: 'm' });
    assert.equal(r.invocations.length, 2);
    assert.ok(Math.abs(r.cumulativeCostUsd - 0.011) < 1e-9);
  });
});

test('load on corrupt JSON returns empty record + warns to stderr', async () => {
  await withTempRoot((root) => {
    const p = _statePathFor({ repo: 'o/r', prNumber: 9, root });
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'not json');
    const captured = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (s) => { captured.push(String(s)); return true; };
    try {
      const r = load({ repo: 'o/r', prNumber: 9, root });
      assert.deepEqual(r.invocations, []);
    } finally {
      process.stderr.write = origWrite;
    }
    assert.ok(captured.some((s) => s.includes('state-store')));
  });
});

test('different (repo,pr) pairs go to different files', async () => {
  await withTempRoot((root) => {
    const a = _statePathFor({ repo: 'o/r', prNumber: 1, root });
    const b = _statePathFor({ repo: 'o/r', prNumber: 2, root });
    const c = _statePathFor({ repo: 'x/y', prNumber: 1, root });
    assert.notEqual(a, b);
    assert.notEqual(a, c);
  });
});

test('append uses atomic write (no partial state visible)', async () => {
  await withTempRoot((root) => {
    append({ repo: 'o/r', prNumber: 1, root }, { type: 'review', ts: 't', costUsd: 0.001, model: 'm' });
    const p = _statePathFor({ repo: 'o/r', prNumber: 1, root });
    // Tmp file should not be left behind.
    const dir = path.dirname(p);
    const leftover = fs.readdirSync(dir).filter((f) => f.includes('.tmp.'));
    assert.deepEqual(leftover, []);
  });
});

test('resolveStateRoot: AI_REVIEW_STATE_ROOT wins over RUNNER_TEMP', () => {
  assert.equal(
    resolveStateRoot({ AI_REVIEW_STATE_ROOT: '/custom', RUNNER_TEMP: '/runner/_work/_temp' }),
    '/custom',
  );
});

test('resolveStateRoot: RUNNER_TEMP/ai-review on a GitHub Actions runner', () => {
  // actions/cache stores a path outside the workspace relative to it, so
  // /tmp/ai-review breaks restores across runners at different depths.
  assert.equal(
    resolveStateRoot({ RUNNER_TEMP: '/runner/_work/_temp' }),
    path.join('/runner/_work/_temp', 'ai-review'),
  );
});

test('resolveStateRoot: /tmp/ai-review off Actions, empty values count as unset', () => {
  assert.equal(resolveStateRoot({}), '/tmp/ai-review');
  assert.equal(resolveStateRoot({ AI_REVIEW_STATE_ROOT: '', RUNNER_TEMP: '' }), '/tmp/ai-review');
});

test('load/append/_statePathFor without root (or root: null) use resolveStateRoot(process.env)', async () => {
  const saved = { RUNNER_TEMP: process.env.RUNNER_TEMP, AI_REVIEW_STATE_ROOT: process.env.AI_REVIEW_STATE_ROOT };
  await withTempRoot((tmp) => {
    try {
      process.env.RUNNER_TEMP = tmp;
      delete process.env.AI_REVIEW_STATE_ROOT;
      const expectedRoot = path.join(tmp, 'ai-review');
      const p = _statePathFor({ repo: 'o/r', prNumber: 3 });
      assert.ok(p.startsWith(expectedRoot + path.sep));
      assert.equal(_statePathFor({ repo: 'o/r', prNumber: 3, root: null }), p);
      append({ repo: 'o/r', prNumber: 3 }, { type: 'review', ts: 't1', costUsd: 0.01, model: 'm' });
      assert.ok(fs.existsSync(p));
      const r = load({ repo: 'o/r', prNumber: 3 });
      assert.equal(r.invocations.length, 1);
      assert.equal(r.cumulativeCostUsd, 0.01);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  });
});
