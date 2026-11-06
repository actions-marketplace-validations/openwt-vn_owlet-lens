// @ts-check
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AzureDevOpsReviewProvider, __test__ } = require('../../lib/providers/azure-devops.js');
const { AuthError, ProviderError, RateLimitError } = require('../../lib/errors.js');

const { isBotComment, identityKeys, toAzureStatus, fromAzureStatus, mapChangeType } = __test__;

const BASE_ENV = {
  AZURE_DEVOPS_TOKEN: 'test-pat',
  SYSTEM_COLLECTIONURI: 'https://dev.azure.com/myorg',
  SYSTEM_TEAMPROJECT: 'MyProject',
  BUILD_REPOSITORY_ID: 'repo-guid',
  SYSTEM_PULLREQUEST_PULLREQUESTID: '42',
};

/**
 * Build a fake fetch from a route table. Keys are `METHOD path-substring`.
 * @param {Record<string, any>} routes
 * @param {any[]} [calls]
 */
function fakeFetch(routes, calls = []) {
  return async (url, init = {}) => {
    const method = (init.method || 'GET').toUpperCase();
    calls.push({ method, url, body: init.body ? JSON.parse(init.body) : undefined });
    let best = null;
    for (const [key, handler] of Object.entries(routes)) {
      const [m, ...fragParts] = key.split(' ');
      const frag = fragParts.join(' ');
      if (m === method && url.includes(frag) && (best === null || frag.length > best.frag.length)) {
        best = { frag, handler };
      }
    }
    if (best) {
      const r = typeof best.handler === 'function' ? best.handler(url, init) : best.handler;
      const status = r.status ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => r.json ?? {},
        text: async () => r.text ?? '',
        headers: { get: (h) => (r.headers ?? {})[h] ?? null },
      };
    }
    throw new Error(`fakeFetch: no route for ${method} ${url}`);
  };
}

/** @param {Record<string, any>} routes @param {any[]} [calls] */
function makeProvider(routes, calls) {
  return new AzureDevOpsReviewProvider({
    config: { auth: { azureToken: 'test-pat' }, markers: { prefix: 'ai-review' } },
    env: BASE_ENV,
    deps: { fetch: fakeFetch(routes, calls), sleep: async () => {} },
  });
}

// --- Helper functions ---

test('mapChangeType: maps known types', () => {
  assert.equal(mapChangeType('add'), 'add');
  assert.equal(mapChangeType('delete'), 'delete');
  assert.equal(mapChangeType('rename'), 'rename');
  assert.equal(mapChangeType('edit'), 'modify');
  assert.equal(mapChangeType(null), 'modify');
});

test('toAzureStatus: maps canonical to Azure native', () => {
  assert.equal(toAzureStatus('wontfix'), 'wontFix');
  assert.equal(toAzureStatus('resolved'), 'fixed');
  assert.equal(toAzureStatus('active'), 'active');
  assert.equal(toAzureStatus('fixed'), 'fixed');
  assert.equal(toAzureStatus('closed'), 'closed');
  assert.equal(toAzureStatus('unknown'), 'active');
});

test('fromAzureStatus: maps Azure native to canonical', () => {
  assert.equal(fromAzureStatus('wontFix'), 'wontfix');
  assert.equal(fromAzureStatus('byDesign'), 'wontfix');
  assert.equal(fromAzureStatus('active'), 'active');
  assert.equal(fromAzureStatus('fixed'), 'fixed');
  assert.equal(fromAzureStatus('closed'), 'closed');
  assert.equal(fromAzureStatus(null), 'active');
  assert.equal(fromAzureStatus('pending'), 'active');
});

test('isBotComment: detects svc. descriptor', () => {
  assert.equal(isBotComment({ author: { descriptor: 'svc.abc' }, content: '' }), true);
});

test('isBotComment: detects isContainer', () => {
  assert.equal(isBotComment({ author: { isContainer: true }, content: '' }), true);
});

