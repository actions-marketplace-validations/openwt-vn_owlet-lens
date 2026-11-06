// @ts-check
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { GitLabReviewProvider, __test__ } = require('../../lib/providers/gitlab.js');
const { AuthError, ProviderError, RateLimitError } = require('../../lib/errors.js');
const { isBotNote, mapChange } = __test__;

const ENV = { GITLAB_TOKEN: 'glpat-tok', CI_PROJECT_ID: '42', CI_MERGE_REQUEST_IID: '10' };

/** Route-table fake fetch. Keys: `METHOD path-substring` (longest fragment wins). */
function fakeFetch(routes, calls = []) {
  return async (url, init = {}) => {
    const method = (init.method || 'GET').toUpperCase();
    calls.push({ method, url, body: init.body });
    let best = null;
    for (const [key, handler] of Object.entries(routes)) {
      const [m, ...rest] = key.split(' ');
      const frag = rest.join(' ');
      if (m === method && url.includes(frag) && (!best || frag.length > best.frag.length))
        best = { frag, handler };
    }
    if (!best) throw new Error(`fakeFetch: no route for ${method} ${url}`);
    const r = typeof best.handler === 'function' ? best.handler(url, init) : best.handler;
    const status = r.status ?? 200;
    return {
      ok: status >= 200 && status < 300, status,
      json: async () => r.json ?? {}, text: async () => r.text ?? '',
      headers: { get: (h) => (r.headers ?? {})[h.toLowerCase()] ?? null },
    };
  };
}

function makeProvider(routes, calls) {
  return new GitLabReviewProvider({
    config: { auth: { gitlabToken: 'glpat-tok' }, markers: { prefix: 'ai-review' } },
    env: ENV, deps: { fetch: fakeFetch(routes, calls), sleep: async () => {} },
  });
}

/** Shorthand: provider with raw fetch function (for _paginate tests). */
function providerWithFetch(fn) {
  return new GitLabReviewProvider({
    config: { auth: { gitlabToken: 't' }, markers: { prefix: 'ai-review' } },
    env: ENV, deps: { fetch: fn, sleep: async () => {} },
  });
}

// -- helpers -----------------------------------------------------------------
test('isBotNote: true for author.bot flag', () => {
  assert.ok(isBotNote({ author: { bot: true, username: 'human' } }));
});
test('isBotNote: true for username matching bot pattern', () => {
  assert.ok(isBotNote({ author: { username: 'project_123_bot' } }));
  assert.ok(isBotNote({ author: { username: 'ci-token' } }));
  assert.ok(isBotNote({ author: { name: 'ci-bot' } }));
});
test('isBotNote: false for regular user or missing author', () => {
  assert.ok(!isBotNote({ author: { username: 'alice' } }));
  assert.ok(!isBotNote(null));
  assert.ok(!isBotNote({}));
});
test('mapChange: add / delete / rename / modify', () => {
  assert.equal(mapChange(true, false, false), 'add');
  assert.equal(mapChange(false, true, false), 'delete');
  assert.equal(mapChange(false, false, true), 'rename');
  assert.equal(mapChange(false, false, false), 'modify');
});

// -- constructor -------------------------------------------------------------

test('constructor: throws AuthError when token missing', () => {
  assert.throws(() => new GitLabReviewProvider({ config: {}, env: {}, deps: { fetch: async () => ({}) } }), AuthError);
});
test('constructor: throws ProviderError when projectId missing', () => {
  assert.throws(
    () => new GitLabReviewProvider({ config: { auth: { gitlabToken: 't' } }, env: { GITLAB_TOKEN: 't' }, deps: { fetch: async () => ({}) } }),
    ProviderError);
});
test('constructor: throws ProviderError when MR iid missing', () => {
  assert.throws(
    () => new GitLabReviewProvider({ config: { auth: { gitlabToken: 't' } }, env: { GITLAB_TOKEN: 't', CI_PROJECT_ID: '1' }, deps: { fetch: async () => ({}) } }),
    ProviderError);
});
test('constructor: requirePr=false skips MR iid check', () => {
  const p = new GitLabReviewProvider({
    config: { auth: { gitlabToken: 't' } }, env: { GITLAB_TOKEN: 't', CI_PROJECT_ID: '1' },
    deps: { fetch: async () => ({}) }, requirePr: false,
  });
  assert.equal(p.mrIid, null);
});
test('constructor: CI_JOB_TOKEN selects JOB-TOKEN header', () => {
  const p = new GitLabReviewProvider({
    config: {}, env: { CI_JOB_TOKEN: 'job-tok', CI_PROJECT_ID: '1', CI_MERGE_REQUEST_IID: '5' },
    deps: { fetch: async () => ({}) },
  });
  assert.equal(p._authHeader, 'JOB-TOKEN');
  assert.equal(p.token, 'job-tok');
});
test('constructor: PRIVATE-TOKEN header when not CI_JOB_TOKEN', () => {
  assert.equal(makeProvider({})._authHeader, 'PRIVATE-TOKEN');
});
test('constructor: custom baseUrl with trailing slash stripped', () => {
  const p = new GitLabReviewProvider({
    config: { auth: { gitlabToken: 't' }, gitlab: { baseUrl: 'https://gl.example.com/' } },
    env: { GITLAB_TOKEN: 't', CI_PROJECT_ID: '1', CI_MERGE_REQUEST_IID: '2' },
    deps: { fetch: async () => ({}) },
  });
  assert.equal(p.baseUrl, 'https://gl.example.com');
});
test('capabilities: expected values', () => {
  const c = makeProvider({}).capabilities;
  assert.equal(c.canProposeChanges, true);
  assert.equal(c.supportsFileContent, true);
  assert.equal(c.nativeWontFix, false);
});

