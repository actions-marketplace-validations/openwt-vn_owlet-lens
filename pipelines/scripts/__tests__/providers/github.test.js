'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { GitHubReviewProvider } = require('../../lib/providers/github.js');
const { AuthError, ProviderError, OrphanCommentError } = require('../../lib/errors.js');

function makeRest({ pullsGet, pullsListFiles, pullsCreateReviewComment, pullsListReviewComments,
                    pullsListCommentsForReview, pullsListReviews, pullsCreateReview, pullsSubmitReview,
                    issuesListComments, issuesUpdateComment, issuesCreateComment } = {}) {
  return {
    pulls: {
      get: pullsGet ?? (async () => ({ data: { number: 7, head: { ref: 'h', sha: 'sha1' }, base: { ref: 'b', sha: 'sha0' }, title: 'T', user: { login: 'u', email: 'u@x' }, html_url: 'url' } })),
      listFiles: pullsListFiles ?? (async () => ({ data: [] })),
      createReviewComment: pullsCreateReviewComment ?? (async () => ({ data: { id: 1 } })),
      listReviewComments: pullsListReviewComments ?? (async () => ({ data: [] })),
      listCommentsForReview: pullsListCommentsForReview ?? (async () => ({ data: [] })),
      listReviews: pullsListReviews ?? (async () => ({ data: [] })),
      createReview: pullsCreateReview ?? (async () => ({ data: { id: 4242 } })),
      submitReview: pullsSubmitReview ?? (async () => ({ data: { id: 4242, state: 'COMMENTED' } })),
    },
    issues: {
      listComments: issuesListComments ?? (async () => ({ data: [] })),
      updateComment: issuesUpdateComment ?? (async () => ({ data: { id: 1 } })),
      createComment: issuesCreateComment ?? (async () => ({ data: { id: 99 } })),
    },
  };
}

const env = (over = {}) => ({
  GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r', GITHUB_REF: 'refs/pull/7/head', ...over,
});
const cfg = (over = {}) => ({ markers: { prefix: 'ai-review' }, ...over });

test('throws AuthError when token missing', () => {
  assert.throws(
    () => new GitHubReviewProvider({ env: { GITHUB_REPOSITORY: 'o/r' }, config: cfg() }),
    AuthError,
  );
});

test('throws ProviderError when GITHUB_REPOSITORY missing or malformed', () => {
  assert.throws(
    () => new GitHubReviewProvider({ env: { GITHUB_TOKEN: 't' }, config: cfg() }),
    ProviderError,
  );
  assert.throws(
    () => new GitHubReviewProvider({ env: { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'noslash' }, config: cfg() }),
    ProviderError,
  );
});

test('throws ProviderError when PR number not derivable', () => {
  assert.throws(
    () => new GitHubReviewProvider({
      env: { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r' },
      config: cfg(),
    }),
    ProviderError,
  );
});

test('codec: exposes an html-styled marker codec; renderSummaryMarker is an HTML comment', () => {
  const p = new GitHubReviewProvider({
    env: env(), config: cfg(),
    deps: { restClient: makeRest(), graphqlClient: async () => ({}) },
  });
  assert.equal(p.markers.style(), 'html');
  assert.equal(p.renderSummaryMarker(), '<!-- ai-review:v1:summary -->');
});

test('PR number resolved from GITHUB_REF', () => {
  const p = new GitHubReviewProvider({
    env: env(), config: cfg(),
    deps: { restClient: makeRest(), graphqlClient: async () => ({ repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } } } }) },
  });
  assert.equal(p.prNumber, 7);
});

test('PR number resolved from GITHUB_PR_NUMBER env when ref absent', () => {
  const p = new GitHubReviewProvider({
    env: { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r', GITHUB_PR_NUMBER: '42' },
    config: cfg(),
    deps: { restClient: makeRest(), graphqlClient: async () => ({ repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } } } }) },
  });
  assert.equal(p.prNumber, 42);
});