test('isBotComment: matches author identity against selfKeys', () => {
  const selfKeys = new Set(['id:bot-guid', 'd:aad.bot']);
  assert.equal(isBotComment({ author: { id: 'bot-guid' }, content: 'finding' }, selfKeys), true);
  assert.equal(isBotComment({ author: { descriptor: 'aad.bot' }, content: 'finding' }, selfKeys), true);
});

test('isBotComment: a human quoting the marker is not the bot', () => {
  const selfKeys = new Set(['id:bot-guid']);
  assert.equal(
    isBotComment({ author: { descriptor: 'aad.alice' }, content: '> <!-- ai-review:v1:active -->' }, selfKeys),
    false,
  );
});

test('identityKeys: GUID ids are case-insensitive, descriptors are case-exact', () => {
  assert.deepEqual(identityKeys({ id: 'BOT-GUID', descriptor: 'aad.Bot' }), ['id:bot-guid', 'd:aad.Bot']);
  // Recorded uppercase, matched lowercase (and vice versa) — Azure GUID casing varies by endpoint.
  assert.equal(
    isBotComment({ author: { id: 'bot-guid' }, content: '' }, new Set(identityKeys({ id: 'BOT-GUID' }))),
    true,
  );
});

test('isBotComment: falls back to the marker prefix only when identity is unknown', () => {
  const quoted = { descriptor: 'aad.alice' };
  // Identity unknown (empty selfKeys): degrade to the configured marker prefix.
  assert.equal(
    isBotComment({ author: quoted, content: '> <!-- acme-review:v1:active -->' }, new Set(), 'acme-review'),
    true,
  );
  // Identity known but the author is foreign: a quoted marker must NOT match.
  assert.equal(
    isBotComment({ author: quoted, content: '> <!-- acme-review:v1:active -->' }, new Set(['id:bot']), 'acme-review'),
    false,
  );
  // No prefix configured: fail closed even with an unknown identity.
  assert.equal(isBotComment({ author: {}, content: '<!-- ai-review:v1:active -->' }, new Set()), false);
  assert.equal(isBotComment({ author: { descriptor: 'usr.bob' }, content: 'looks good' }, new Set(), 'ai-review'), false);
});

// --- Constructor ---

test('constructor: throws AuthError when token missing', () => {
  assert.throws(
    () => new AzureDevOpsReviewProvider({ config: {}, env: {}, deps: { fetch: async () => ({}) } }),
    AuthError,
  );
});

test('constructor: resolves SYSTEM_ACCESSTOKEN and sets bearer tokenType', () => {
  const env = { ...BASE_ENV };
  delete env.AZURE_DEVOPS_TOKEN;
  env.SYSTEM_ACCESSTOKEN = 'sys-tok';
  const p = new AzureDevOpsReviewProvider({
    config: {},
    env,
    deps: { fetch: async () => ({}) },
  });
  assert.equal(p.token, 'sys-tok');
  assert.equal(p.tokenType, 'bearer');
});

// --- run identity (ADR-0012) ---

test('run identity: BUILD_BUILDID and SYSTEM_TEAMPROJECT/BUILD_REPOSITORY_NAME', () => {
  const p = new AzureDevOpsReviewProvider({
    config: { auth: { azureToken: 't' } },
    env: { ...BASE_ENV, BUILD_BUILDID: '77', BUILD_REPOSITORY_NAME: 'my-repo' },
    deps: { fetch: async () => ({}) },
  });
  assert.equal(p.runId, '77');
  assert.equal(p.repoSlug, 'MyProject/my-repo');
});

test('run identity: null outside CI', () => {
  const p = new AzureDevOpsReviewProvider({
    config: { auth: { azureToken: 't' } },
    env: { ...BASE_ENV },
    deps: { fetch: async () => ({}) },
  });
  assert.equal(p.runId, null);
  assert.equal(p.repoSlug, null);
});

