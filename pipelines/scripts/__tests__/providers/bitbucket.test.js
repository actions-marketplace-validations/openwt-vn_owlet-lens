// @ts-check
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { BitbucketCloudReviewProvider } = require('../../lib/providers/bitbucket.js');
const { AuthError, ProviderError, RateLimitError } = require('../../lib/errors.js');

const ENV = {
  BITBUCKET_TOKEN: 'tok',
  BITBUCKET_WORKSPACE: 'ws',
  BITBUCKET_REPO_SLUG: 'repo',
  BITBUCKET_PR_ID: '7',
};

/**
 * Build a fake fetch from a route table. Keys are `METHOD path-substring`.
 * Each handler returns { status?, json?, text? }.
 *
 * @param {Record<string, any>} routes
 * @param {any[]} [calls]
 */
function fakeFetch(routes, calls = []) {
  /** @param {string} url @param {any} [init] */
  return async (url, init = {}) => {
    const method = (init.method || 'GET').toUpperCase();
    calls.push({ method, url, body: init.body });
    // Prefer the most specific (longest-fragment) matching route so a generic
    // path like `/comments` can't shadow `/comments/100/resolve`.
    /** @type {{ frag: string, handler: any } | null} */
    let best = null;
    for (const [key, handler] of Object.entries(routes)) {
      const [m, frag] = key.split(' ');
      if (m === method && url.includes(frag) && (best === null || frag.length > best.frag.length)) {
        best = { frag, handler };
      }
    }
    if (best) {
      const r = typeof best.handler === 'function' ? best.handler(url, init) : best.handler;
      return {
        ok: (r.status ?? 200) >= 200 && (r.status ?? 200) < 300,
        status: r.status ?? 200,
        json: async () => r.json ?? {},
        text: async () => r.text ?? '',
        headers: { get: (/** @type {string} */ k) => r.headers?.[k.toLowerCase()] ?? null },
      };
    }
    throw new Error(`fakeFetch: no route for ${method} ${url}`);
  };
}

/** @param {Record<string, any>} routes @param {any[]} [calls] */
function makeProvider(routes, calls) {
  return new BitbucketCloudReviewProvider({
    config: { auth: { bitbucketToken: 'tok' }, markers: { prefix: 'ai-review' } },
    env: ENV,
    deps: { fetch: fakeFetch(routes, calls), sleep: async () => {} },
  });
}

test('constructor: throws AuthError when token missing', () => {
  assert.throws(
    () => new BitbucketCloudReviewProvider({ config: {}, env: { ...ENV, BITBUCKET_TOKEN: '' }, deps: { fetch: async () => ({}) } }),
    AuthError,
  );
});

test('constructor: throws ProviderError when workspace/repo missing', () => {
  assert.throws(
    () => new BitbucketCloudReviewProvider({ config: { auth: { bitbucketToken: 't' } }, env: { BITBUCKET_TOKEN: 't', BITBUCKET_PR_ID: '7' }, deps: { fetch: async () => ({}) } }),
    ProviderError,
  );
});

test('constructor: throws ProviderError when PR id missing', () => {
  assert.throws(
    () => new BitbucketCloudReviewProvider({ config: { auth: { bitbucketToken: 't' } }, env: { BITBUCKET_TOKEN: 't', BITBUCKET_WORKSPACE: 'ws', BITBUCKET_REPO_SLUG: 'repo' }, deps: { fetch: async () => ({}) } }),
    ProviderError,
  );
});

test('constructor: accepts BITBUCKET_REPO_FULL_NAME', () => {
  const p = new BitbucketCloudReviewProvider({
    config: { auth: { bitbucketToken: 't' } },
    env: { BITBUCKET_TOKEN: 't', BITBUCKET_REPO_FULL_NAME: 'ws/repo', BITBUCKET_PR_ID: '7' },
    deps: { fetch: async () => ({}) },
  });
  assert.equal(p.workspace, 'ws');
  assert.equal(p.repo, 'repo');
});

test('getPRMetadata: maps Bitbucket PR shape', async () => {
  const provider = makeProvider({
    'GET /pullrequests/7': {
      json: {
        id: 7,
        title: 'My PR',
        summary: { raw: 'Why', markup: 'markdown' },
        source: { branch: { name: 'feat' }, commit: { hash: 'srcsha' } },
        destination: { branch: { name: 'main' }, commit: { hash: 'dstsha' } },
        author: { nickname: 'alice', account_id: 'acc-1' },
        links: { html: { href: 'https://bitbucket.org/ws/repo/pull-requests/7' } },
      },
    },
  });
  const meta = await provider.getPRMetadata();
  assert.equal(meta.id, '7');
  assert.equal(meta.sourceBranch, 'feat');
  assert.equal(meta.targetBranch, 'main');
  assert.equal(meta.sourceSha, 'srcsha');
  assert.equal(meta.targetSha, 'dstsha');
  assert.equal(meta.title, 'My PR');
  assert.equal(meta.description, 'Why');
  assert.equal(meta.authorEmail, 'alice');
  assert.equal(meta.url, 'https://bitbucket.org/ws/repo/pull-requests/7');
});