test('getPRMetadata returns shape', async () => {
  const p = new GitHubReviewProvider({
    env: env(), config: cfg(),
    deps: { restClient: makeRest(), graphqlClient: async () => ({}) },
  });
  const m = await p.getPRMetadata();
  assert.equal(m.id, '7');
  assert.equal(m.sourceBranch, 'h');
  assert.equal(m.title, 'T');
  assert.equal(m.description, '');
});

test('getPRMetadata maps the PR body to description', async () => {
  const restClient = makeRest({
    pullsGet: async () => ({ data: { number: 7, head: { ref: 'h', sha: 's1' }, base: { ref: 'b', sha: 's0' }, title: 'T', body: 'Why', user: { login: 'u' }, html_url: 'url' } }),
  });
  const p = new GitHubReviewProvider({ env: env(), config: cfg(), deps: { restClient, graphqlClient: async () => ({}) } });
  assert.equal((await p.getPRMetadata()).description, 'Why');
});

test('getDiff maps file status', async () => {
  const restClient = makeRest({
    pullsListFiles: async () => ({
      data: [
        { filename: 'a.ts', status: 'added', patch: 'p1' },
        { filename: 'b.ts', status: 'modified', patch: 'p2' },
        { filename: 'c.ts', status: 'removed', patch: '' },
        { filename: 'd.ts', status: 'renamed', patch: 'p4', previous_filename: 'old.ts' },
      ],
    }),
  });
  const p = new GitHubReviewProvider({
    env: env(), config: cfg(),
    deps: { restClient, graphqlClient: async () => ({}) },
  });
  const diff = await p.getDiff();
  assert.deepEqual(diff.map((f) => f.change), ['add', 'modify', 'delete', 'rename']);
  assert.equal(diff[3].oldPath, 'old.ts');
});

test('upsertSummaryComment updates when bot-authored existing match found', async () => {
  let updateCalledWith = null;
  const restClient = makeRest({
    issuesListComments: async () => ({
      data: [{
        id: 100,
        body: 'old\n<!-- ai-review:v1:summary -->',
        user: { login: 'ai-bot' },
      }],
    }),
    issuesUpdateComment: async ({ comment_id, body }) => {
      updateCalledWith = { comment_id, body };
      return { data: { id: comment_id } };
    },
  });
  const p = new GitHubReviewProvider({
    env: env(), config: cfg(),
    deps: { restClient, graphqlClient: async () => ({}) },
  });
  const r = await p.upsertSummaryComment('summary', 'NEW BODY');
  assert.equal(r.action, 'updated');
  assert.equal(updateCalledWith.comment_id, 100);
  assert.equal(updateCalledWith.body, 'NEW BODY');
});

test('upsertSummaryComment creates new when no existing bot match', async () => {
  let createCalled = false;
  const restClient = makeRest({
    issuesListComments: async () => ({
      data: [{
        id: 100,
        body: 'spoofed marker <!-- ai-review:v1:summary -->',
        user: { login: 'human-user' },
      }],
    }),
    issuesCreateComment: async () => {
      createCalled = true;
      return { data: { id: 200 } };
    },
  });
  const p = new GitHubReviewProvider({
    env: env(), config: cfg(),
    deps: { restClient, graphqlClient: async () => ({}) },
  });
  const r = await p.upsertSummaryComment('summary', 'BODY');
  assert.equal(r.action, 'created');
  assert.equal(r.id, '200');
  assert.ok(createCalled);
});

test('replyToThread issues GraphQL mutation and returns id', async () => {
  let mutationCalled = null;
  const graphqlClient = async (query, vars) => {
    mutationCalled = { query, vars };
    return { addPullRequestReviewThreadReply: { comment: { databaseId: 555 } } };
  };
  const p = new GitHubReviewProvider({
    env: env(), config: cfg(),
    deps: { restClient: makeRest(), graphqlClient },
  });
  const r = await p.replyToThread('TID', 'hello');
  assert.equal(r.id, '555');
  assert.ok(mutationCalled.query.includes('addPullRequestReviewThreadReply'));
  assert.deepEqual(mutationCalled.vars, { threadId: 'TID', body: 'hello' });
});