test('constructor: throws ProviderError when orgUrl missing', () => {
  assert.throws(
    () => new AzureDevOpsReviewProvider({
      config: { auth: { azureToken: 't' } },
      env: { AZURE_DEVOPS_TOKEN: 't', SYSTEM_TEAMPROJECT: 'p', BUILD_REPOSITORY_ID: 'r', SYSTEM_PULLREQUEST_PULLREQUESTID: '1' },
      deps: { fetch: async () => ({}) },
    }),
    ProviderError,
  );
});

test('constructor: resolves orgUrl from AZURE_DEVOPS_ORG_URL when SYSTEM_COLLECTIONURI is absent', () => {
  const p = new AzureDevOpsReviewProvider({
    config: { auth: { azureToken: 't' } },
    env: {
      AZURE_DEVOPS_TOKEN: 't',
      AZURE_DEVOPS_ORG_URL: 'https://dev.azure.com/org/',
      SYSTEM_TEAMPROJECT: 'p',
      BUILD_REPOSITORY_ID: 'r',
      SYSTEM_PULLREQUEST_PULLREQUESTID: '1',
    },
    deps: { fetch: async () => ({}) },
  });
  assert.equal(p.orgUrl, 'https://dev.azure.com/org');
});

test('constructor: azure.orgUrl wins over AZURE_DEVOPS_ORG_URL and SYSTEM_COLLECTIONURI', () => {
  const p = new AzureDevOpsReviewProvider({
    config: { auth: { azureToken: 't' }, azure: { orgUrl: 'https://dev.azure.com/from-config' } },
    env: {
      AZURE_DEVOPS_TOKEN: 't',
      AZURE_DEVOPS_ORG_URL: 'https://dev.azure.com/from-env',
      SYSTEM_COLLECTIONURI: 'https://dev.azure.com/from-ci',
      SYSTEM_TEAMPROJECT: 'p',
      BUILD_REPOSITORY_ID: 'r',
      SYSTEM_PULLREQUEST_PULLREQUESTID: '1',
    },
    deps: { fetch: async () => ({}) },
  });
  assert.equal(p.orgUrl, 'https://dev.azure.com/from-config');
});

test('constructor: throws ProviderError when project missing', () => {
  assert.throws(
    () => new AzureDevOpsReviewProvider({
      config: { auth: { azureToken: 't' } },
      env: { AZURE_DEVOPS_TOKEN: 't', SYSTEM_COLLECTIONURI: 'https://dev.azure.com/org', BUILD_REPOSITORY_ID: 'r', SYSTEM_PULLREQUEST_PULLREQUESTID: '1' },
      deps: { fetch: async () => ({}) },
    }),
    ProviderError,
  );
});

test('constructor: throws ProviderError when PR id missing (requirePr default)', () => {
  assert.throws(
    () => new AzureDevOpsReviewProvider({
      config: { auth: { azureToken: 't' } },
      env: { AZURE_DEVOPS_TOKEN: 't', SYSTEM_COLLECTIONURI: 'https://dev.azure.com/org', SYSTEM_TEAMPROJECT: 'p', BUILD_REPOSITORY_ID: 'r' },
      deps: { fetch: async () => ({}) },
    }),
    ProviderError,
  );
});

test('constructor: requirePr=false skips PR id check', () => {
  const p = new AzureDevOpsReviewProvider({
    config: { auth: { azureToken: 't' } },
    env: { AZURE_DEVOPS_TOKEN: 't', SYSTEM_COLLECTIONURI: 'https://dev.azure.com/org', SYSTEM_TEAMPROJECT: 'p', BUILD_REPOSITORY_ID: 'r' },
    requirePr: false,
    deps: { fetch: async () => ({}) },
  });
  assert.equal(p.prId, null);
});

// --- _authHeader ---

test('_authHeader: PAT uses Basic with empty username', () => {
  const p = makeProvider({});
  assert.match(p._authHeader(), /^Basic /);
  const decoded = Buffer.from(p._authHeader().replace('Basic ', ''), 'base64').toString();
  assert.equal(decoded, ':test-pat');
});