test('getDiff: splits raw combined diff', async () => {
  const raw = [
    'diff --git a/a.js b/a.js',
    '--- a/a.js',
    '+++ b/a.js',
    '@@ -1 +1 @@',
    '-x',
    '+y',
  ].join('\n');
  const provider = makeProvider({ 'GET /pullrequests/7/diff': { text: raw } });
  const files = await provider.getDiff();
  assert.equal(files.length, 1);
  assert.equal(files[0].path, 'a.js');
  assert.equal(files[0].change, 'modify');
});

test('getFileContent: returns raw text', async () => {
  const provider = makeProvider({ 'GET /src/abc/src/a.js': { text: 'file body' } });
  const out = await provider.getFileContent('src/a.js', 'abc');
  assert.equal(out, 'file body');
});

test('getFileContent: returns null on 404', async () => {
  const provider = makeProvider({ 'GET /src/abc/missing.js': { status: 404 } });
  const out = await provider.getFileContent('missing.js', 'abc');
  assert.equal(out, null);
});

test('getFileContent: throws ProviderError on 500', async () => {
  const provider = makeProvider({ 'GET /src/abc/a.js': { status: 500, text: 'boom' } });
  await assert.rejects(() => provider.getFileContent('a.js', 'abc'), ProviderError);
});

test('capabilities: bitbucket flags', () => {
  const provider = makeProvider({});
  assert.deepEqual(provider.capabilities, {
    nativeWontFix: false,
    lineLevelThreads: true,
    threadStatusPatch: true,
    summaryComment: true,
    supportsFileContent: true,
    canProposeChanges: true,
  });
});

test('listThreads: groups replies under root and derives marker status', async () => {
  const page = {
    values: [
      {
        id: 100,
        content: { raw: 'Finding here\n`ai-review:v1:active` `ai-review:fingerprint=abcd1234`' },
        inline: { path: 'src/a.js', to: 12 },
        user: { account_id: 'bot-acc' },
        created_on: '2026-05-01T00:00:00Z',
        resolution: null,
      },
      {
        id: 101,
        parent: { id: 100 },
        content: { raw: 'dev reply' },
        user: { account_id: 'dev-acc' },
        created_on: '2026-05-01T01:00:00Z',
      },
    ],
  };
  const provider = makeProvider({ 'GET /pullrequests/7/comments': { json: page } });
  provider._selfAccountId = 'bot-acc';
  const threads = await provider.listThreads();
  assert.equal(threads.length, 1);
  const t = threads[0];
  assert.equal(t.id, '100');
  assert.equal(t.filePath, 'src/a.js');
  assert.equal(t.line, 12);
  assert.equal(t.status, 'active');
  assert.equal(t.comments.length, 2);
  assert.equal(t.comments[0].isBot, true);
  assert.equal(t.comments[1].isBot, false);
  assert.equal(t.marker.fingerprint, 'abcd1234');
});

test('listThreads: falls back to resolution when no marker', async () => {
  const page = {
    values: [
      {
        id: 200,
        content: { raw: 'plain comment, no marker' },
        inline: { path: 'x.js', to: 3 },
        user: { account_id: 'someone' },
        created_on: '2026-05-01T00:00:00Z',
        resolution: { type: 'comment_resolution' },
      },
    ],
  };
  const provider = makeProvider({ 'GET /pullrequests/7/comments': { json: page } });
  const threads = await provider.listThreads();
  assert.equal(threads[0].status, 'resolved');
  // _selfAccountId is null here → no comment is flagged as bot.
  assert.equal(threads[0].comments[0].isBot, false);
});

test('listThreads: follows next cursor for pagination', async () => {
  /** @type {any[]} */
  const calls = [];
  const provider = makeProvider({
    'GET /pullrequests/7/comments': (/** @type {string} */ url) => {
      if (url.includes('page=2')) {
        return { json: { values: [{ id: 2, content: { raw: 'b' }, inline: { path: 'p', to: 1 }, user: {}, created_on: '2026-05-01T00:00:00Z' }] } };
      }
      return {
        json: {
          values: [{ id: 1, content: { raw: 'a' }, inline: { path: 'p', to: 1 }, user: {}, created_on: '2026-05-01T00:00:00Z' }],
          next: `${provider._repoPath()}/pullrequests/7/comments?page=2`,
        },
      };
    },
  }, calls);
  const threads = await provider.listThreads();
  // Two separate root comments → two threads.
  assert.equal(threads.length, 2);
});

