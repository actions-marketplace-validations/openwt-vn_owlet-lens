// @ts-check
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { BitbucketCloudReviewProvider } = require('../lib/providers/bitbucket.js');

const baseEnv = {
  BITBUCKET_TOKEN: 't', BITBUCKET_WORKSPACE: 'ws', BITBUCKET_REPO_SLUG: 'repo',
};

function makeProv(env = {}, fetchImpl) {
  return new BitbucketCloudReviewProvider({
    config: {}, env: { ...baseEnv, ...env }, requirePr: false, deps: { fetch: fetchImpl },
  });
}

describe('bitbucket optional prId', () => {
  it('constructs without BITBUCKET_PR_ID when requirePr=false', () => {
    assert.doesNotThrow(() => makeProv());
  });
  it('still throws without prId when requirePr default (review/reply path)', () => {
    assert.throws(
      () => new BitbucketCloudReviewProvider({ config: {}, env: { ...baseEnv } }),
      /PR id missing/,
    );
  });
  it('PR-scoped getPRMetadata throws when prId absent', async () => {
    await assert.rejects(() => makeProv().getPRMetadata(), /requires a PR id/);
  });
});

describe('bitbucket listMergedPRs', () => {
  it('queries MERGED state since timestamp and normalizes', async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      return { ok: true, status: 200, json: async () => ({
        values: [{ id: 12, title: 'Fix', updated_on: '2026-06-01T00:00:00Z',
          author: { nickname: 'dev1' }, links: { html: { href: 'http://pr/12' } } }],
        next: null,
      }) };
    };
    const prov = makeProv({}, fetchImpl);
    const prs = await prov.listMergedPRs({ sinceISO: '2026-05-01T00:00:00Z', limit: 50 });
    assert.equal(prs.length, 1);
    assert.deepEqual(prs[0], { id: '12', title: 'Fix', mergedAt: '2026-06-01T00:00:00Z', authorEmail: 'dev1', url: 'http://pr/12' });
    assert.match(calls[0], /state=MERGED/);
    assert.match(calls[0], /updated_on/);
  });
});

describe('bitbucket listThreadsForPR', () => {
  it('fetches comments for the given pr id and groups threads', async () => {
    const fetchImpl = async (url) => ({
      ok: true, status: 200, json: async () => ({
        values: [{
          id: 1, content: { raw: '**[LOW/style]** nit `ai-review:v1:wontfix` `ai-review:fingerprint=aaaa`' },
          inline: { path: 'a.ts', to: 3 }, user: { account_id: 'bot' }, created_on: '2026-06-01T00:00:00Z',
        }],
        next: null,
      }),
    });
    const prov = makeProv({}, fetchImpl);
    const threads = await prov.listThreadsForPR('77');
    assert.ok(Array.isArray(threads));
    assert.equal(threads.length, 1);
    assert.equal(threads[0].status, 'wontfix');
  });
});