// -- run identity (ADR-0012) -------------------------------------------------

test('run identity: CI_PIPELINE_ID and CI_PROJECT_PATH', () => {
  const p = new GitLabReviewProvider({
    config: { auth: { gitlabToken: 't' } },
    env: { GITLAB_TOKEN: 't', CI_PROJECT_ID: '1', CI_MERGE_REQUEST_IID: '2', CI_PIPELINE_ID: '9988', CI_PROJECT_PATH: 'group/sub/project' },
    deps: { fetch: async () => ({}) },
  });
  assert.equal(p.runId, '9988');
  assert.equal(p.repoSlug, 'group/sub/project');
});

test('run identity: null outside CI', () => {
  const p = new GitLabReviewProvider({
    config: { auth: { gitlabToken: 't' } },
    env: { GITLAB_TOKEN: 't', CI_PROJECT_ID: '1', CI_MERGE_REQUEST_IID: '2' },
    deps: { fetch: async () => ({}) },
  });
  assert.equal(p.runId, null);
  assert.equal(p.repoSlug, null);
});

// -- _api --------------------------------------------------------------------

test('_api: 429 throws RateLimitError with retryAfterMs', async () => {
  const p = makeProvider({ 'GET /test': { status: 429, text: 'slow', headers: { 'retry-after': '5' } } });
  await assert.rejects(() => p._api('/test'), (e) => { assert.ok(e instanceof RateLimitError); assert.equal(e.retryAfterMs, 5000); return true; });
});
test('_api: 401 throws AuthError', async () => {
  await assert.rejects(() => makeProvider({ 'GET /t': { status: 401 } })._api('/t'), AuthError);
});
test('_api: 403 throws AuthError', async () => {
  await assert.rejects(() => makeProvider({ 'GET /t': { status: 403 } })._api('/t'), AuthError);
});
test('_api: 500 throws retryable ProviderError', async () => {
  await assert.rejects(() => makeProvider({ 'GET /t': { status: 500 } })._api('/t'),
    (e) => { assert.ok(e instanceof ProviderError); assert.equal(e.retryable, true); return true; });
});
test('_api: 204 returns null', async () => {
  assert.equal(await makeProvider({ 'DELETE /t': { status: 204 } })._api('/t', { method: 'DELETE' }), null);
});
test('_api: success returns json', async () => {
  assert.deepEqual(await makeProvider({ 'GET /t': { json: { ok: 1 } } })._api('/t'), { ok: 1 });
});
test('_api: raw=true returns text', async () => {
  assert.equal(await makeProvider({ 'GET /t': { text: 'hi' } })._api('/t', { raw: true }), 'hi');
});

// Per-request retry (ADR-0013): a GET repeats, a create (POST) does not.
test('_api: retries a GET after a 5xx and returns the success', async () => {
  const calls = [];
  const p = makeProvider({ 'GET /t': () => (calls.length === 1 ? { status: 503 } : { json: { ok: 1 } }) }, calls);
  assert.deepEqual(await p._api('/t'), { ok: 1 });
  assert.equal(calls.length, 2);
});
test('_api: does not repeat a POST after a 5xx: GitLab may have applied it', async () => {
  const calls = [];
  const p = makeProvider({ 'POST /t': { status: 503 } }, calls);
  await assert.rejects(() => p._api('/t', { method: 'POST', body: {} }), ProviderError);
  assert.equal(calls.length, 1);
});