test('listThreads: skips deleted comments', async () => {
  const page = {
    values: [
      { id: 1, deleted: true, content: { raw: 'gone' }, user: {}, created_on: '2026-05-01T00:00:00Z' },
      { id: 2, content: { raw: 'kept' }, inline: { path: 'p', to: 1 }, user: {}, created_on: '2026-05-01T00:00:00Z' },
    ],
  };
  const provider = makeProvider({ 'GET /pullrequests/7/comments': { json: page } });
  const threads = await provider.listThreads();
  assert.equal(threads.length, 1);
  assert.equal(threads[0].id, '2');
});

/** Count GET requests against the paginated comment-list endpoint. */
const countListGets = (/** @type {any[]} */ calls) =>
  calls.filter((c) => c.method === 'GET' && /\/comments\?/.test(c.url)).length;

test('comments cache: listThreads + upsertSummaryComment paginate only once', async () => {
  /** @type {any[]} */
  const calls = [];
  const provider = makeProvider({
    'GET /pullrequests/7/comments': {
      json: { values: [{ id: 1, content: { raw: 'a' }, inline: { path: 'p', to: 1 }, user: {}, created_on: '2026-05-01T00:00:00Z' }] },
    },
    'POST /pullrequests/7/comments': { json: { id: 999 } },
  }, calls);
  await provider.listThreads();
  await provider.upsertSummaryComment('summary', 'body');
  // Second read reuses the memoized list → still a single pagination pass.
  assert.equal(countListGets(calls), 1);
});

test('comments cache: a mutating request invalidates and forces re-fetch', async () => {
  /** @type {any[]} */
  const calls = [];
  const provider = makeProvider({
    'GET /pullrequests/7/comments': {
      json: { values: [{ id: 1, content: { raw: 'a' }, inline: { path: 'p', to: 1 }, user: {}, created_on: '2026-05-01T00:00:00Z' }] },
    },
    'POST /pullrequests/7/comments': { json: { id: 222 } },
  }, calls);
  await provider.listThreads();             // GET #1, populates cache
  await provider.replyToThread('1', 'hi');  // POST → invalidates cache
  await provider.listThreads();             // GET #2, cache was dropped
  assert.equal(countListGets(calls), 2);
});

test('postThread: posts inline comment with markers and records self account', async () => {
  /** @type {any[]} */
  const calls = [];
  const provider = makeProvider({
    'POST /pullrequests/7/comments': (/** @type {string} */ url, /** @type {any} */ init) => {
      const sent = JSON.parse(init.body);
      assert.equal(sent.inline.path, 'src/a.js');
      assert.equal(sent.inline.to, 9);
      assert.match(sent.content.raw, /ai-review:v1:active/);
      return { json: { id: 555, user: { account_id: 'bot-acc' } } };
    },
  }, calls);
  provider._markerStyle = 'bitbucket'; // skip probe in this unit test
  const out = await provider.postThread({ filePath: 'src/a.js', line: 9, body: 'Issue', status: 'active', ruleId: 'r1' });
  assert.equal(out.id, '555');
  assert.equal(provider._selfAccountId, 'bot-acc');
});

test('replyToThread: posts with parent id', async () => {
  const provider = makeProvider({
    'POST /pullrequests/7/comments': (/** @type {string} */ url, /** @type {any} */ init) => {
      const sent = JSON.parse(init.body);
      assert.equal(sent.parent.id, 100);
      assert.equal(sent.content.raw, 'a reply');
      return { json: { id: 777 } };
    },
  });
  provider._markerStyle = 'bitbucket';
  const out = await provider.replyToThread('100', 'a reply');
  assert.equal(out.id, '777');
});

test('replyToThread: appends status marker when opts.status set', async () => {
  const provider = makeProvider({
    'POST /pullrequests/7/comments': (/** @type {string} */ url, /** @type {any} */ init) => {
      const sent = JSON.parse(init.body);
      assert.match(sent.content.raw, /ai-review:v1:fixed/);
      return { json: { id: 778 } };
    },
  });
  provider._markerStyle = 'bitbucket';
  await provider.replyToThread('100', 'done', { status: 'fixed', fingerprintHash: 'abcd' });
});