test('_authHeader: bearer uses Bearer prefix', () => {
  const p = new AzureDevOpsReviewProvider({
    config: { auth: { azureToken: 'tok' }, azure: { tokenType: 'bearer' } },
    env: BASE_ENV,
    deps: { fetch: async () => ({}) },
  });
  assert.equal(p._authHeader(), 'Bearer tok');
});

// --- _api error handling ---

test('_api: 203 throws AuthError', async () => {
  const p = makeProvider({ 'GET /test': { status: 203, text: 'Sign in page' } });
  await assert.rejects(() => p._api('GET', 'https://x/test'), AuthError);
});

test('_api: 401 throws AuthError', async () => {
  const p = makeProvider({ 'GET /test': { status: 401 } });
  await assert.rejects(() => p._api('GET', 'https://x/test'), AuthError);
});

test('_api: 403 throws AuthError', async () => {
  const p = makeProvider({ 'GET /test': { status: 403, text: 'Forbidden' } });
  await assert.rejects(() => p._api('GET', 'https://x/test'), AuthError);
});

test('_api: 429 throws RateLimitError with Retry-After', async () => {
  const p = makeProvider({ 'GET /test': { status: 429, headers: { 'retry-after': '5' } } });
  await assert.rejects(() => p._api('GET', 'https://x/test'), (err) => {
    assert.ok(err instanceof RateLimitError);
    assert.equal(err.retryAfterMs, 5000);
    return true;
  });
});

test('_api: 500 throws ProviderError with retryable=true', async () => {
  const p = makeProvider({ 'GET /test': { status: 500, text: 'Internal' } });
  await assert.rejects(() => p._api('GET', 'https://x/test'), (err) => {
    assert.ok(err instanceof ProviderError);
    assert.equal(err.retryable, true);
    return true;
  });
});

test('_api: 204 returns null', async () => {
  const p = makeProvider({ 'DELETE /test': { status: 204 } });
  const result = await p._api('DELETE', 'https://x/test');
  assert.equal(result, null);
});

test('_api: success returns json by default', async () => {
  const p = makeProvider({ 'GET /test': { json: { ok: true } } });
  const result = await p._api('GET', 'https://x/test');
  assert.deepEqual(result, { ok: true });
});

test('_api: raw=true returns text', async () => {
  const p = makeProvider({ 'GET /test': { text: 'file content' } });
  const result = await p._api('GET', 'https://x/test', { raw: true });
  assert.equal(result, 'file content');
});

// --- _paginate ---

test('_paginate: collects pages and stops on short page', async () => {
  let callCount = 0;
  const p = makeProvider({
    'GET /items': (url) => {
      callCount++;
      // Return fewer than PAGE_SIZE on first call to trigger stop
      return { json: { value: [{ id: callCount }] } };
    },
  });
  const result = await p._paginate('/items');
  assert.equal(result.length, 1);
  assert.equal(callCount, 1);
});

// --- getPRMetadata ---

test('getPRMetadata: parses PR response and strips refs/heads/', async () => {
  const p = makeProvider({
    'GET /pullRequests/42': {
      json: {
        pullRequestId: 42,
        sourceRefName: 'refs/heads/feature',
        targetRefName: 'refs/heads/main',
        lastMergeSourceCommit: { commitId: 'src-sha' },
        lastMergeTargetCommit: { commitId: 'tgt-sha' },
        title: 'My PR',
        description: 'Why',
        createdBy: { uniqueName: 'alice@example.com' },
      },
    },
  });
  const meta = await p.getPRMetadata();
  assert.equal(meta.description, 'Why');
  assert.equal(meta.id, '42');
  assert.equal(meta.sourceBranch, 'feature');
  assert.equal(meta.targetBranch, 'main');
  assert.equal(meta.sourceSha, 'src-sha');
  assert.equal(meta.title, 'My PR');
  assert.equal(meta.authorEmail, 'alice@example.com');
});