// -- _paginate ---------------------------------------------------------------

test('_paginate: multi-page via x-next-page header', async () => {
  let n = 0;
  const p = providerWithFetch(async () => {
    n++;
    return {
      ok: true, status: 200, json: async () => [{ id: n }],
      headers: { get: (h) => n === 1 && h === 'x-next-page' ? '2' : null },
    };
  });
  const result = await p._paginate('/projects/42/test');
  assert.equal(result.length, 2);
  assert.equal(n, 2);
});
test('_paginate: retries a failed page without restarting from page 1', async () => {
  const urls = [];
  const p = providerWithFetch(async (url) => {
    urls.push(url);
    const second = url.includes('page=2');
    if (second && urls.length === 2) return { ok: false, status: 503, text: async () => '', headers: { get: () => null } };
    return {
      ok: true, status: 200, json: async () => [second ? 'b' : 'a'],
      headers: { get: (h) => (h === 'x-next-page' && !second ? '2' : null) },
    };
  });
  assert.deepEqual(await p._paginate('/t'), ['a', 'b']);
  assert.equal(urls.length, 3); // page 1, page 2 (503), page 2 again
});
test('_paginate: 401 throws AuthError', async () => {
  const p = providerWithFetch(async () => ({ ok: false, status: 401, text: async () => '', headers: { get: () => null } }));
  await assert.rejects(() => p._paginate('/test'), AuthError);
});
test('_paginate: 429 throws RateLimitError', async () => {
  const p = providerWithFetch(async () => ({
    ok: false, status: 429, text: async () => '',
    headers: { get: (h) => h === 'retry-after' ? '3' : null },
  }));
  await assert.rejects(() => p._paginate('/test'), RateLimitError);
});

// -- getPRMetadata -----------------------------------------------------------

test('getPRMetadata: parses MR response and caches diff_refs', async () => {
  // GitLab's MR API returns diff_refs with keys base_sha/head_sha/start_sha
  // (verified against the live API), not *_commit_sha.
  const dr = { base_sha: 'bbb', head_sha: 'hhh', start_sha: 'sss' };
  const p = makeProvider({ 'GET /merge_requests/10': {
    json: { iid: 10, title: 'feat', description: 'Why', source_branch: 'feat-x', target_branch: 'main', diff_refs: dr, author: { email: 'a@b.com' }, web_url: 'u' },
  } });
  const m = await p.getPRMetadata();
  assert.equal(m.id, '10');
  assert.equal(m.description, 'Why');
  assert.equal(m.sourceBranch, 'feat-x');
  assert.equal(m.sourceSha, 'hhh');
  assert.equal(m.targetSha, 'bbb');
  assert.deepEqual(p._diffRefs, dr);
});

// -- getDiff -----------------------------------------------------------------

test('getDiff: maps diffs with change types', async () => {
  const p = makeProvider({
    'GET /merge_requests/10/diffs': {
      json: [
        { new_path: 'a.js', new_file: true, diff: '+l' },
        { new_path: 'b.js', old_path: 'b-old.js', renamed_file: true, diff: 'r' },
        { new_path: 'c.js', deleted_file: true, diff: '-l' },
        { new_path: 'd.js', diff: '~l' },
      ], headers: { 'x-next-page': null },
    },
  });
  const d = await p.getDiff();
  assert.equal(d.length, 4);
  assert.equal(d[0].change, 'add');
  assert.equal(d[1].change, 'rename');
  assert.equal(d[1].oldPath, 'b-old.js');
  assert.equal(d[2].change, 'delete');
  assert.equal(d[3].change, 'modify');
});

// -- getFileContent ----------------------------------------------------------

test('getFileContent: returns content on success', async () => {
  assert.equal(await makeProvider({ 'GET /repository/files/': { text: 'content' } }).getFileContent('a.js', 'ref'), 'content');
});
test('getFileContent: returns null on 404', async () => {
  assert.equal(await makeProvider({ 'GET /repository/files/': { status: 404 } }).getFileContent('x.js', 'ref'), null);
});

// -- listThreads / _buildThreads ---------------------------------------------

