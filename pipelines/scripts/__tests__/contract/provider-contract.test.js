'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { GitHubReviewProvider } = require('../../lib/providers/github.js');
const { InMemoryGitHub } = require('./in-memory-github.js');

function makeProvider(fake, { prefix = 'ai-review' } = {}) {
  return new GitHubReviewProvider({
    env: { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: `${fake.owner}/${fake.repo}`, GITHUB_REF: `refs/pull/${fake.prNumber}/head` },
    config: { markers: { prefix } },
    deps: {
      restClient: fake.restClient(),
      graphqlClient: fake.graphqlClient(),
      resolveDelays: [0, 0, 0],
    },
  });
}

test('contract: getPRMetadata', async () => {
  const fake = new InMemoryGitHub({ prNumber: 42 });
  const p = makeProvider(fake);
  const m = await p.getPRMetadata();
  assert.equal(m.id, '42');
  assert.equal(m.title, 'PR title');
});

test('contract: getDiff returns file list with mapped statuses', async () => {
  const fake = new InMemoryGitHub();
  fake.setFiles([
    { filename: 'a.ts', status: 'added', patch: 'p1' },
    { filename: 'b.ts', status: 'modified', patch: 'p2' },
  ]);
  const p = makeProvider(fake);
  const diff = await p.getDiff();
  assert.equal(diff.length, 2);
  assert.equal(diff[0].change, 'add');
  assert.equal(diff[1].change, 'modify');
});

test('contract: listThreads on empty PR returns []', async () => {
  const fake = new InMemoryGitHub();
  const p = makeProvider(fake);
  const threads = await p.listThreads();
  assert.deepEqual(threads, []);
});

test('contract: postThread → listThreads round-trip exposes new thread with active marker', async () => {
  const fake = new InMemoryGitHub();
  const p = makeProvider(fake);
  await p.postThread({
    filePath: 'a.ts', line: 5, body: '**[HIGH/security]** issue', status: 'active', ruleId: 'security:HIGH:xyz',
  });
  const threads = await p.listThreads();
  assert.equal(threads.length, 1);
  assert.equal(threads[0].status, 'active');
  assert.equal(threads[0].filePath, 'a.ts');
  assert.equal(threads[0].line, 5);
  assert.ok(threads[0].marker.fingerprint);
  assert.equal(threads[0].marker.version, 'v1');
});

test('contract: replyToThread appends comment observable in listThreads', async () => {
  const fake = new InMemoryGitHub();
  const seeded = fake.seedThread({
    path: 'a.ts', line: 1,
    body: '**[HIGH/security]** msg\n<!-- ai-review:v1:active -->\n<!-- ai-review:fingerprint=abcd1234abcd1234 -->',
  });
  const p = makeProvider(fake);
  await p.replyToThread(seeded.threadId, 'follow-up');
  const threads = await p.listThreads();
  const t = threads.find((x) => x.id === seeded.threadId);
  assert.ok(t);
  assert.equal(t.comments.length, 2);
  assert.equal(t.comments[1].body, 'follow-up');
});

test('contract: patchThreadStatus("fixed") posts marker reply and resolves thread', async () => {
  const fake = new InMemoryGitHub();
  const seeded = fake.seedThread({
    path: 'a.ts', line: 1,
    body: '**[HIGH/security]** msg\n<!-- ai-review:v1:active -->\n<!-- ai-review:fingerprint=abcd1234abcd1234 -->',
  });
  const p = makeProvider(fake);
  await p.patchThreadStatus(seeded.threadId, 'fixed');
  assert.equal(fake.threads.get(seeded.threadId).isResolved, true);
  assert.equal(fake.replies.length, 1);
  assert.ok(fake.replies[0].body.includes('<!-- ai-review:v1:fixed -->'));
  const threads = await p.listThreads();
  const t = threads.find((x) => x.id === seeded.threadId);
  assert.equal(t.status, 'fixed');
});

test('contract: patchThreadStatus("active") posts marker reply and unresolves thread', async () => {
  const fake = new InMemoryGitHub();
  const seeded = fake.seedThread({
    path: 'a.ts', line: 1,
    body: '**[HIGH/security]** msg\n<!-- ai-review:v1:fixed -->\n<!-- ai-review:fingerprint=abcd1234abcd1234 -->',
    isResolved: true,
  });
  const p = makeProvider(fake);
  await p.patchThreadStatus(seeded.threadId, 'active');
  assert.equal(fake.threads.get(seeded.threadId).isResolved, false);
  assert.ok(fake.replies[0].body.includes('<!-- ai-review:v1:active -->'));
});

test('contract: upsertSummaryComment creates first time, updates second time', async () => {
  const fake = new InMemoryGitHub();
  const p = makeProvider(fake);
  const r1 = await p.upsertSummaryComment('summary', 'BODY1\n<!-- ai-review:v1:summary -->');
  assert.equal(r1.action, 'created');
  assert.equal(fake.summaryCreates.length, 1);
  const r2 = await p.upsertSummaryComment('summary', 'BODY2\n<!-- ai-review:v1:summary -->');
  assert.equal(r2.action, 'updated');
  assert.equal(fake.summaryUpdates.length, 1);
  assert.equal(fake.summaryUpdates[0].body, 'BODY2\n<!-- ai-review:v1:summary -->');
});