test('upsertSummaryComment: updates existing bot comment', async () => {
  const key = 'summary';
  const provider = makeProvider({
    'GET /pullrequests/7/comments': {
      json: {
        values: [
          { id: 9, content: { raw: `body \`ai-review:v1:summary\`` }, user: { account_id: 'bot-acc' } },
        ],
      },
    },
    'PUT /pullrequests/7/comments/9': { json: { id: 9 } },
  });
  provider._selfAccountId = 'bot-acc';
  provider._markerStyle = 'bitbucket';
  const out = await provider.upsertSummaryComment(key, 'new body');
  assert.equal(out.id, '9');
  assert.equal(out.action, 'updated');
});

test('upsertSummaryComment: creates when none exists', async () => {
  const provider = makeProvider({
    'GET /pullrequests/7/comments': { json: { values: [] } },
    'POST /pullrequests/7/comments': { json: { id: 12 } },
  });
  provider._markerStyle = 'bitbucket';
  const out = await provider.upsertSummaryComment('summary', 'fresh');
  assert.equal(out.id, '12');
  assert.equal(out.action, 'created');
});

test('codec: exposes a bitbucket-styled marker codec; renderSummaryMarker is inline-code', () => {
  const provider = makeProvider({});
  assert.equal(provider.markers.style(), 'bitbucket');
  assert.equal(provider.renderSummaryMarker(), '`ai-review:v1:summary`');
});

test('upsertSummaryComment: restyles HTML summary marker to inline-code on bitbucket', async () => {
  /** @type {any} */
  let sent = null;
  const provider = makeProvider({
    'GET /pullrequests/7/comments': { json: { values: [] } },
    'POST /pullrequests/7/comments': (/** @type {string} */ url, /** @type {any} */ init) => {
      sent = JSON.parse(init.body);
      return { json: { id: 14 } };
    },
  });
  provider._markerStyle = 'bitbucket';
  await provider.upsertSummaryComment('summary', '### AI Review summary\n\n<!-- ai-review:v1:summary -->');
  assert.match(sent.content.raw, /`ai-review:v1:summary`/);
  assert.equal(/<!--/.test(sent.content.raw), false);
});

test('upsertSummaryComment: keeps HTML summary marker when style resolved to html', async () => {
  /** @type {any} */
  let sent = null;
  const provider = makeProvider({
    'GET /pullrequests/7/comments': { json: { values: [] } },
    'POST /pullrequests/7/comments': (/** @type {string} */ url, /** @type {any} */ init) => {
      sent = JSON.parse(init.body);
      return { json: { id: 15 } };
    },
  });
  provider._markerStyle = 'html';
  await provider.upsertSummaryComment('summary', 'body\n\n<!-- ai-review:v1:summary -->');
  assert.match(sent.content.raw, /<!-- ai-review:v1:summary -->/);
});

test('upsertSummaryComment: does not match a longer key with the same prefix', async () => {
  // A bot comment carrying key `summary-extended` must NOT satisfy key `summary`.
  const provider = makeProvider({
    'GET /pullrequests/7/comments': {
      json: {
        values: [
          { id: 9, content: { raw: 'body `ai-review:v1:summary-extended`' }, user: { account_id: 'bot-acc' } },
        ],
      },
    },
    'POST /pullrequests/7/comments': { json: { id: 13 } },
  });
  provider._selfAccountId = 'bot-acc';
  provider._markerStyle = 'bitbucket';
  const out = await provider.upsertSummaryComment('summary', 'fresh');
  assert.equal(out.id, '13');
  assert.equal(out.action, 'created');
});

test('upsertSummaryComment: matches HTML-comment marker form too', async () => {
  const provider = makeProvider({
    'GET /pullrequests/7/comments': {
      json: {
        values: [
          { id: 9, content: { raw: 'body <!-- ai-review:v1:summary -->' }, user: { account_id: 'bot-acc' } },
        ],
      },
    },
    'PUT /pullrequests/7/comments/9': { json: { id: 9 } },
  });
  provider._selfAccountId = 'bot-acc';
  provider._markerStyle = 'bitbucket';
  const out = await provider.upsertSummaryComment('summary', 'updated body');
  assert.equal(out.action, 'updated');
});

test('patchThreadStatus: active → reply then DELETE resolve (unresolve)', async () => {
  /** @type {any[]} */
  const calls = [];
  const provider = makeProvider({
    'POST /pullrequests/7/comments': { json: { id: 1 } },
    'DELETE /pullrequests/7/comments/100/resolve': { json: {} },
  }, calls);
  provider._markerStyle = 'bitbucket';
  provider._selfAccountId = 'bot-acc';
  await provider.patchThreadStatus('100', 'active');
  assert.ok(calls.some((c) => c.method === 'POST' && c.url.includes('/comments')));
  assert.ok(calls.some((c) => c.method === 'DELETE' && c.url.includes('/comments/100/resolve')));
});