test('postThread with status=active does not call resolve flow', async () => {
  let createdComment = null;
  const restClient = makeRest({
    pullsCreateReviewComment: async ({ body, path, line }) => {
      createdComment = { body, path, line };
      return { data: { id: 33 } };
    },
  });
  let graphqlCalls = 0;
  const graphqlClient = async () => {
    graphqlCalls += 1;
    return { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } } } };
  };
  const p = new GitHubReviewProvider({
    env: env(), config: cfg(),
    deps: { restClient, graphqlClient, resolveDelays: [0] },
  });
  const r = await p.postThread({
    filePath: 'a.ts', line: 7, body: 'msg', status: 'active', ruleId: 'rule:HIGH:abc',
  });
  assert.equal(r.id, '33');
  assert.ok(createdComment.body.includes('<!-- ai-review:v1:active -->'));
  assert.ok(createdComment.body.includes('<!-- ai-review:fingerprint='));
  assert.equal(graphqlCalls, 0);
});

test('postThread with status=fixed throws OrphanCommentError when GraphQL never sees comment', async () => {
  const restClient = makeRest({
    pullsCreateReviewComment: async () => ({ data: { id: 999 } }),
  });
  const graphqlClient = async () => ({
    repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } } },
  });
  const p = new GitHubReviewProvider({
    env: env(), config: cfg(),
    deps: { restClient, graphqlClient, resolveDelays: [0, 0, 0] },
  });
  await assert.rejects(
    () => p.postThread({ filePath: 'a.ts', line: 1, body: 'm', status: 'fixed', ruleId: 'r' }),
    (e) => e instanceof OrphanCommentError && e.commentDbId === 999,
  );
});

test('listThreads orphans REST comments not present in GraphQL map', async () => {
  const restClient = makeRest({
    pullsListReviewComments: async () => ({
      data: [
        { id: 1, path: 'a.ts', line: 1, body: 'orphan', user: { login: 'ai-bot' }, created_at: '2026-01-01T00:00:00Z' },
        { id: 2, path: 'b.ts', line: 2, body: '**[HIGH/security]** msg\n<!-- ai-review:v1:active -->', user: { login: 'ai-bot' }, created_at: '2026-01-02T00:00:00Z' },
      ],
    }),
  });
  const graphqlClient = async () => ({
    repository: { pullRequest: { reviewThreads: {
      nodes: [{ id: 'T2', isResolved: false, comments: { nodes: [{ databaseId: 2 }], pageInfo: { hasNextPage: false } } }],
      pageInfo: { hasNextPage: false },
    } } },
  });
  const p = new GitHubReviewProvider({
    env: env(), config: cfg(),
    deps: { restClient, graphqlClient },
  });
  const threads = await p.listThreads();
  assert.equal(threads.length, 1);
  assert.equal(threads[0].id, 'T2');
  assert.equal(threads[0].status, 'active');
});

test('listThreads parses bot-authored marker from latest comment', async () => {
  const restClient = makeRest({
    pullsListReviewComments: async () => ({
      data: [
        { id: 1, path: 'a.ts', line: 1, body: '**[HIGH/security]** msg\n<!-- ai-review:v1:active -->\n<!-- ai-review:fingerprint=abcd1234abcd1234 -->', user: { login: 'ai-bot' }, created_at: '2026-01-01T00:00:00Z' },
        { id: 2, path: 'a.ts', line: 1, body: 'human reply', user: { login: 'human' }, created_at: '2026-01-02T00:00:00Z' },
        { id: 3, path: 'a.ts', line: 1, body: '<!-- ai-review:v1:fixed -->', user: { login: 'ai-bot' }, created_at: '2026-01-03T00:00:00Z' },
      ],
    }),
  });
  const graphqlClient = async () => ({
    repository: { pullRequest: { reviewThreads: {
      nodes: [{
        id: 'T1', isResolved: true,
        comments: { nodes: [{ databaseId: 1 }, { databaseId: 2 }, { databaseId: 3 }], pageInfo: { hasNextPage: false } },
      }],
      pageInfo: { hasNextPage: false },
    } } },
  });
  const p = new GitHubReviewProvider({
    env: env(), config: cfg(),
    deps: { restClient, graphqlClient },
  });
  const threads = await p.listThreads();
  assert.equal(threads[0].status, 'fixed');
  assert.equal(threads[0].marker.fingerprint, 'abcd1234abcd1234');
  assert.equal(threads[0].marker.version, 'v1');
});

