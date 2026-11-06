'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { GitHubReviewProvider } = require('../../lib/providers/github.js');

/**
 * The read side of the TL gate's sticky note. Unlike every other marker lookup
 * in the adapter, this one has to know whether a human edited the note after
 * the bot wrote it — "Anyone with write access to a repository can edit
 * comments" — so it goes over GraphQL (`editor`) and reports the verdict
 * instead of deciding it.
 */

const BOT = 'app[bot]';
const NOTE = '<!-- ai-review:v1:tl-gate -->';

function node({
  id = 1,
  body = NOTE,
  author = BOT,
  editor = null,
  createdAt = '2026-10-01T00:00:00Z',
} = {}) {
  return {
    databaseId: id,
    body,
    createdAt,
    author: { login: author },
    editor: editor ? { login: editor } : null,
  };
}

function page(nodes, { hasNextPage = false, endCursor = null } = {}) {
  return {
    repository: {
      pullRequest: {
        comments: { nodes, pageInfo: { hasNextPage, endCursor } },
      },
    },
  };
}

function makeProvider(pages) {
  const queries = [];
  let i = 0;
  const graphqlClient = async (query, vars) => {
    queries.push({ query, vars });
    return pages[Math.min(i++, pages.length - 1)];
  };
  const provider = new GitHubReviewProvider({
    config: { auth: { token: 'tok' } },
    env: { GITHUB_TOKEN: 'tok', GITHUB_REPOSITORY: 'o/r', GITHUB_PR_NUMBER: '9' },
    deps: {
      restClient: {
        repos: {},
        pulls: {
          listReviewComments: async () => ({ data: [] }),
          get: async () => ({ data: { number: 9 } }),
        },
      },
      graphqlClient,
      resolveDelays: [0],
    },
  });
  return { provider, queries };
}

test('findBotComment: returns the bot note that carries the key marker', async () => {
  const { provider } = makeProvider([page([node({ id: 42, body: `AI review is on.\n\n${NOTE}` })])]);
  const found = await provider.findBotComment('tl-gate');
  assert.equal(found.id, '42');
  assert.equal(found.createdAt, '2026-10-01T00:00:00Z');
  assert.equal(found.editedByOther, false);
});

test('findBotComment: asks for editor, because REST cannot say who edited a comment', async () => {
  const { provider, queries } = makeProvider([page([])]);
  await provider.findBotComment('tl-gate');
  assert.match(queries[0].query, /editor/);
});

test('findBotComment: a human comment with the same marker is not the bot note', async () => {
  const { provider } = makeProvider([page([node({ author: 'ada', body: `${NOTE} I turned this off.` })])]);
  assert.equal(await provider.findBotComment('tl-gate'), null);
});

test('findBotComment: the bot note for another key does not satisfy tl-gate', async () => {
  const { provider } = makeProvider([page([node({ body: '<!-- ai-review:v1:summary -->' })])]);
  assert.equal(await provider.findBotComment('tl-gate'), null);
});

test('findBotComment: a longer key sharing the prefix does not match tl-gate', async () => {
  const { provider } = makeProvider([page([node({ body: '<!-- ai-review:v1:tl-gate-off -->' })])]);
  assert.equal(await provider.findBotComment('tl-gate'), null);
});

test('findBotComment: reports a human edit so the caller can refuse the note', async () => {
  const { provider } = makeProvider([page([node({ editor: 'mallory' })])]);
  const found = await provider.findBotComment('tl-gate');
  assert.equal(found.editedByOther, true);
});

test('findBotComment: the bot editing its own note is not an edit by someone else', async () => {
  const { provider } = makeProvider([page([node({ editor: BOT })])]);
  assert.equal((await provider.findBotComment('tl-gate')).editedByOther, false);
});

test('findBotComment: a bot login without the [bot] suffix still counts as the bot', async () => {
  const { provider } = makeProvider([page([node({ author: 'acme-ai-bot' })])]);
  assert.equal((await provider.findBotComment('tl-gate')).id, '1');
});

test('findBotComment: pages past the first 100 comments to find the note', async () => {
  const { provider, queries } = makeProvider([
    page([node({ id: 1, body: 'chatter' })], { hasNextPage: true, endCursor: 'CUR1' }),
    page([node({ id: 2, body: 'more chatter' })], { hasNextPage: true, endCursor: 'CUR2' }),
    page([node({ id: 3 })]),
  ]);
  assert.equal((await provider.findBotComment('tl-gate')).id, '3');
  assert.equal(queries.length, 3);
  assert.equal(queries[0].vars.after, null);
  assert.equal(queries[1].vars.after, 'CUR1');
  assert.equal(queries[2].vars.after, 'CUR2');
});

test('findBotComment: returns null when no comment on the PR carries the marker', async () => {
  const { provider } = makeProvider([page([node({ body: 'plain talk' })])]);
  assert.equal(await provider.findBotComment('tl-gate'), null);
});

test('findBotComment: survives a GraphQL response with no comments connection', async () => {
  const { provider } = makeProvider([{ repository: { pullRequest: null } }]);
  assert.equal(await provider.findBotComment('tl-gate'), null);
});

test('findBotComment: stops instead of looping when the cursor stops advancing', async () => {
  const { provider, queries } = makeProvider([
    page([node({ body: 'chatter' })], { hasNextPage: true, endCursor: 'CUR1' }),
    page([node({ body: 'chatter' })], { hasNextPage: true, endCursor: 'CUR1' }),
  ]);
  assert.equal(await provider.findBotComment('tl-gate'), null);
  assert.equal(queries.length, 2);
});