test('patchThreadStatus: fixed → reply then POST resolve', async () => {
  /** @type {any[]} */
  const calls = [];
  const provider = makeProvider({
    'POST /pullrequests/7/comments': { json: { id: 1 } },
    'POST /pullrequests/7/comments/100/resolve': { json: {} },
  }, calls);
  provider._markerStyle = 'bitbucket';
  provider._selfAccountId = 'bot-acc';
  await provider.patchThreadStatus('100', 'fixed');
  assert.ok(calls.some((c) => c.method === 'POST' && c.url.includes('/comments/100/resolve')));
});

test('patchThreadStatus: 403 on resolve soft-skips (no throw)', async () => {
  const provider = makeProvider({
    'POST /pullrequests/7/comments': { json: { id: 1 } },
    'POST /pullrequests/7/comments/100/resolve': { status: 403, text: 'forbidden' },
  });
  provider._markerStyle = 'bitbucket';
  provider._selfAccountId = 'bot-acc';
  // Must not throw — resolve scope error is a soft warning.
  await provider.patchThreadStatus('100', 'fixed');
});

test('patchThreadStatus: 500 on resolve throws ProviderError', async () => {
  const provider = makeProvider({
    'POST /pullrequests/7/comments': { json: { id: 1 } },
    'POST /pullrequests/7/comments/100/resolve': { status: 500, text: 'boom' },
  });
  provider._markerStyle = 'bitbucket';
  provider._selfAccountId = 'bot-acc';
  await assert.rejects(() => provider.patchThreadStatus('100', 'fixed'), ProviderError);
});

test('patchThreadStatus: 409 on resolve is idempotent (already resolved → no throw)', async () => {
  const provider = makeProvider({
    'POST /pullrequests/7/comments': { json: { id: 1 } },
    'POST /pullrequests/7/comments/100/resolve': { status: 409, text: 'already resolved' },
  });
  provider._markerStyle = 'bitbucket';
  provider._selfAccountId = 'bot-acc';
  // 409 = comment already resolved; must not surface a partial failure.
  await provider.patchThreadStatus('100', 'fixed');
});

test('patchThreadStatus: 404 on unresolve is idempotent (not resolved → no throw)', async () => {
  const provider = makeProvider({
    'POST /pullrequests/7/comments': { json: { id: 1 } },
    'DELETE /pullrequests/7/comments/100/resolve': { status: 404, text: 'not resolved' },
  });
  provider._markerStyle = 'bitbucket';
  provider._selfAccountId = 'bot-acc';
  await provider.patchThreadStatus('100', 'active');
});

test('resolveMarkerStyle: picks html when probe token survives in raw', async () => {
  const provider = makeProvider({
    'POST /pullrequests/7/comments': { json: { id: 50, user: { account_id: 'bot-acc' }, content: { raw: 'probe <!-- ai-review:probe -->' } } },
    'GET /pullrequests/7/comments/50': { json: { id: 50, content: { raw: 'probe <!-- ai-review:probe -->' } } },
    'DELETE /pullrequests/7/comments/50': { json: {} },
  });
  const style = await provider.resolveMarkerStyle();
  assert.equal(style, 'html');
  assert.equal(provider._markerStyle, 'html');
});

test('resolveMarkerStyle: picks bitbucket when HTML comment is visible in rendered html', async () => {
  // Bitbucket preserves <!-- --> in raw but renders it as visible (escaped)
  // text → not usable as an invisible marker → must fall back to inline-code.
  const provider = makeProvider({
    'POST /pullrequests/7/comments': { json: { id: 70, user: { account_id: 'bot-acc' }, content: { raw: 'probe <!-- ai-review:probe -->' } } },
    'GET /pullrequests/7/comments/70': { json: { content: { raw: 'probe <!-- ai-review:probe -->', html: '<p>probe &lt;!-- ai-review:probe --&gt;</p>' } } },
    'DELETE /pullrequests/7/comments/70': { status: 204 },
  });
  const style = await provider.resolveMarkerStyle();
  assert.equal(style, 'bitbucket');
});

test('resolveMarkerStyle: picks bitbucket when token stripped', async () => {
  const provider = makeProvider({
    'POST /pullrequests/7/comments': { json: { id: 51, user: { account_id: 'bot-acc' }, content: { raw: 'probe' } } },
    'GET /pullrequests/7/comments/51': { json: { id: 51, content: { raw: 'probe' } } },
    'DELETE /pullrequests/7/comments/51': { json: {} },
  });
  const style = await provider.resolveMarkerStyle();
  assert.equal(style, 'bitbucket');
});