test('capabilities exposes nativeWontFix=false', () => {
  const p = new GitHubReviewProvider({
    env: env(), config: cfg(),
    deps: { restClient: makeRest(), graphqlClient: async () => ({}) },
  });
  assert.equal(p.capabilities.nativeWontFix, false);
  assert.equal(p.capabilities.lineLevelThreads, true);
});

test('replyToThread appends marker when opts.status provided', async () => {
  const captured = [];
  const fakeGraphql = async (_q, vars) => {
    captured.push(vars);
    return { addPullRequestReviewThreadReply: { comment: { databaseId: 99 } } };
  };
  const fakeRest = {
    pulls: { get: async () => ({ data: { head: { sha: 's' } } }) },
  };
  const provider = new GitHubReviewProvider({
    config: { auth: { token: 't' }, markers: { prefix: 'ai-review' } },
    env: { GITHUB_REPOSITORY: 'o/r', GITHUB_PR_NUMBER: '1' },
    deps: { restClient: fakeRest, graphqlClient: fakeGraphql, graphqlResolveClient: fakeGraphql },
  });

  await provider.replyToThread('T_1', 'regression body', {
    status: 'active',
    fingerprintHash: 'abcdef1234567890',
  });

  assert.equal(captured.length, 1);
  assert.ok(captured[0].body.startsWith('regression body'));
  assert.ok(captured[0].body.includes('<!-- ai-review:v1:active -->'));
  assert.ok(captured[0].body.includes('<!-- ai-review:fingerprint=abcdef1234567890 -->'));
});

test('patchThreadStatus with skipMarkerReply only flips resolved state', async () => {
  const calls = [];
  const fakeGraphql = async (q, vars) => {
    calls.push({ q, vars });
    if (q.includes('unresolveReviewThread')) return { unresolveReviewThread: { thread: { id: vars.id } } };
    if (q.includes('resolveReviewThread')) return { resolveReviewThread: { thread: { id: vars.id } } };
    return { addPullRequestReviewThreadReply: { comment: { databaseId: 1 } } };
  };
  const fakeRest = { pulls: { get: async () => ({ data: { head: { sha: 's' } } }) } };
  const provider = new GitHubReviewProvider({
    config: { auth: { token: 't' }, markers: { prefix: 'ai-review' } },
    env: { GITHUB_REPOSITORY: 'o/r', GITHUB_PR_NUMBER: '1' },
    deps: { restClient: fakeRest, graphqlClient: fakeGraphql, graphqlResolveClient: fakeGraphql },
  });

  await provider.patchThreadStatus('T_1', 'active', { skipMarkerReply: true });

  // Exactly one GraphQL call, the unresolve mutation. No reply mutation.
  assert.equal(calls.length, 1);
  assert.ok(calls[0].q.includes('unresolveReviewThread'));
});

