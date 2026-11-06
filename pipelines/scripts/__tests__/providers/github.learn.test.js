'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { GitHubReviewProvider } = require('../../lib/providers/github.js');

const env = (over = {}) => ({
  GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r', GITHUB_PR_NUMBER: '7', ...over,
});
const cfg = (over = {}) => ({ markers: { prefix: 'ai-review' }, ...over });

function provider({ rest, graphqlClient } = {}) {
  return new GitHubReviewProvider({
    env: env(),
    config: cfg(),
    deps: {
      restClient: rest ?? {},
      graphqlClient: graphqlClient ?? (async () => ({})),
    },
  });
}

test('constructor tolerates a missing PR when requirePr:false (learn path)', () => {
  // No GITHUB_PR_NUMBER / GITHUB_REF / GITHUB_EVENT_PATH — the learn command
  // builds the provider off any PR and must not throw at construction.
  const p = new GitHubReviewProvider({
    env: { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r' },
    config: cfg(),
    requirePr: false,
    deps: { restClient: {}, graphqlClient: async () => ({}) },
  });
  assert.equal(p.prNumber, null);
});

test('constructor still throws without a PR when requirePr is not false', () => {
  assert.throws(
    () => new GitHubReviewProvider({
      env: { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r' },
      config: cfg(),
      deps: { restClient: {}, graphqlClient: async () => ({}) },
    }),
    /Cannot resolve PR number/,
  );
});

test('listMergedPRs maps merged PRs and skips unmerged', async () => {
  const rest = {
    pulls: {
      list: async () => ({
        data: [
          { number: 10, title: 'A', merged_at: '2026-06-01T00:00:00Z', updated_at: '2026-06-02T00:00:00Z', user: { login: 'alice' }, html_url: 'u10' },
          { number: 11, title: 'B', merged_at: null, updated_at: '2026-06-02T00:00:00Z', user: { login: 'bob' }, html_url: 'u11' },
        ],
      }),
    },
  };
  const p = provider({ rest });
  const out = await p.listMergedPRs({ sinceISO: '2026-01-01T00:00:00Z', limit: 50 });
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], {
    id: '10', title: 'A', mergedAt: '2026-06-01T00:00:00Z', authorEmail: 'alice', url: 'u10',
  });
});

test('listMergedPRs skips PRs merged before sinceISO even when updated recently', async () => {
  const rest = {
    pulls: {
      list: async () => ({
        data: [
          // touched recently (comment edit) but merged long before the window
          { number: 20, title: 'stale-merge', merged_at: '2025-01-01T00:00:00Z', updated_at: '2026-06-10T00:00:00Z', user: { login: 'a' }, html_url: 'u20' },
          // merged inside the window
          { number: 21, title: 'fresh', merged_at: '2026-06-05T00:00:00Z', updated_at: '2026-06-06T00:00:00Z', user: { login: 'b' }, html_url: 'u21' },
        ],
      }),
    },
  };
  const p = provider({ rest });
  const out = await p.listMergedPRs({ sinceISO: '2026-06-01T00:00:00Z', limit: 50 });
  assert.deepEqual(out.map((r) => r.id), ['21']);
});

test('listMergedPRs treats a malformed sinceISO as no lower bound', async () => {
  let calls = 0;
  const rest = {
    pulls: {
      list: async () => {
        calls += 1;
        return calls === 1
          ? { data: [{ number: 1, title: 'x', merged_at: '2020-01-01T00:00:00Z', updated_at: '2020-01-01T00:00:00Z', user: { login: 'a' }, html_url: 'u' }] }
          : { data: [] };
      },
    },
  };
  const p = provider({ rest });
  const out = await p.listMergedPRs({ sinceISO: 'not-a-date', limit: 50 });
  // NaN horizon must not exclude everything; the old merged PR is returned.
  assert.equal(out.length, 1);
  assert.equal(out[0].id, '1');
});