test('resolveMarkerStyle: caches — second call does not re-probe', async () => {
  /** @type {any[]} */
  const calls = [];
  const provider = makeProvider({
    'POST /pullrequests/7/comments': { json: { id: 52, user: { account_id: 'bot-acc' }, content: { raw: 'probe <!-- ai-review:probe -->' } } },
    'GET /pullrequests/7/comments/52': { json: { content: { raw: 'probe <!-- ai-review:probe -->' } } },
    'DELETE /pullrequests/7/comments/52': { json: {} },
  }, calls);
  await provider.resolveMarkerStyle();
  const postCount = calls.filter((c) => c.method === 'POST').length;
  await provider.resolveMarkerStyle();
  const postCount2 = calls.filter((c) => c.method === 'POST').length;
  assert.equal(postCount, postCount2); // no new probe POST
});

test('resolveMarkerStyle: falls back to bitbucket on probe error', async () => {
  const provider = makeProvider({
    'POST /pullrequests/7/comments': { status: 500, text: 'boom' },
  });
  const style = await provider.resolveMarkerStyle();
  assert.equal(style, 'bitbucket');
});

test('resolveMarkerStyle: tolerates 204 No Content on probe delete', async () => {
  const provider = makeProvider({
    'POST /pullrequests/7/comments': { json: { id: 60, user: { account_id: 'bot-acc' }, content: { raw: 'probe <!-- ai-review:probe -->' } } },
    'GET /pullrequests/7/comments/60': { json: { content: { raw: 'probe <!-- ai-review:probe -->' } } },
    'DELETE /pullrequests/7/comments/60': { status: 204 },
  });
  // A 204 delete must not throw (res.json() on an empty body would otherwise).
  const style = await provider.resolveMarkerStyle();
  assert.equal(style, 'html');
});

test('listThreads: flags bot comments by marker before any post (no _selfAccountId)', async () => {
  // Reproduces the read-before-post path the real reply/review flow takes:
  // _selfAccountId is null, so isBot must come from the marker, not the account.
  const page = {
    values: [
      {
        id: 300,
        content: { raw: 'Finding\n`ai-review:v1:active` `ai-review:fingerprint=cafe1234`' },
        inline: { path: 'a.js', to: 4 },
        user: { account_id: 'whatever' },
        created_on: '2026-05-01T00:00:00Z',
      },
      {
        id: 301,
        parent: { id: 300 },
        content: { raw: 'dev reply, no marker' },
        user: { account_id: 'dev' },
        created_on: '2026-05-01T01:00:00Z',
      },
    ],
  };
  const provider = makeProvider({ 'GET /pullrequests/7/comments': { json: page } });
  // Deliberately do NOT set provider._selfAccountId.
  const threads = await provider.listThreads();
  assert.equal(threads.length, 1);
  assert.equal(threads[0].comments[0].isBot, true);  // marker-bearing root
  assert.equal(threads[0].comments[1].isBot, false); // human reply, no marker
  assert.equal(threads[0].status, 'active');
});

test('upsertSummaryComment: finds prior summary by marker before any post (no _selfAccountId)', async () => {
  const provider = makeProvider({
    'GET /pullrequests/7/comments': {
      json: {
        values: [
          { id: 9, content: { raw: 'Summary body\n<!-- ai-review:v1:summary -->' }, user: { account_id: 'x' } },
        ],
      },
    },
    'PUT /pullrequests/7/comments/9': { json: { id: 9 } },
  });
  // No _selfAccountId set — must still recognise the marker-bearing summary as ours.
  const out = await provider.upsertSummaryComment('summary', 'updated body');
  assert.equal(out.action, 'updated');
});

test('listThreads: marker spoofing — human marker comment is NOT flagged bot once bot account is inferred', async () => {
  // Bot authored the inline finding (account 'bot-acc', carries markers). A
  // human reply spoofs a status marker but from a different account.
  const page = {
    values: [
      {
        id: 1,
        content: { raw: 'finding `ai-review:v1:active` `ai-review:fingerprint=ab12cd34`' },
        inline: { path: 'a.js', to: 3 },
        user: { account_id: 'bot-acc' },
        created_on: '2026-05-01T00:00:00Z',
      },
      {
        id: 2,
        parent: { id: 1 },
        content: { raw: 'looks fine to me `ai-review:v1:fixed`' }, // spoofed marker
        user: { account_id: 'human-acc' },
        created_on: '2026-05-01T01:00:00Z',
      },
    ],
  };
  const provider = makeProvider({ 'GET /pullrequests/7/comments': { json: page } });
  // No _selfAccountId preset → inferred from marker-bearing authors (bot-acc).
  const threads = await provider.listThreads();
  assert.equal(threads.length, 1);
  assert.equal(threads[0].comments[0].isBot, true);   // bot finding
  assert.equal(threads[0].comments[1].isBot, false);  // spoofed human reply
  // Spoofed `fixed` must be ignored — status stays from the bot's own marker.
  assert.equal(threads[0].status, 'active');
});