describe('bitbucket proposeStandardsChange', () => {
  it('forks branch from baseBranch head, commits, then opens PR; returns url', async () => {
    const seen = [];
    const fetchImpl = async (url, init) => {
      let body = init.body;
      if (init.headers['Content-Type'] === 'application/x-www-form-urlencoded') {
        body = String(init.body);
      }
      seen.push({ url, method: init.method, ct: init.headers['Content-Type'], body });
      if (url.includes('/refs/branches/develop')) {
        return { ok: true, status: 200, json: async () => ({ target: { hash: 'deadbeef' } }) };
      }
      if (url.endsWith('/src')) return { ok: true, status: 201, text: async () => '', json: async () => ({}) };
      if (url.endsWith('/pullrequests')) {
        return { ok: true, status: 201, json: async () => ({ id: 5, links: { html: { href: 'http://pr/5' } } }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    };
    const prov = makeProv({}, fetchImpl);
    const res = await prov.proposeStandardsChange({
      branch: 'owlet-lens/learn-x', filePath: 'coding-standards.md',
      newContent: '# new', baseBranch: 'develop', title: 'T', body: 'B',
    });
    assert.deepEqual(res, { url: 'http://pr/5' });
    // refs GET resolves the baseBranch head first.
    assert.ok(seen[0].url.includes('/refs/branches/develop') && seen[0].method === 'GET', 'refs GET must come first');
    const srcCall = seen.find((s) => s.url.endsWith('/src'));
    assert.ok(srcCall && srcCall.ct === 'application/x-www-form-urlencoded', 'src must be a form POST');
    // The resolved head is pinned as the fork parent.
    assert.ok(srcCall.body.includes('parents=deadbeef'), 'src form body must include parents=deadbeef');
    assert.ok(seen.some((s) => s.url.endsWith('/pullrequests') && s.method === 'POST'));
    // src commit must precede the PR open (the refs GET leads).
    const srcIdx = seen.findIndex((s) => s.url.endsWith('/src'));
    const prIdx = seen.findIndex((s) => s.url.endsWith('/pullrequests'));
    assert.ok(srcIdx < prIdx, 'src commit must precede pullrequest open');
  });

  it('strips a leading ./ from the committed file path', async () => {
    const seen = [];
    const fetchImpl = async (url, init) => {
      let body = init.body;
      if (init.headers['Content-Type'] === 'application/x-www-form-urlencoded') body = String(init.body);
      seen.push({ url, body });
      if (url.includes('/refs/branches/develop')) return { ok: true, status: 200, json: async () => ({ target: { hash: 'd' } }) };
      if (url.endsWith('/src')) return { ok: true, status: 201, text: async () => '', json: async () => ({}) };
      if (url.endsWith('/pullrequests')) return { ok: true, status: 201, json: async () => ({ links: { html: { href: 'u' } } }) };
      return { ok: true, status: 200, json: async () => ({}) };
    };
    const prov = makeProv({}, fetchImpl);
    await prov.proposeStandardsChange({
      branch: 'b', filePath: './docs/coding-standards.md', newContent: '# x', baseBranch: 'develop', title: 'T', body: 'B',
    });
    const src = seen.find((s) => s.url.endsWith('/src'));
    // form field name is the path: must be docs/... not ./docs/... (encoded ./ = .%2F)
    assert.ok(src.body.includes('docs%2Fcoding-standards.md'), 'path committed repo-relative');
    assert.ok(!src.body.includes('.%2Fdocs'), 'leading ./ stripped');
  });

  it('reuses an existing open PR when create fails (same-day re-run)', async () => {
    const fetchImpl = async (url, init) => {
      const method = init.method || 'GET';
      if (url.includes('/refs/branches/develop')) {
        return { ok: true, status: 200, json: async () => ({ target: { hash: 'deadbeef' } }) };
      }
      if (url.endsWith('/src')) return { ok: true, status: 201, text: async () => '', json: async () => ({}) };
      if (url.endsWith('/pullrequests') && method === 'POST') {
        return { ok: false, status: 400, text: async () => 'branch already has an open PR', json: async () => ({}) };
      }
      if (url.includes('/pullrequests?q=') && method === 'GET') {
        return { ok: true, status: 200, json: async () => ({ values: [{ id: 9, links: { html: { href: 'http://pr/existing' } } }] }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    };
    const prov = makeProv({}, fetchImpl);
    const res = await prov.proposeStandardsChange({
      branch: 'owlet-lens/learn-x', filePath: 'coding-standards.md',
      newContent: '# new', baseBranch: 'develop', title: 'T', body: 'B',
    });
    assert.deepEqual(res, { url: 'http://pr/existing' });
  });

  it('propagates a non-duplicate create error without a reuse lookup', async () => {
    let lookups = 0;
    const fetchImpl = async (url, init) => {
      const method = init.method || 'GET';
      if (url.includes('/refs/branches/develop')) {
        return { ok: true, status: 200, json: async () => ({ target: { hash: 'deadbeef' } }) };
      }
      if (url.endsWith('/src')) return { ok: true, status: 201, text: async () => '', json: async () => ({}) };
      if (url.endsWith('/pullrequests') && method === 'POST') {
        return { ok: false, status: 403, text: async () => 'forbidden', json: async () => ({}) };
      }
      if (url.includes('/pullrequests?q=')) { lookups += 1; return { ok: true, status: 200, json: async () => ({ values: [] }) }; }
      return { ok: true, status: 200, json: async () => ({}) };
    };
    const prov = makeProv({}, fetchImpl);
    await assert.rejects(
      prov.proposeStandardsChange({
        branch: 'owlet-lens/learn-x', filePath: 'coding-standards.md',
        newContent: '# new', baseBranch: 'develop', title: 'T', body: 'B',
      }),
      /403/,
    );
    assert.equal(lookups, 0, 'a 403 must not trigger the duplicate-PR lookup');
  });

  it('capabilities.canProposeChanges is true', () => {
    assert.equal(makeProv().capabilities.canProposeChanges, true);
  });
});

module.exports = { baseEnv, makeProv };