// Per-request retry (ADR-0013): a GET repeats, a create (POST) does not.
test('_api: retries a GET after a 5xx and returns the success', async () => {
  const calls = [];
  const p = makeProvider({ 'GET /test': () => (calls.length === 1 ? { status: 503 } : { json: { ok: 1 } }) }, calls);
  assert.deepEqual(await p._api('GET', 'https://dev.azure.com/myorg/test'), { ok: 1 });
  assert.equal(calls.length, 2);
});

test('postThread: does not repeat the POST after a 5xx: Azure DevOps may have applied it', async () => {
  const calls = [];
  const p = makeProvider({ 'POST /pullRequests/42/threads': { status: 503 } }, calls);
  await assert.rejects(() => p.postThread({ filePath: 'src/a.js', line: 1, body: 'finding', status: 'active' }), ProviderError);
  assert.equal(calls.length, 1);
});

// --- getDiff ---

test('getDiff: synthesises patches, skips folders and handles delete', async () => {
  const p = makeProvider({
    'GET /pullRequests/42/iterations': { json: { value: [{ id: 1 }] } },
    'GET /pullRequests/42/iterations/1/changes': {
      json: {
        changeEntries: [
          { item: { path: '/src/app.js', isFolder: false }, changeType: 'edit' },
          { item: { path: '/src/', isFolder: true }, changeType: 'edit' },
          { item: { path: '/old.js', isFolder: false }, changeType: 'delete' },
        ],
      },
    },
    'GET /pullRequests/42': {
      json: {
        pullRequestId: 42, sourceRefName: 'refs/heads/f', targetRefName: 'refs/heads/m',
        lastMergeSourceCommit: { commitId: 'sha1' }, lastMergeTargetCommit: { commitId: 'sha2' },
        title: '', createdBy: {},
      },
    },
    'GET /items': { text: 'line1\nline2' },
  });
  const diffs = await p.getDiff();
  assert.equal(diffs.length, 2);
  assert.equal(diffs[0].path, 'src/app.js');
  assert.match(diffs[0].patch, /\+line1/);
  assert.equal(diffs[1].path, 'old.js');
  assert.equal(diffs[1].change, 'delete');
  assert.equal(diffs[1].patch, '');
});

/** A PR with one edited file, src/app.js, whose content fetch answers `items`. */
function oneEditedFile(items) {
  return makeProvider({
    'GET /pullRequests/42/iterations': { json: { value: [{ id: 1 }] } },
    'GET /pullRequests/42/iterations/1/changes': {
      json: { changeEntries: [{ item: { path: '/src/app.js', isFolder: false }, changeType: 'edit' }] },
    },
    'GET /pullRequests/42': {
      json: {
        pullRequestId: 42, sourceRefName: 'refs/heads/f', targetRefName: 'refs/heads/m',
        lastMergeSourceCommit: { commitId: 'sha1' }, lastMergeTargetCommit: { commitId: 'sha2' },
        title: '', createdBy: {},
      },
    },
    'GET /items': items,
  });
}

test('getDiff: a file-content fetch that keeps failing fails the run instead of hiding the file', async () => {
  const p = oneEditedFile({ status: 503, text: 'unavailable' });
  await assert.rejects(() => p.getDiff(), (e) => e instanceof ProviderError && e.status === 503);
});

test('getDiff: a file with no content at the source commit (404) gets an empty patch', async () => {
  const p = oneEditedFile({ status: 404, text: 'Not found' });
  assert.deepEqual(await p.getDiff(), [{ path: 'src/app.js', change: 'modify', patch: '' }]);
});

// --- getFileContent ---

test('getFileContent: returns content on success', async () => {
  const p = makeProvider({ 'GET /items': { text: 'hello world' } });
  const content = await p.getFileContent('src/file.js', 'abc123');
  assert.equal(content, 'hello world');
});

test('getFileContent: returns null on 404', async () => {
  const p = makeProvider({ 'GET /items': { status: 404, text: 'Not found' } });
  const content = await p.getFileContent('missing.js', 'abc123');
  assert.equal(content, null);
});