test('listThreads: maps discussions to ReviewThread objects', async () => {
  const p = makeProvider({
    'GET /merge_requests/10/discussions': {
      json: [
        { id: 'd1', notes: [{
          id: 'n1', type: 'DiffNote', body: 'issue\n<!-- ai-review:v1:active -->\n<!-- ai-review:fingerprint=abc123 -->',
          position: { new_path: 'x.js', new_line: 5 }, author: { username: 'project_1_bot', bot: true },
          created_at: '2026-01-01', resolved: false,
        }] },
        { id: 'd2', notes: [] },
        { id: 'd3', notes: [{ id: 'n3', type: 'Note', body: 'comment', author: { username: 'alice' } }] },
      ], headers: { 'x-next-page': null },
    },
  });
  const t = await p.listThreads();
  assert.equal(t.length, 1);
  assert.equal(t[0].id, 'd1');
  assert.equal(t[0].filePath, 'x.js');
  assert.equal(t[0].line, 5);
  assert.equal(t[0].status, 'active');
  assert.equal(t[0].comments[0].isBot, true);
});
test('listThreadsForPR: delegates to _buildThreads with explicit iid', async () => {
  const p = makeProvider({
    'GET /merge_requests/99/discussions': {
      json: [{ id: 'd5', notes: [{
        id: 'n5', type: 'DiffNote', body: 'note', position: { new_path: 'f.js', new_line: 1 },
        author: { username: 'alice' }, created_at: '2026-01-01', resolved: true,
      }] }], headers: { 'x-next-page': null },
    },
  });
  const t = await p.listThreadsForPR('99');
  assert.equal(t.length, 1);
  assert.equal(t[0].status, 'resolved');
});

// -- postThread --------------------------------------------------------------

test('postThread: sends correct position with diff_refs', async () => {
  const calls = [];
  const dr = { base_sha: 'b', head_sha: 'h', start_sha: 's' };
  const p = makeProvider({
    'GET /merge_requests/10': { json: { iid: 10, diff_refs: dr } },
    'POST /discussions': { json: { id: 'disc-1' } },
  }, calls);
  const res = await p.postThread({ filePath: 'a.js', line: 7, body: 'fix', status: 'active', ruleId: 'no-var' });
  assert.equal(res.id, 'disc-1');
  const body = JSON.parse(calls.find((c) => c.method === 'POST' && c.url.includes('/discussions')).body);
  assert.equal(body.position.base_sha, 'b');
  assert.equal(body.position.head_sha, 'h');
  assert.equal(body.position.start_sha, 's');
  assert.equal(body.position.new_path, 'a.js');
  assert.equal(body.position.new_line, 7);
});

// -- replyToThread -----------------------------------------------------------

test('replyToThread: posts note to discussion', async () => {
  const r = await makeProvider({ 'POST /discussions/d1/notes': { json: { id: 'r1' } } }).replyToThread('d1', 'ok');
  assert.equal(r.id, 'r1');
});

// -- patchThreadStatus -------------------------------------------------------

test('patchThreadStatus: active unresolves', async () => {
  const calls = [];
  const p = makeProvider({ 'POST /discussions/d1/notes': { json: { id: 'r1' } }, 'PUT /discussions/d1': { json: {} } }, calls);
  await p.patchThreadStatus('d1', 'active');
  const put = calls.find((c) => c.method === 'PUT');
  assert.deepEqual(JSON.parse(put.body), { resolved: false });
});
test('patchThreadStatus: fixed resolves', async () => {
  const calls = [];
  const p = makeProvider({ 'POST /discussions/d1/notes': { json: { id: 'r1' } }, 'PUT /discussions/d1': { json: {} } }, calls);
  await p.patchThreadStatus('d1', 'fixed');
  assert.deepEqual(JSON.parse(calls.find((c) => c.method === 'PUT').body), { resolved: true });
});
test('patchThreadStatus: 403 on resolve is soft-skipped', async () => {
  const p = makeProvider({ 'POST /discussions/d1/notes': { json: { id: 'r1' } }, 'PUT /discussions/d1': { status: 403 } });
  await p.patchThreadStatus('d1', 'fixed'); // should not throw
});
test('patchThreadStatus: skipMarkerReply omits reply', async () => {
  const calls = [];
  await makeProvider({ 'PUT /discussions/d1': { json: {} } }, calls).patchThreadStatus('d1', 'fixed', { skipMarkerReply: true });
  assert.ok(!calls.some((c) => c.method === 'POST'));
  assert.ok(calls.some((c) => c.method === 'PUT'));
});

// -- upsertSummaryComment ----------------------------------------------------