test('listThreads: excludes global (non-inline) comments such as the summary', async () => {
  const page = {
    values: [
      {
        id: 1,
        content: { raw: 'finding `ai-review:v1:active` `ai-review:fingerprint=ab12cd34`' },
        inline: { path: 'a.js', to: 3 },
        user: { account_id: 'bot-acc' },
        created_on: '2026-05-01T00:00:00Z',
      },
      // Global (non-inline) comment — e.g. our own summary. Must NOT become a thread.
      {
        id: 2,
        content: { raw: 'AI Review summary\n`ai-review:v1:summary`' },
        user: { account_id: 'bot-acc' },
        created_on: '2026-05-01T00:00:00Z',
      },
    ],
  };
  const provider = makeProvider({ 'GET /pullrequests/7/comments': { json: page } });
  const threads = await provider.listThreads();
  assert.equal(threads.length, 1);
  assert.equal(threads[0].id, '1');
  assert.equal(threads[0].filePath, 'a.js');
});

test('listThreads: drops orphaned replies whose inline parent is gone (no empty-path thread)', async () => {
  const page = {
    values: [
      // Parent (id 10) deleted/absent; only the reply remains and it lacks inline.
      {
        id: 11,
        parent: { id: 10 },
        content: { raw: 'dev reply' },
        user: { account_id: 'dev' },
        created_on: '2026-05-01T00:00:00Z',
      },
    ],
  };
  const provider = makeProvider({ 'GET /pullrequests/7/comments': { json: page } });
  const threads = await provider.listThreads();
  assert.equal(threads.length, 0);
});

test('getDefaultBranch returns repo mainbranch, defaults to main when unset', async () => {
  const p1 = makeProvider({ 'GET /repositories/ws/repo': { json: { mainbranch: { name: 'develop' } } } });
  assert.equal(await p1.getDefaultBranch(), 'develop');
  const p2 = makeProvider({ 'GET /repositories/ws/repo': { json: {} } });
  assert.equal(await p2.getDefaultBranch(), 'main');
});

test('listThreadsForPR: infers bot account so a pasted-marker comment is not treated as self', async () => {
  const page = {
    values: [
      { id: 100, content: { raw: 'Finding\n`ai-review:v1:active` `ai-review:fingerprint=abcd1234`' }, inline: { path: 'a.js', to: 1 }, user: { account_id: 'bot-acc' }, created_on: '2026-05-01T00:00:00Z' },
      { id: 101, parent: { id: 100 }, content: { raw: 'status `ai-review:v1:fixed`' }, user: { account_id: 'bot-acc' }, created_on: '2026-05-01T02:00:00Z' },
      { id: 102, content: { raw: 'spoof `ai-review:v1:active`' }, inline: { path: 'b.js', to: 2 }, user: { account_id: 'attacker-acc' }, created_on: '2026-05-01T03:00:00Z' },
    ],
  };
  const provider = makeProvider({ 'GET /pullrequests/8/comments': { json: page } });
  assert.equal(provider._selfAccountId, null); // unset before the call
  await provider.listThreadsForPR('8');
  // Majority marker-bearer (bot-acc: 2 vs attacker-acc: 1) is inferred as self;
  // the old path skipped inference and trusted any marker (spoofable).
  assert.equal(provider._selfAccountId, 'bot-acc');
});

module.exports = { fakeFetch, makeProvider, ENV };

// HTTP status -> typed error. _api's withRetry retries only RateLimitError
// and ProviderError with retryable: true, and the CLI maps AuthError to exit 3;
// before this mapping every Bitbucket failure was a non-retryable
// ProviderError (exit 4).
test('_api: 429 throws RateLimitError carrying Retry-After', async () => {
  const provider = makeProvider({ 'GET /pullrequests/7': { status: 429, text: 'slow down', headers: { 'retry-after': '3' } } });
  const err = await provider.getPRMetadata().catch((e) => e);
  assert.ok(err instanceof RateLimitError);
  assert.equal(err.retryable, true);
  assert.equal(err.retryAfterMs, 3000);
});