// --- listThreads / _mapThreads ---

test('listThreads: maps Azure threads to ReviewThread shape', async () => {
  const p = makeProvider({
    'GET /_apis/connectionData': { json: { authenticatedUser: { id: 'bot-guid', descriptor: 'aad.bot' } } },
    'GET /pullRequests/42/threads': {
      json: {
        value: [
          {
            id: 100, isDeleted: false, status: 'active',
            threadContext: { filePath: '/src/app.js', rightFileStart: { line: 10 } },
            comments: [
              { id: 1, isDeleted: false, author: { id: 'bot-guid', uniqueName: 'bot@ci' }, content: 'Issue found <!-- ai-review:v1:active --><!-- ai-review:fingerprint=abcd1234abcd1234 -->', publishedDate: '2026-01-01' },
              { id: 2, isDeleted: false, author: { descriptor: 'aad.alice', uniqueName: 'alice@example.com' }, content: '> <!-- ai-review:v1:active -->', publishedDate: '2026-01-02' },
            ],
          },
          { id: 101, isDeleted: true, status: 'active', comments: [] },
        ],
      },
    },
  });
  const threads = await p.listThreads();
  assert.equal(threads.length, 1);
  assert.equal(threads[0].id, '100');
  assert.equal(threads[0].filePath, 'src/app.js');
  assert.equal(threads[0].line, 10);
  assert.equal(threads[0].status, 'active');
  assert.equal(threads[0].marker.fingerprint, 'abcd1234abcd1234');
  assert.equal(threads[0].comments[0].isBot, true);
  // A human reply quoting the marker must not be treated as the bot's.
  assert.equal(threads[0].comments[1].isBot, false);
});

test('listThreads: learns the bot identity from a write response when connectionData fails', async () => {
  const p = makeProvider({
    'GET /_apis/connectionData': { status: 404, text: 'Not found' },
    'POST /pullRequests/42/threads': { json: { id: 1, comments: [{ author: { id: 'rotated-bot' } }] } },
    'GET /pullRequests/42/threads': {
      json: {
        value: [{
          id: 7, isDeleted: false, status: 'active',
          comments: [{ id: 1, isDeleted: false, author: { id: 'rotated-bot' }, content: 'legacy finding with no marker' }],
        }],
      },
    },
  });
  await p.postThread({ filePath: 'src/a.js', line: 1, body: 'finding', status: 'active' });
  const threads = await p.listThreads();
  // Content has no marker, so this can only be true via the learned identity.
  assert.equal(threads[0].comments[0].isBot, true);
});

test('_ensureSelfIdentity: retries a transient connectionData failure', async () => {
  let calls = 0;
  const p = makeProvider({
    'GET /_apis/connectionData': () => {
      calls += 1;
      return calls === 1 ? { status: 503, text: 'boom' } : { json: { authenticatedUser: { id: 'BOT-GUID' } } };
    },
    'GET /pullRequests/42/threads': {
      json: {
        value: [{
          id: 9, isDeleted: false, status: 'active',
          comments: [{ id: 1, isDeleted: false, author: { id: 'bot-guid' }, content: 'legacy finding with no marker' }],
        }],
      },
    },
  });
  const threads = await p.listThreads();
  assert.equal(calls, 2); // one 503, one success
  assert.equal(threads[0].comments[0].isBot, true); // identity resolved despite the blip
});

test('upsertSummaryComment: marker fallback finds a legacy summary when connectionData fails', async () => {
  const p = new AzureDevOpsReviewProvider({
    config: { auth: { azureToken: 'test-pat' }, markers: { prefix: 'acme-review' } },
    env: BASE_ENV,
    deps: {
      fetch: fakeFetch({
        'GET /_apis/connectionData': { status: 404, text: 'Not found' },
        'GET /pullRequests/42/threads': {
          json: {
            value: [{
              id: 501, threadContext: null,
              comments: [{ id: 11, isDeleted: false, content: '<!-- acme-review:v1:summary -->', author: { id: 'legacy-bot' } }],
            }],
          },
        },
        'PATCH /comments/11': { json: {} },
      }),
    },
  });
  const res = await p.upsertSummaryComment('summary', 'Report body');
  assert.equal(res.action, 'updated');
  assert.equal(res.id, '501');
});

