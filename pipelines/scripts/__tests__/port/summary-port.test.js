'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildBody, upsert, MARKER } = require('../../lib/port/summary-port.js');

const baseInput = () => ({
  meta: { id: '42', title: 'My PR' },
  reconcile: { posted: 1, replied: 2, reopened: 0, closed: 3, failures: 0 },
  cost: {
    totalUsd: 0.0123,
    byType: { review: { count: 1, totalUsd: 0.012 }, reply: { count: 2, totalUsd: 0.0003 } },
  },
  dismissed: { dismissedCount: 4 },
  securityContext: { enabled: false, degraded: false },
  now: new Date('2026-05-08T12:00:00Z'),
});

test('buildBody embeds MARKER constant', () => {
  const body = buildBody(baseInput());
  assert.ok(body.endsWith(MARKER));
  assert.equal(MARKER, '<!-- ai-review:v1:summary -->');
});

test('buildBody includes PR id and title', () => {
  const body = buildBody(baseInput());
  assert.ok(body.includes('PR:** #42 — My PR'));
});

test('buildBody hard-breaks adjacent metadata lines for Bitbucket (two trailing spaces)', () => {
  const body = buildBody(baseInput());
  // The PR line is followed by the Findings line — must end in a markdown hard
  // break so Bitbucket/CommonMark renders them on separate lines.
  assert.match(body, /\*\*PR:\*\* #42 — My PR {2}\n\*\*Findings:\*\*/);
  assert.match(body, /\*\*Cost:\*\*[^\n]* {2}\n\*\*Dismissed context:\*\*/);
});

test('buildBody renders reconcile counts', () => {
  const body = buildBody(baseInput());
  assert.ok(body.includes('1 new · 2 replied · 0 reopened · 3 closed'));
});

test('buildBody renders cost with 4 decimals and total call count', () => {
  const body = buildBody(baseInput());
  assert.ok(body.includes('$0.0123'));
  assert.ok(body.includes('(3 call(s))'));
});

test('buildBody renders dismissed count', () => {
  const body = buildBody(baseInput());
  assert.ok(body.includes('4 prior wontfix/fixed thread(s)'));
});

test('buildBody marks security disabled', () => {
  const body = buildBody(baseInput());
  assert.ok(body.includes('Security context:** disabled'));
});

test('buildBody marks security degraded with reason', () => {
  const input = baseInput();
  input.securityContext = { enabled: true, degraded: true, reason: 'semgrep timeout' };
  const body = buildBody(input);
  assert.ok(body.includes('degraded — semgrep timeout'));
});

test('buildBody marks security active when enabled+ok', () => {
  const input = baseInput();
  input.securityContext = { enabled: true, degraded: false };
  const body = buildBody(input);
  assert.ok(body.includes('Security context:** active'));
});

test('buildBody appends failure suffix when failures > 0', () => {
  const input = baseInput();
  input.reconcile.failures = 2;
  const body = buildBody(input);
  assert.ok(body.includes('**2 failure(s)**'));
});

test('buildBody omits failure suffix when failures == 0', () => {
  const body = buildBody(baseInput());
  assert.ok(!body.includes('failure(s)'));
});

test('buildBody uses provided now timestamp', () => {
  const body = buildBody(baseInput());
  assert.ok(body.includes('2026-05-08T12:00:00.000Z'));
});

test('buildBody handles missing byType counts as zero', () => {
  const input = baseInput();
  input.cost = { totalUsd: 0, byType: {} };
  const body = buildBody(input);
  assert.ok(body.includes('(0 call(s))'));
});

test('upsert delegates to provider.upsertSummaryComment with key="summary"', async () => {
  const calls = [];
  const provider = {
    upsertSummaryComment: async (key, body) => {
      calls.push({ key, body });
      return { id: 'c1', action: 'created' };
    },
  };
  const r = await upsert(provider, 'BODY');
  assert.deepEqual(calls, [{ key: 'summary', body: 'BODY' }]);
  assert.deepEqual(r, { id: 'c1', action: 'created' });
});

test('upsert returns provider result unchanged', async () => {
  const provider = {
    upsertSummaryComment: async () => ({ id: 'c2', action: 'updated' }),
  };
  const r = await upsert(provider, 'b');
  assert.deepEqual(r, { id: 'c2', action: 'updated' });
});

test('upsert mode=sticky (default) uses fixed key="summary"', async () => {
  const calls = [];
  const provider = {
    upsertSummaryComment: async (key) => { calls.push(key); return { id: '1', action: 'updated' }; },
  };
  await upsert(provider, 'b', { mode: 'sticky' });
  assert.deepEqual(calls, ['summary']);
});

test('upsert mode=append uses per-run unique key derived from runId', async () => {
  const calls = [];
  const provider = {
    upsertSummaryComment: async (key) => { calls.push(key); return { id: '1', action: 'created' }; },
  };
  await upsert(provider, 'b', { mode: 'append', runId: 'run-12345' });
  assert.deepEqual(calls, ['summary-run-12345']);
});

test('upsert mode=append rewrites the body marker to match the run key', async () => {
  // A provider that renders distinct markers per key (like the real codec).
  const provider = {
    renderSummaryMarker: (k = 'summary') => `<!-- ai-review:v1:${k} -->`,
    upsertSummaryComment: async (key, body) => ({ key, body }),
  };
  const body = 'Summary\n\n<!-- ai-review:v1:summary -->';
  const r = await upsert(provider, body, { mode: 'append', runId: 'run-1' });
  assert.equal(r.key, 'summary-run-1');
  // The embedded marker must match the lookup key so re-runs update in place.
  assert.ok(r.body.includes('<!-- ai-review:v1:summary-run-1 -->'));
  assert.ok(!r.body.includes('<!-- ai-review:v1:summary -->'));
});

test('upsert mode=append falls back to a wall-clock key when runId is missing', async () => {
  // The GitLab/Azure/Bitbucket run id reaches upsert as an injected value; it
  // must not read process.env directly. With no runId the key is still unique
  // (wall clock) so local runs get their own comment.
  const prev = process.env.GITHUB_RUN_ID;
  process.env.GITHUB_RUN_ID = 'env-987';
  try {
    const calls = [];
    const provider = {
      upsertSummaryComment: async (key) => { calls.push(key); return { id: '1', action: 'created' }; },
    };
    await upsert(provider, 'b', { mode: 'append' });
    assert.equal(calls.length, 1);
    assert.match(calls[0], /^summary-\d+$/);
    assert.notEqual(calls[0], 'summary-env-987');
  } finally {
    if (prev === undefined) delete process.env.GITHUB_RUN_ID;
    else process.env.GITHUB_RUN_ID = prev;
  }
});

test('upsert mode=append generates distinct keys when runId differs', async () => {
  const calls = [];
  const provider = {
    upsertSummaryComment: async (key) => { calls.push(key); return { id: '1', action: 'created' }; },
  };
  await upsert(provider, 'a', { mode: 'append', runId: 'r1' });
  await upsert(provider, 'b', { mode: 'append', runId: 'r2' });
  assert.equal(calls[0], 'summary-r1');
  assert.equal(calls[1], 'summary-r2');
  assert.notEqual(calls[0], calls[1]);
});

test('buildBody omits strict line when strict.enabled=false', () => {
  const input = baseInput();
  input.strict = { enabled: false, triggered: false, threshold: 'medium', blockingCount: 0 };
  const body = buildBody(input);
  assert.ok(!body.includes('Strict mode'), 'no strict line when disabled');
});

test('buildBody renders triggered line when strict.triggered=true', () => {
  const input = baseInput();
  input.strict = { enabled: true, triggered: true, threshold: 'medium', blockingCount: 2 };
  const body = buildBody(input);
  assert.match(body, /Strict mode: 2 blocking finding/);
  assert.match(body, /severity ≥ `medium`/);
});

test('buildBody renders no-blocking line when strict.enabled=true and triggered=false', () => {
  const input = baseInput();
  input.strict = { enabled: true, triggered: false, threshold: 'high', blockingCount: 0 };
  const body = buildBody(input);
  assert.match(body, /Strict mode: no blocking findings/);
  assert.match(body, /severity ≥ `high`/);
});

test('buildBody renders cumulative cost line when cumulative.runCount > 0', () => {
  const body = buildBody({ ...baseInput(), cumulative: { totalUsd: 0.04, runCount: 3 } });
  assert.ok(/\*\*Cumulative cost:\*\*\s*\$0\.0400\s+over\s+3\s+run\(s\)/.test(body),
    `cumulative line missing or malformed:\n${body}`);
});

test('buildBody omits cumulative cost line when runCount === 0', () => {
  const body = buildBody({ ...baseInput(), cumulative: { totalUsd: 0, runCount: 0 } });
  assert.ok(!/Cumulative cost/.test(body), `cumulative line should not render:\n${body}`);
});

test('buildBody omits cumulative cost line when cumulative undefined (back-compat)', () => {
  const body = buildBody(baseInput());
  assert.ok(!/Cumulative cost/.test(body));
});

test('buildBody renders metrics section with severity breakdown', () => {
  const input = baseInput();
  input.metrics = { bySeverity: { CRITICAL: 1, HIGH: 2, LOW: 3 }, durationMs: 12345, filesReviewed: 10, filesSkipped: 2 };
  const body = buildBody(input);
  assert.ok(body.includes('**Metrics**'));
  assert.ok(body.includes('1 CRITICAL'));
  assert.ok(body.includes('2 HIGH'));
  assert.ok(body.includes('3 LOW'));
  assert.ok(body.includes('12.3s'));
  assert.ok(body.includes('10 reviewed'));
  assert.ok(body.includes('2 skipped'));
});

test('buildBody omits metrics section when metrics undefined', () => {
  const body = buildBody(baseInput());
  assert.ok(!body.includes('**Metrics**'));
});

test('buildBody renders severity "none" when bySeverity is empty', () => {
  const input = baseInput();
  input.metrics = { bySeverity: {}, filesReviewed: 5, filesSkipped: 0 };
  const body = buildBody(input);
  assert.ok(body.includes('Severity: none'));
  assert.ok(!body.includes('skipped'));
});

test('buildBody header includes visible AI Review label from CONFIG', () => {
  const body = buildBody(baseInput());
  assert.ok(body.startsWith('### [Owlet Lens] Summary'));
});