test('listMergedPRs stops paging once past the sinceISO horizon', async () => {
  let calls = 0;
  const rest = {
    pulls: {
      list: async () => {
        calls += 1;
        return {
          data: [
            { number: 1, title: 'old', merged_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z', user: { login: 'x' }, html_url: 'u' },
          ],
        };
      },
    },
  };
  const p = provider({ rest });
  const out = await p.listMergedPRs({ sinceISO: '2026-06-01T00:00:00Z', limit: 50 });
  assert.equal(out.length, 0);
  assert.equal(calls, 1); // crossed horizon on first page, no further paging
});

test('listThreadsForPR reads threads for an arbitrary PR without touching the cached map', async () => {
  let resolvedNum = null;
  const rest = {
    pulls: {
      listReviewComments: async ({ pull_number }) => ({
        data: pull_number === 42
          ? [{ id: 100, path: 'a.ts', line: 3, body: 'x <!-- ai-review:fingerprint=abc123 -->', user: { login: 'bot[bot]' }, created_at: '2026-06-01T00:00:00Z' }]
          : [],
      }),
    },
  };
  const graphqlClient = async (_q, vars) => {
    resolvedNum = vars.num;
    return {
      repository: { pullRequest: { reviewThreads: {
        nodes: [{ id: 'T1', isResolved: false, comments: { nodes: [{ databaseId: 100 }], pageInfo: { hasNextPage: false } } }],
        pageInfo: { hasNextPage: false },
      } } },
    };
  };
  const p = provider({ rest, graphqlClient });
  const threads = await p.listThreadsForPR('42');
  assert.equal(resolvedNum, 42);
  assert.equal(threads.length, 1);
  assert.equal(threads[0].filePath, 'a.ts');
  assert.equal(p._cachedThreadMap, null); // arbitrary-PR lookup must not populate cache
});

test('getDefaultBranch returns the repo default branch', async () => {
  const rest = { repos: { get: async () => ({ data: { default_branch: 'trunk' } }) } };
  const p = provider({ rest });
  assert.equal(await p.getDefaultBranch(), 'trunk');
});

test('getDefaultBranch falls back to main when unset', async () => {
  const rest = { repos: { get: async () => ({ data: {} }) } };
  const p = provider({ rest });
  assert.equal(await p.getDefaultBranch(), 'main');
});

test('proposeStandardsChange forks branch, commits file, opens PR', async () => {
  const seen = {};
  const rest = {
    git: {
      getRef: async () => ({ data: { object: { sha: 'basesha' } } }),
      createRef: async (a) => { seen.createRef = a; return { data: {} }; },
    },
    repos: {
      getContent: async () => { const e = new Error('nf'); e.status = 404; throw e; },
      createOrUpdateFileContents: async (a) => { seen.commit = a; return { data: {} }; },
    },
    pulls: {
      create: async (a) => { seen.pr = a; return { data: { html_url: 'https://gh/pr/1' } }; },
    },
  };
  const p = provider({ rest });
  const res = await p.proposeStandardsChange({
    branch: 'ai/learn', filePath: 'standards.md', newContent: 'NEW', baseBranch: 'main',
    title: 'learn update', body: 'desc',
  });
  assert.equal(res.url, 'https://gh/pr/1');
  assert.equal(seen.createRef.ref, 'refs/heads/ai/learn');
  assert.equal(seen.createRef.sha, 'basesha');
  assert.equal(Buffer.from(seen.commit.content, 'base64').toString('utf8'), 'NEW');
  assert.equal(seen.commit.sha, undefined); // new file: no blob sha
  assert.equal(seen.pr.head, 'ai/learn');
  assert.equal(seen.pr.base, 'main');
});

test('proposeStandardsChange strips a leading ./ from the file path (Contents API rejects it)', async () => {
  const seen = {};
  const rest = {
    git: {
      getRef: async () => ({ data: { object: { sha: 'basesha' } } }),
      createRef: async () => ({ data: {} }),
    },
    repos: {
      getContent: async (a) => { seen.getPath = a.path; const e = new Error('nf'); e.status = 404; throw e; },
      createOrUpdateFileContents: async (a) => { seen.putPath = a.path; return { data: {} }; },
    },
    pulls: { create: async () => ({ data: { html_url: 'u' } }) },
  };
  const p = provider({ rest });
  await p.proposeStandardsChange({
    branch: 'b', filePath: './docs/coding-standards.md', newContent: 'X', baseBranch: 'main', title: 't', body: 'b',
  });
  assert.equal(seen.getPath, 'docs/coding-standards.md');
  assert.equal(seen.putPath, 'docs/coding-standards.md');
});

test('proposeStandardsChange reuses the existing PR when create 422s (same-day re-run)', async () => {
  const err = Object.assign(new Error('A pull request already exists'), { status: 422 });
  const rest = {
    git: {
      getRef: async () => ({ data: { object: { sha: 'basesha' } } }),
      createRef: async () => { const e = new Error('exists'); e.status = 422; throw e; },
    },
    repos: {
      getContent: async () => ({ data: { sha: 'blobsha' } }),
      createOrUpdateFileContents: async () => ({ data: {} }),
    },
    pulls: {
      create: async () => { throw err; },
      list: async (a) => {
        assert.equal(a.head, 'o:ai/learn');
        assert.equal(a.state, 'open');
        return { data: [{ html_url: 'https://gh/pr/existing' }] };
      },
    },
  };
  const p = provider({ rest });
  const res = await p.proposeStandardsChange({
    branch: 'ai/learn', filePath: 'f.md', newContent: 'X', baseBranch: 'main', title: 't', body: 'b',
  });
  assert.equal(res.url, 'https://gh/pr/existing');
});

test('proposeStandardsChange tolerates pre-existing branch (422) and updates existing file', async () => {
  const seen = {};
  const rest = {
    git: {
      getRef: async () => ({ data: { object: { sha: 'basesha' } } }),
      createRef: async () => { const e = new Error('exists'); e.status = 422; throw e; },
    },
    repos: {
      getContent: async () => ({ data: { sha: 'blobsha' } }),
      createOrUpdateFileContents: async (a) => { seen.commit = a; return { data: {} }; },
    },
    pulls: { create: async () => ({ data: { html_url: 'u' } }) },
  };
  const p = provider({ rest });
  await p.proposeStandardsChange({
    branch: 'b', filePath: 'f.md', newContent: 'X', baseBranch: 'main', title: 't', body: 'b',
  });
  assert.equal(seen.commit.sha, 'blobsha'); // existing file: blob sha threaded through
});