test('contract: full review cycle — post → list → close → list', async () => {
  const fake = new InMemoryGitHub();
  const p = makeProvider(fake);
  const post = await p.postThread({
    filePath: 'a.ts', line: 1, body: '**[HIGH/security]** msg', status: 'active', ruleId: 'r',
  });
  let threads = await p.listThreads();
  assert.equal(threads.length, 1);
  assert.equal(threads[0].status, 'active');

  await p.patchThreadStatus(threads[0].id, 'fixed');
  threads = await p.listThreads();
  assert.equal(threads.length, 1);
  assert.equal(threads[0].status, 'fixed');

  await p.patchThreadStatus(threads[0].id, 'active');
  threads = await p.listThreads();
  assert.equal(threads[0].status, 'active');
});

test('contract: patchThreadStatus("fixed") soft-succeeds when resolve hits FORBIDDEN scope error', async () => {
  const fake = new InMemoryGitHub();
  const seeded = fake.seedThread({
    path: 'a.ts', line: 1,
    body: '**[HIGH/security]** msg\n<!-- ai-review:v1:active -->\n<!-- ai-review:fingerprint=abcd1234abcd1234 -->',
  });

  // Wrap graphql client: pass through everything except resolveReviewThread (which throws FORBIDDEN).
  const realGraphql = fake.graphqlClient();
  const wrappedGraphql = async (query, vars) => {
    if (query.includes('resolveReviewThread') && !query.includes('unresolveReviewThread')) {
      const err = new Error('Request failed due to following response errors:\n - Resource not accessible by integration');
      err.name = 'GraphqlResponseError';
      err.errors = [{ type: 'FORBIDDEN' }];
      throw err;
    }
    return realGraphql(query, vars);
  };

  const provider = new GitHubReviewProvider({
    env: { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: `${fake.owner}/${fake.repo}`, GITHUB_REF: `refs/pull/${fake.prNumber}/head` },
    config: { markers: { prefix: 'ai-review' } },
    deps: { restClient: fake.restClient(), graphqlClient: wrappedGraphql, resolveDelays: [0, 0, 0] },
  });

  const stderr = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (s) => { stderr.push(String(s)); return true; };

  try {
    await provider.patchThreadStatus(seeded.threadId, 'fixed');
  } finally {
    process.stderr.write = origWrite;
  }

  // Soft-success: no throw, marker reply posted, warn log emitted.
  assert.equal(fake.replies.length, 1);
  assert.ok(fake.replies[0].body.includes('<!-- ai-review:v1:fixed -->'));
  const warnLog = stderr.find((s) => s.includes('"level":"warn"') && s.includes('resolve'));
  assert.ok(warnLog, 'warn log emitted for scope error');
  assert.ok(warnLog.includes('skipped (token scope insufficient)'));
});

test('contract: patchThreadStatus("active") soft-succeeds when unresolve hits FORBIDDEN scope error', async () => {
  const fake = new InMemoryGitHub();
  const seeded = fake.seedThread({
    path: 'a.ts', line: 1,
    body: '**[HIGH/security]** msg\n<!-- ai-review:v1:fixed -->\n<!-- ai-review:fingerprint=abcd1234abcd1234 -->',
    isResolved: true,
  });

  const realGraphql = fake.graphqlClient();
  const wrappedGraphql = async (query, vars) => {
    if (query.includes('unresolveReviewThread')) {
      const err = new Error('Resource not accessible by integration');
      err.name = 'GraphqlResponseError';
      err.errors = [{ type: 'FORBIDDEN' }];
      throw err;
    }
    return realGraphql(query, vars);
  };

  const provider = new GitHubReviewProvider({
    env: { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: `${fake.owner}/${fake.repo}`, GITHUB_REF: `refs/pull/${fake.prNumber}/head` },
    config: { markers: { prefix: 'ai-review' } },
    deps: { restClient: fake.restClient(), graphqlClient: wrappedGraphql, resolveDelays: [0, 0, 0] },
  });

  const stderr = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (s) => { stderr.push(String(s)); return true; };
  try {
    await provider.patchThreadStatus(seeded.threadId, 'active');
  } finally {
    process.stderr.write = origWrite;
  }
  assert.ok(fake.replies[0].body.includes('<!-- ai-review:v1:active -->'));
  const warnLog = stderr.find((s) => s.includes('"level":"warn"') && s.includes('unresolve'));
  assert.ok(warnLog, 'warn log emitted for scope error');
  assert.ok(warnLog.includes('skipped (token scope insufficient)'));
});

test('contract: patchThreadStatus still throws when resolve fails with non-scope error', async () => {
  const fake = new InMemoryGitHub();
  const seeded = fake.seedThread({
    path: 'a.ts', line: 1,
    body: '**[HIGH/security]** msg\n<!-- ai-review:v1:active -->\n<!-- ai-review:fingerprint=abcd1234abcd1234 -->',
  });

  const realGraphql = fake.graphqlClient();
  const wrappedGraphql = async (query, vars) => {
    if (query.includes('resolveReviewThread') && !query.includes('unresolveReviewThread')) {
      const err = new Error('500 Internal Server Error');
      err.name = 'GraphqlResponseError';
      throw err;
    }
    return realGraphql(query, vars);
  };

  const provider = new GitHubReviewProvider({
    env: { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: `${fake.owner}/${fake.repo}`, GITHUB_REF: `refs/pull/${fake.prNumber}/head` },
    config: { markers: { prefix: 'ai-review' } },
    deps: { restClient: fake.restClient(), graphqlClient: wrappedGraphql, resolveDelays: [0, 0, 0] },
  });

  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = () => true;
  let thrown = null;
  try {
    await provider.patchThreadStatus(seeded.threadId, 'fixed');
  } catch (e) { thrown = e; } finally {
    process.stderr.write = origWrite;
  }
  assert.ok(thrown, 'should throw on non-scope error');
  assert.ok(thrown.message.includes('partial failure'));
});
