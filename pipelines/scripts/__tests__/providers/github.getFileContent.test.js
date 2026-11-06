'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { GitHubReviewProvider } = require('../../lib/providers/github.js');

function makeProvider({ getContent }) {
  const fakeRest = {
    repos: { getContent },
    pulls: {
      listFiles: async () => ({ data: [] }),
      listReviewComments: async () => ({ data: [] }),
      get: async () => ({ data: { number: 1, head: { ref: 'h', sha: 's' }, base: { ref: 'b', sha: 'bs' }, user: {}, title: 't', html_url: 'u' } }),
    },
  };
  const fakeGraphql = async () => ({});
  return new GitHubReviewProvider({
    config: { auth: { token: 'tok' } },
    env: { GITHUB_TOKEN: 'tok', GITHUB_REPOSITORY: 'o/r', GITHUB_PR_NUMBER: '1' },
    deps: { restClient: fakeRest, graphqlClient: fakeGraphql, resolveDelays: [0] },
  });
}

test('getFileContent: decodes utf8 base64 content', async () => {
  const provider = makeProvider({
    getContent: async () => ({
      data: { type: 'file', content: Buffer.from('hello\nworld', 'utf8').toString('base64'), encoding: 'base64' },
    }),
  });
  const out = await provider.getFileContent('src/a.js', 'abc123');
  assert.equal(out, 'hello\nworld');
});

test('getFileContent: returns null on 404', async () => {
  const provider = makeProvider({
    getContent: async () => { const e = new Error('not found'); e.status = 404; throw e; },
  });
  const out = await provider.getFileContent('missing.js', 'abc123');
  assert.equal(out, null);
});

test('getFileContent: returns null when path is a directory', async () => {
  const provider = makeProvider({
    getContent: async () => ({ data: [{ type: 'file', name: 'a.js' }] }),
  });
  const out = await provider.getFileContent('src', 'abc123');
  assert.equal(out, null);
});

test('getFileContent: returns null when type is not file', async () => {
  const provider = makeProvider({
    getContent: async () => ({ data: { type: 'symlink', content: '', encoding: 'base64' } }),
  });
  const out = await provider.getFileContent('link', 'abc123');
  assert.equal(out, null);
});

test('getFileContent: returns null when file exceeds 1 MB cap (encoding=none)', async () => {
  const provider = makeProvider({
    getContent: async () => ({ data: { type: 'file', content: '', encoding: 'none', size: 2_000_000 } }),
  });
  const out = await provider.getFileContent('huge.bin', 'abc123');
  assert.equal(out, null);
});

test('getFileContent: returns empty string for legitimately empty file (base64 encoding, empty content)', async () => {
  const provider = makeProvider({
    getContent: async () => ({ data: { type: 'file', content: '', encoding: 'base64', size: 0 } }),
  });
  const out = await provider.getFileContent('empty.js', 'abc123');
  assert.equal(out, '');
});

test('getFileContent: rethrows non-404 HTTP errors', async () => {
  const provider = makeProvider({
    getContent: async () => { const e = new Error('server error'); e.status = 500; throw e; },
  });
  await assert.rejects(() => provider.getFileContent('a.js', 'abc123'), /server error/);
});