test('_mapThreads: skips threads with no non-deleted comments', () => {
  const p = makeProvider({});
  const result = p._mapThreads([
    { id: 1, isDeleted: false, comments: [{ id: 1, isDeleted: true }] },
  ]);
  assert.equal(result.length, 0);
});

// --- postThread ---

test('postThread: sends correct payload with threadContext', async () => {
  const calls = [];
  const p = makeProvider({
    'POST /pullRequests/42/threads': { json: { id: 200 } },
  }, calls);
  const res = await p.postThread({ filePath: 'src/index.js', line: 5, body: 'Bug here', status: 'active', ruleId: 'no-unused' });
  assert.equal(res.id, '200');
  const postCall = calls.find((c) => c.method === 'POST');
  assert.ok(postCall);
  assert.equal(postCall.body.threadContext.filePath, '/src/index.js');
  assert.equal(postCall.body.threadContext.rightFileStart.line, 5);
});

// --- replyToThread ---

test('replyToThread: posts comment to thread', async () => {
  const calls = [];
  const p = makeProvider({
    'POST /threads/100/comments': { json: { id: 301 } },
  }, calls);
  const res = await p.replyToThread('100', 'Acknowledged');
  assert.equal(res.id, '301');
});

// --- patchThreadStatus ---

test('patchThreadStatus: sends marker reply + PATCH', async () => {
  const calls = [];
  const p = makeProvider({
    'POST /threads/100/comments': { json: { id: 302 } },
    'PATCH /threads/100': { json: {} },
  }, calls);
  await p.patchThreadStatus('100', 'fixed');
  const patchCall = calls.find((c) => c.method === 'PATCH');
  assert.ok(patchCall);
  assert.equal(patchCall.body.status, 'fixed');
});

test('patchThreadStatus: 403 on PATCH is soft-skipped', async () => {
  const p = makeProvider({
    'POST /threads/100/comments': { json: { id: 302 } },
    'PATCH /threads/100': { status: 403, text: 'Forbidden' },
  });
  // Should NOT throw because 401/403 on statusPatch is soft-handled
  await p.patchThreadStatus('100', 'fixed');
});

test('patchThreadStatus: skipMarkerReply=true skips reply step', async () => {
  const calls = [];
  const p = makeProvider({
    'PATCH /threads/100': { json: {} },
  }, calls);
  await p.patchThreadStatus('100', 'fixed', { skipMarkerReply: true });
  assert.ok(!calls.some((c) => c.method === 'POST'));
});

// --- upsertSummaryComment ---

test('upsertSummaryComment: creates new when none exists', async () => {
  const calls = [];
  const p = makeProvider({
    'GET /_apis/connectionData': { json: { authenticatedUser: { id: 'bot-guid' } } },
    'GET /pullRequests/42/threads': { json: { value: [] } },
    'POST /pullRequests/42/threads': { json: { id: 400, comments: [{ author: { id: 'bot-guid' } }] } },
  }, calls);
  const res = await p.upsertSummaryComment('summary', 'Report body');
  assert.equal(res.action, 'created');
  assert.equal(res.id, '400');
});

test('upsertSummaryComment: updates existing bot summary', async () => {
  const calls = [];
  const p = makeProvider({
    'GET /_apis/connectionData': { json: { authenticatedUser: { id: 'bot-guid' } } },
    'GET /pullRequests/42/threads': {
      json: {
        value: [{
          id: 500, threadContext: null,
          comments: [{ id: 10, isDeleted: false, content: '<!-- ai-review:v1:summary -->', author: { id: 'bot-guid' } }],
        }],
      },
    },
    'PATCH /comments/10': { json: {} },
  }, calls);
  const res = await p.upsertSummaryComment('summary', 'Updated report');
  assert.equal(res.action, 'updated');
  assert.equal(res.id, '500');
});