test('_fetchThreadResolvedMap inner-paginates comments past 50', async () => {
  const callsLog = [];
  const fakeGraphql = async (query, vars) => {
    callsLog.push({ query, vars });

    if (query.includes('reviewThreads(first:50')) {
      return {
        repository: { pullRequest: { reviewThreads: {
          nodes: [
            {
              id: 'T_A', isResolved: false,
              comments: {
                nodes: Array.from({ length: 50 }, (_, i) => ({ databaseId: 1000 + i })),
                pageInfo: { hasNextPage: true, endCursor: 'A_50' },
              },
            },
            {
              id: 'T_B', isResolved: true,
              comments: {
                nodes: [{ databaseId: 2000 }, { databaseId: 2001 }, { databaseId: 2002 }],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        } } },
      };
    }


    if (query.includes('node(id:') || query.includes('PullRequestReviewThread')) {
      return {
        node: {
          comments: {
            nodes: Array.from({ length: 25 }, (_, i) => ({ databaseId: 1050 + i })),
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      };
    }

    throw new Error(`unexpected graphql query: ${query.slice(0, 100)}`);
  };

  const fakeRest = { pulls: { get: async () => ({ data: { head: { sha: 's' } } }) } };
  const provider = new GitHubReviewProvider({
    config: { auth: { token: 't' }, markers: { prefix: 'ai-review' } },
    env: { GITHUB_REPOSITORY: 'o/r', GITHUB_PR_NUMBER: '1' },
    deps: { restClient: fakeRest, graphqlClient: fakeGraphql, graphqlResolveClient: fakeGraphql },
  });

  const map = await provider._fetchThreadResolvedMap();

  for (let i = 0; i < 75; i++) {
    const entry = map.get(1000 + i);
    assert.ok(entry, `missing entry for comment ${1000 + i}`);
    assert.equal(entry.threadGqlId, 'T_A');
  }
  for (let i = 0; i < 3; i++) {
    const entry = map.get(2000 + i);
    assert.ok(entry, `missing entry for comment ${2000 + i}`);
  }
  assert.ok(callsLog.length >= 2, 'expected outer + inner queries');
});

test('_fetchThreadResolvedMap warn-falls-back on inner-pagination failure', async () => {
  const origStderr = process.stderr.write;
  const stderrLines = [];
  process.stderr.write = (chunk) => { stderrLines.push(String(chunk)); return true; };

  const fakeGraphql = async (query) => {
    if (query.includes('reviewThreads(first:50')) {
      return {
        repository: { pullRequest: { reviewThreads: {
          nodes: [{
            id: 'T_A', isResolved: false,
            comments: {
              nodes: Array.from({ length: 50 }, (_, i) => ({ databaseId: 1000 + i })),
              pageInfo: { hasNextPage: true, endCursor: 'A_50' },
            },
          }],
          pageInfo: { hasNextPage: false, endCursor: null },
        } } },
      };
    }
    if (query.includes('node(id:')) {
      throw new Error('graphql rate-limited');
    }
    throw new Error(`unexpected query`);
  };

  const fakeRest = { pulls: { get: async () => ({ data: { head: { sha: 's' } } }) } };
  const provider = new GitHubReviewProvider({
    config: { auth: { token: 't' }, markers: { prefix: 'ai-review' } },
    env: { GITHUB_REPOSITORY: 'o/r', GITHUB_PR_NUMBER: '1' },
    deps: { restClient: fakeRest, graphqlClient: fakeGraphql, graphqlResolveClient: fakeGraphql },
  });

  try {
    const map = await provider._fetchThreadResolvedMap();
    for (let i = 0; i < 50; i++) {
      assert.ok(map.get(1000 + i), 'first-page entries must survive inner failure');
    }
    assert.equal(map.size, 50, 'no extra entries from failed inner pagination');
    const warnLine = stderrLines.find((l) => l.includes('thread.inner-pagination.failed'));
    assert.ok(warnLine, 'inner-pagination failure must produce a structured warn');
  } finally {
    process.stderr.write = origStderr;
  }
});

test('postThreadsBatch: empty input returns [] without any API calls', async () => {
  let listReviewsCalled = false;
  let createReviewCalled = false;
  const restClient = makeRest({
    pullsListReviews: async () => { listReviewsCalled = true; return { data: [] }; },
    pullsCreateReview: async () => { createReviewCalled = true; return { data: { id: 1 } }; },
  });
  const p = new GitHubReviewProvider({
    env: env(), config: cfg(),
    deps: { restClient, graphqlClient: async () => ({}) },
  });
  const out = await p.postThreadsBatch([]);
  assert.deepEqual(out, []);
  assert.equal(listReviewsCalled, false);
  assert.equal(createReviewCalled, false);
});

test('postThreadsBatch: creates one atomic review with all comments inline as event=COMMENT', async () => {
  const calls = [];
  let capturedComments = null;
  const restClient = makeRest({
    pullsListReviews: async () => { calls.push(['listReviews']); return { data: [] }; },
    pullsCreateReview: async (args) => {
      calls.push(['createReview', args.commit_id, args.event]);
      capturedComments = args.comments;
      return { data: { id: 7777 } };
    },
    pullsListCommentsForReview: async (args) => {
      calls.push(['listCommentsForReview', args.review_id]);
      // Echo back the same bodies so id matching succeeds.
      return { data: capturedComments.map((c, i) => ({
        id: 100 + i, body: c.body, path: c.path, line: c.line,
      })) };
    },
    pullsCreateReviewComment: async () => {
      throw new Error('createReviewComment must not be called in atomic flow');
    },
    pullsSubmitReview: async () => {
      throw new Error('submitReview must not be called in atomic flow');
    },
  });
  const p = new GitHubReviewProvider({
    env: env(), config: cfg(),
    deps: { restClient, graphqlClient: async () => ({}) },
  });
  const out = await p.postThreadsBatch([
    { filePath: 'a.ts', line: 1, body: 'b1', status: 'active', ruleId: 'r1' },
    { filePath: 'b.ts', line: 2, body: 'b2', status: 'active', ruleId: 'r2' },
    { filePath: 'c.ts', line: 3, body: 'b3', status: 'active', ruleId: 'r3' },
  ]);
  assert.equal(out.length, 3);
  for (const r of out) {
    assert.equal(r.ok, true);
    assert.ok(/^\d+$/.test(r.value.id));
  }
  // Order: listReviews (orphan cleanup), createReview (atomic), listCommentsForReview
  assert.equal(calls[0][0], 'listReviews');
  assert.equal(calls[1][0], 'createReview');
  assert.equal(calls[1][1], 'sha1');
  assert.equal(calls[1][2], 'COMMENT', 'event must be COMMENT for atomic submit');
  assert.equal(calls.filter((c) => c[0] === 'createReview').length, 1);
  // All three comments sent inline in the createReview call.
  assert.equal(capturedComments.length, 3);
  assert.deepEqual(
    capturedComments.map((c) => [c.path, c.line, c.side]),
    [['a.ts', 1, 'RIGHT'], ['b.ts', 2, 'RIGHT'], ['c.ts', 3, 'RIGHT']],
  );
});

test('postThreadsBatch: submits orphan PENDING reviews from prior runs before atomic create', async () => {
  const submittedOrphans = [];
  const restClient = makeRest({
    pullsListReviews: async () => ({ data: [
      { id: 5555, state: 'PENDING' },
      { id: 5556, state: 'PENDING' },
      { id: 1, state: 'COMMENTED' },
    ] }),
    pullsSubmitReview: async (args) => {
      submittedOrphans.push([args.review_id, args.event]);
      return { data: { id: args.review_id } };
    },
    pullsCreateReview: async () => ({ data: { id: 9999 } }),
    pullsListCommentsForReview: async () => ({ data: [] }),
  });
  const p = new GitHubReviewProvider({
    env: env(), config: cfg(),
    deps: { restClient, graphqlClient: async () => ({}) },
  });
  const out = await p.postThreadsBatch([
    { filePath: 'a.ts', line: 1, body: 'b1', status: 'active', ruleId: 'r1' },
  ]);
  assert.equal(out[0].ok, true);
  assert.deepEqual(submittedOrphans, [[5555, 'COMMENT'], [5556, 'COMMENT']]);
});

test('postThreadsBatch: createReview validation failure marks every thread as failed', async () => {
  const validationErr = new Error('Validation Failed: line not in diff');
  validationErr.status = 422;
  const restClient = makeRest({
    pullsCreateReview: async () => { throw validationErr; },
  });
  const p = new GitHubReviewProvider({
    env: env(), config: cfg(),
    deps: { restClient, graphqlClient: async () => ({}) },
  });
  const out = await p.postThreadsBatch([
    { filePath: 'a.ts', line: 1, body: 'b1', status: 'active', ruleId: 'r1' },
    { filePath: 'b.ts', line: 2, body: 'b2', status: 'active', ruleId: 'r2' },
  ]);
  assert.equal(out[0].ok, false);
  assert.equal(out[1].ok, false);
  assert.equal(out[0].error, validationErr);
  assert.equal(out[1].error, validationErr);
});

test('postThreadsBatch: listCommentsForReview failure still returns ok with empty ids', async () => {
  let capturedComments = null;
  const restClient = makeRest({
    pullsCreateReview: async (args) => {
      capturedComments = args.comments;
      return { data: { id: 8888 } };
    },
    pullsListCommentsForReview: async () => {
      const err = new Error('502 Bad Gateway');
      err.status = 502;
      throw err;
    },
  });
  const origStderr = process.stderr.write;
  const stderrLines = [];
  process.stderr.write = (s) => { stderrLines.push(String(s)); return true; };
  try {
    const p = new GitHubReviewProvider({
      env: env(), config: cfg(),
      deps: { restClient, graphqlClient: async () => ({}) },
    });
    const out = await p.postThreadsBatch([
      { filePath: 'a.ts', line: 1, body: 'b1', status: 'active', ruleId: 'r1' },
    ]);
    assert.equal(out[0].ok, true);
    assert.equal(out[0].value.id, '');
    assert.ok(capturedComments.length === 1);
    assert.ok(stderrLines.some((l) => l.includes('listCommentsForReview failed')));
  } finally {
    process.stderr.write = origStderr;
  }
});

test('postThreadsBatch: orphan submit failure logged but proceeds to atomic create', async () => {
  const submitErr = new Error('orphan submit blew up');
  submitErr.status = 500;
  let createReviewCalled = false;
  const restClient = makeRest({
    pullsListReviews: async () => ({ data: [{ id: 5555, state: 'PENDING' }] }),
    pullsSubmitReview: async () => { throw submitErr; },
    pullsCreateReview: async () => { createReviewCalled = true; return { data: { id: 9999 } }; },
    pullsListCommentsForReview: async () => ({ data: [] }),
  });
  const origStderr = process.stderr.write;
  const stderrLines = [];
  process.stderr.write = (s) => { stderrLines.push(String(s)); return true; };
  try {
    const p = new GitHubReviewProvider({
      env: env(), config: cfg(),
      deps: { restClient, graphqlClient: async () => ({}) },
    });
    const out = await p.postThreadsBatch([
      { filePath: 'a.ts', line: 1, body: 'b1', status: 'active', ruleId: 'r1' },
    ]);
    assert.equal(out.length, 1);
    assert.equal(createReviewCalled, true, 'atomic create still runs even if orphan submit failed');
    assert.ok(stderrLines.some((l) => l.includes('failed to submit orphan PENDING review')));
  } finally {
    process.stderr.write = origStderr;
  }
});

test('isBotComment: detects user.type === "Bot" regardless of login shape', () => {
  const { __test__ } = require('../../lib/providers/github.js');
  assert.ok(__test__, 'github.js must expose __test__ for unit tests');
  const { isBotComment } = __test__;

  assert.equal(isBotComment({ user: { type: 'Bot', login: 'random-name' } }), true);
  assert.equal(isBotComment({ user: { type: 'User', login: 'thomas[bot]' } }), true,
    'fallback regex still matches [bot] suffix');
  assert.equal(isBotComment({ user: { type: 'User', login: 'ai-bot-prod' } }), true,
    'fallback regex still matches ai-bot');
  assert.equal(isBotComment({ user: { type: 'User', login: 'thomas' } }), false);
  assert.equal(isBotComment({ user: null }), false);
  assert.equal(isBotComment({}), false);
  assert.equal(isBotComment(null), false);
});