test('upsertSummaryComment: creates new when no existing', async () => {
  const p = makeProvider({
    'GET /merge_requests/10/notes': { json: [], headers: { 'x-next-page': null } },
    'POST /merge_requests/10/notes': { json: { id: 'n1' } },
  });
  const r = await p.upsertSummaryComment('summary', 'body');
  assert.equal(r.action, 'created');
  assert.equal(r.id, 'n1');
});
test('upsertSummaryComment: updates existing bot note', async () => {
  const p = makeProvider({
    'GET /merge_requests/10/notes': {
      json: [{ id: 'old', body: '<!-- ai-review:v1:summary -->', author: { bot: true } }],
      headers: { 'x-next-page': null },
    },
    'PUT /notes/old': { json: { id: 'old' } },
  });
  const r = await p.upsertSummaryComment('summary', 'updated');
  assert.equal(r.action, 'updated');
  assert.equal(r.id, 'old');
});
test('upsertSummaryComment: falls back to create on update 404', async () => {
  const p = makeProvider({
    'GET /merge_requests/10/notes': {
      json: [{ id: 'gone', body: '<!-- ai-review:v1:summary -->', author: { bot: true } }],
      headers: { 'x-next-page': null },
    },
    'PUT /notes/gone': { status: 404 },
    'POST /merge_requests/10/notes': { json: { id: 'new' } },
  });
  const r = await p.upsertSummaryComment('summary', 'body');
  assert.equal(r.action, 'created');
  assert.equal(r.id, 'new');
});

// -- listMergedPRs -----------------------------------------------------------

test('listMergedPRs: correct query params and mapping', async () => {
  const calls = [];
  const p = makeProvider({
    'GET /merge_requests': {
      json: [{ iid: 20, title: 'fix', merged_at: '2026-01-15T00:00:00Z', author: { email: 'b@c.com' }, web_url: 'u' }],
      headers: { 'x-next-page': null },
    },
  }, calls);
  const mrs = await p.listMergedPRs({ sinceISO: '2026-01-01T00:00:00Z', limit: 50 });
  assert.equal(mrs.length, 1);
  assert.equal(mrs[0].id, '20');
  assert.ok(calls[0].url.includes('state=merged'));
  assert.ok(calls[0].url.includes('merged_after='));
});

// -- getDefaultBranch --------------------------------------------------------

test('getDefaultBranch: fetches and caches', async () => {
  let n = 0;
  const p = providerWithFetch(async () => {
    n++;
    return { ok: true, status: 200, json: async () => ({ default_branch: 'develop' }), text: async () => '', headers: { get: () => null } };
  });
  assert.equal(await p.getDefaultBranch(), 'develop');
  assert.equal(await p.getDefaultBranch(), 'develop');
  assert.equal(n, 1);
});

// -- proposeStandardsChange --------------------------------------------------

test('proposeStandardsChange: creates branch, file, and MR', async () => {
  const calls = [];
  const p = makeProvider({
    'POST /repository/branches': { json: {} },
    'PUT /repository/files/': { json: {} },
    'POST /merge_requests': { json: { web_url: 'https://gl/mr/99' } },
  }, calls);
  const r = await p.proposeStandardsChange({ branch: 'b', filePath: './s.md', newContent: '#', baseBranch: 'main', title: 't', body: 'b' });
  assert.equal(r.url, 'https://gl/mr/99');
  assert.ok(calls.some((c) => c.method === 'POST' && c.url.includes('/branches')));
});
test('proposeStandardsChange: branch 400 is idempotent', async () => {
  const p = makeProvider({ 'POST /repository/branches': { status: 400 }, 'PUT /repository/files/': { json: {} }, 'POST /merge_requests': { json: { web_url: 'u' } } });
  assert.equal((await p.proposeStandardsChange({ branch: 'b', filePath: 'f', newContent: 'c', baseBranch: 'main', title: 't', body: 'b' })).url, 'u');
});
test('proposeStandardsChange: file update 404 falls back to create', async () => {
  const calls = [];
  const p = makeProvider({ 'POST /repository/branches': { json: {} }, 'PUT /repository/files/': { status: 404 },
    'POST /repository/files/': { json: {} }, 'POST /merge_requests': { json: { web_url: 'u' } } }, calls);
  assert.equal((await p.proposeStandardsChange({ branch: 'b', filePath: 'f', newContent: 'c', baseBranch: 'main', title: 't', body: 'b' })).url, 'u');
  assert.ok(calls.some((c) => c.method === 'POST' && c.url.includes('/repository/files/')));
});
test('proposeStandardsChange: MR 409 reuses existing', async () => {
  const p = makeProvider({ 'POST /repository/branches': { json: {} }, 'PUT /repository/files/': { json: {} },
    'POST /merge_requests': { status: 409 }, 'GET /merge_requests': { json: [{ web_url: 'u' }], headers: { 'x-next-page': null } } });
  assert.equal((await p.proposeStandardsChange({ branch: 'b', filePath: 'f', newContent: 'c', baseBranch: 'main', title: 't', body: 'b' })).url, 'u');
});