// --- listMergedPRs ---

test('listMergedPRs: passes correct searchCriteria', async () => {
  const calls = [];
  const p = new AzureDevOpsReviewProvider({
    config: { auth: { azureToken: 'tok' } },
    env: BASE_ENV,
    requirePr: false,
    deps: { fetch: fakeFetch({ 'GET /pullRequests': { json: { value: [{ pullRequestId: 10, title: 'Merged PR', closedDate: '2026-01-01', createdBy: { uniqueName: 'bob' } }] } } }, calls) },
  });
  const prs = await p.listMergedPRs({ sinceISO: '2026-01-01T00:00:00Z' });
  assert.equal(prs.length, 1);
  assert.equal(prs[0].id, '10');
  const getCall = calls.find((c) => c.method === 'GET');
  assert.ok(getCall.url.includes('searchCriteria.status=completed'));
});

// --- proposeStandardsChange ---

test('proposeStandardsChange: pushes and creates PR', async () => {
  const calls = [];
  const p = new AzureDevOpsReviewProvider({
    config: { auth: { azureToken: 'tok' } },
    env: BASE_ENV,
    requirePr: false,
    deps: {
      fetch: fakeFetch({
        'GET /refs': { json: { value: [{ objectId: 'base-oid' }] } },
        'GET /items': { text: 'existing content' },
        'POST /pushes': { json: { pushId: 1 } },
        'POST /pullRequests': { json: { pullRequestId: 99, _links: { web: { href: 'https://dev.azure.com/pr/99' } } } },
      }, calls),
    },
  });
  const res = await p.proposeStandardsChange({
    branch: 'owlet-lens/learn/test', filePath: 'standards.md',
    newContent: 'new content', baseBranch: 'main', title: 'Learn', body: 'body',
  });
  assert.equal(res.url, 'https://dev.azure.com/pr/99');
});

test('proposeStandardsChange: 409 push retries with existing branch head', async () => {
  let pushCallCount = 0;
  const p = new AzureDevOpsReviewProvider({
    config: { auth: { azureToken: 'tok' } },
    env: BASE_ENV,
    requirePr: false,
    deps: {
      fetch: fakeFetch({
        'GET /refs': { json: { value: [{ objectId: 'base-oid' }] } },
        'GET /items': { status: 404, text: 'Not found' },
        'POST /pushes': (url) => {
          pushCallCount++;
          if (pushCallCount === 1) return { status: 409, text: 'Conflict' };
          return { json: { pushId: 2 } };
        },
        'POST /pullRequests': { json: { pullRequestId: 100, _links: { web: { href: 'https://dev.azure.com/pr/100' } } } },
      }),
    },
  });
  const res = await p.proposeStandardsChange({
    branch: 'owlet-lens/learn/test', filePath: './new-file.md',
    newContent: 'content', baseBranch: 'main', title: 'Title', body: 'Body',
  });
  assert.equal(res.url, 'https://dev.azure.com/pr/100');
  assert.equal(pushCallCount, 2);
});

// --- capabilities ---

test('capabilities: nativeWontFix and canProposeChanges are true', () => {
  const p = makeProvider({});
  assert.equal(p.capabilities.nativeWontFix, true);
  assert.equal(p.capabilities.canProposeChanges, true);
  assert.equal(p.capabilities.supportsFileContent, true);
});

// --- getDefaultBranch ---

test('getDefaultBranch: returns branch name stripped of refs/heads/', async () => {
  const p = makeProvider({ 'GET /repositories/': { json: { defaultBranch: 'refs/heads/develop' } } });
  const branch = await p.getDefaultBranch();
  assert.equal(branch, 'develop');
  // Second call should use cache
  const branch2 = await p.getDefaultBranch();
  assert.equal(branch2, 'develop');
});