test('_api: 5xx throws a retryable ProviderError', async () => {
  const provider = makeProvider({ 'GET /pullrequests/7': { status: 503, text: 'unavailable' } });
  const err = await provider.getPRMetadata().catch((e) => e);
  assert.ok(err instanceof ProviderError);
  assert.equal(err.status, 503);
  assert.equal(err.retryable, true);
});

test('_api: 401 and 403 throw AuthError that still exposes the status', async () => {
  for (const status of [401, 403]) {
    const provider = makeProvider({ 'GET /pullrequests/7': { status, text: 'nope' } });
    const err = await provider.getPRMetadata().catch((e) => e);
    assert.ok(err instanceof AuthError, `status ${status}`);
    assert.equal(err.status, status);
  }
});

test('_api: other 4xx throws a non-retryable ProviderError', async () => {
  const provider = makeProvider({ 'GET /pullrequests/7': { status: 400, text: 'bad' } });
  const err = await provider.getPRMetadata().catch((e) => e);
  assert.ok(err instanceof ProviderError && !(err instanceof AuthError));
  assert.equal(err.retryable, false);
});

// Regression: the error message must carry the response body, not
// "[object Object]", across every status branch httpError maps.
test('_api: error message includes the response body text for every status branch', async () => {
  for (const status of [400, 401, 403, 429, 503]) {
    const body = `body-for-${status}`;
    const provider = makeProvider({ 'GET /pullrequests/7': { status, text: body } });
    const err = await provider.getPRMetadata().catch((e) => e);
    assert.ok(err instanceof Error, `status ${status}`);
    assert.match(err.message, new RegExp(`${status} ${body}`), `status ${status}`);
    assert.doesNotMatch(err.message, /\[object Object\]/, `status ${status}`);
  }
});

test('_api: 429 honours an HTTP-date Retry-After', async () => {
  const at = new Date(Date.now() + 30_000).toUTCString();
  const provider = makeProvider({ 'GET /pullrequests/7': { status: 429, text: 'slow down', headers: { 'retry-after': at } } });
  const err = await provider.getPRMetadata().catch((e) => e);
  assert.ok(err instanceof RateLimitError);
  assert.ok(err.retryAfterMs > 20_000 && err.retryAfterMs <= 30_000, `retryAfterMs=${err.retryAfterMs}`);
});

// Per-request retry (ADR-0013): reads, updates and deletes repeat; a create
// (POST) repeats only when Bitbucket provably did not apply it.
const PR_URL = 'https://api.bitbucket.org/2.0/repositories/ws/repo/pullrequests/7';

test('_api: retries a GET after a 5xx and returns the success', async () => {
  /** @type {any[]} */
  const calls = [];
  const provider = makeProvider({
    'GET /pullrequests/7': () => (calls.length === 1 ? { status: 503, text: 'unavailable' } : { json: { id: 7 } }),
  }, calls);
  assert.deepEqual(await provider._api('GET', PR_URL), { id: 7 });
  assert.equal(calls.length, 2);
});

test('_api: does not repeat a POST after a 5xx: Bitbucket may have applied it', async () => {
  /** @type {any[]} */
  const calls = [];
  const provider = makeProvider({ 'POST /pullrequests/7/comments': { status: 503, text: 'unavailable' } }, calls);
  await assert.rejects(() => provider._api('POST', `${PR_URL}/comments`, { body: {} }), ProviderError);
  assert.equal(calls.length, 1);
});

test('patchThreadStatus: repeats the resolve POST after a 5xx (resolving twice is harmless)', async () => {
  /** @type {any[]} */
  const calls = [];
  let resolves = 0;
  const provider = makeProvider({
    'POST /pullrequests/7/comments': { json: { id: 1 } },
    'POST /pullrequests/7/comments/100/resolve': () => (++resolves === 1 ? { status: 503, text: 'unavailable' } : { json: {} }),
  }, calls);
  provider._markerStyle = 'bitbucket';
  provider._selfAccountId = 'bot-acc';
  await provider.patchThreadStatus('100', 'fixed');
  assert.equal(resolves, 2);
});

test('_postForm: does not repeat the commit POST after a 5xx', async () => {
  /** @type {any[]} */
  const calls = [];
  const provider = makeProvider({ 'POST /src': { status: 503, text: 'unavailable' } }, calls);
  await assert.rejects(
    () => provider._postForm('https://api.bitbucket.org/2.0/repositories/ws/repo/src', { message: 'm' }),
    ProviderError,
  );
  assert.equal(calls.length, 1);
});
