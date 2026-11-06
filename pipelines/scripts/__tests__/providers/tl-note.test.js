'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { GitLabReviewProvider } = require('../../lib/providers/gitlab.js');
const { BitbucketCloudReviewProvider } = require('../../lib/providers/bitbucket.js');
const { AzureDevOpsReviewProvider } = require('../../lib/providers/azure-devops.js');

/**
 * Finding the "AI on" note on the three platforms that need no GraphQL. The gate
 * opens when this returns the bot's own comment carrying the `tl-on` marker, so
 * a lookup that quietly finds nothing holds every PR back forever, and one that
 * finds the wrong comment opens the gate without a press. GitHub's equivalent is
 * in `github.find-bot-comment.test.js`.
 */

const NOTE = '### AI code review: on\n\n<!-- ai-review:v1:tl-gate -->\n<!-- ai-review:v1:tl-on -->';
const WAITING = '### AI code review: waiting for a team lead\n\n<!-- ai-review:v1:tl-gate -->';

function json(json_, extra = {}) {
  return {
    ok: true,
    status: 200,
    json: async () => json_,
    text: async () => '',
    headers: { get: () => null },
    ...extra,
  };
}

// --- GitLab -------------------------------------------------------------------

function gitlab(notes) {
  return new GitLabReviewProvider({
    config: { auth: { gitlabToken: 't' }, markers: { prefix: 'ai-review' } },
    env: { GITLAB_TOKEN: 't', CI_PROJECT_ID: '42', CI_MERGE_REQUEST_IID: '10' },
    deps: {
      fetch: async (url) => {
        if (url.includes('/notes')) return json(notes);
        throw new Error(`unexpected fetch: ${url}`);
      },
      sleep: async () => {},
    },
  });
}

const botNote = (over = {}) => ({ id: 501, body: NOTE, created_at: '2026-10-01T00:00:00Z', author: { username: 'ci-bot', bot: true }, ...over });

test('gitlab findBotComment: finds the bot note carrying tl-on', async () => {
  const found = await gitlab([{ id: 1, body: 'unrelated', author: { username: 'ada' } }, botNote()]).findBotComment('tl-on');
  assert.equal(found.id, '501');
  assert.equal(found.createdAt, '2026-10-01T00:00:00Z');
  assert.equal(found.editedByOther, false);
});

test('gitlab findBotComment: the waiting comment does not satisfy tl-on', async () => {
  const p = gitlab([{ id: 1, body: WAITING, author: { username: 'ci-bot', bot: true } }]);
  assert.equal(await p.findBotComment('tl-on'), null);
  assert.ok(await p.findBotComment('tl-gate'), 'it is still the shared slot');
});

test('gitlab findBotComment: a human note with the same marker does not count', async () => {
  const p = gitlab([{ id: 1, body: NOTE, author: { username: 'ada' } }]);
  assert.equal(await p.findBotComment('tl-on'), null);
});

// --- Bitbucket ----------------------------------------------------------------

function bitbucket(values) {
  return new BitbucketCloudReviewProvider({
    config: { auth: { bitbucketToken: 'tok' }, markers: { prefix: 'ai-review' } },
    env: { BITBUCKET_TOKEN: 'tok', BITBUCKET_WORKSPACE: 'ws', BITBUCKET_REPO_SLUG: 'repo', BITBUCKET_PR_ID: '7' },
    deps: {
      fetch: async (url) => {
        if (url.includes('/comments')) return json({ values });
        throw new Error(`unexpected fetch: ${url}`);
      },
      sleep: async () => {},
    },
  });
}

const bbComment = (over = {}) => ({ id: 900, content: { raw: NOTE }, created_on: '2026-10-01T00:00:00Z', user: { account_id: '{bot-1}' }, ...over });

test('bitbucket findBotComment: finds the bot note carrying tl-on', async () => {
  const found = await bitbucket([
    { id: 1, content: { raw: 'chatter' }, user: { account_id: '{ada}' } },
    bbComment(),
  ]).findBotComment('tl-on');
  assert.equal(found.id, '900');
  assert.equal(found.createdAt, '2026-10-01T00:00:00Z');
  assert.equal(found.editedByOther, false);
});

test('bitbucket findBotComment: the waiting comment does not satisfy tl-on', async () => {
  const p = bitbucket([bbComment({ content: { raw: WAITING } })]);
  assert.equal(await p.findBotComment('tl-on'), null);
});

test('bitbucket findBotComment: a deleted note is not found', async () => {
  const p = bitbucket([bbComment({ deleted: true })]);
  assert.equal(await p.findBotComment('tl-on'), null);
});

test('bitbucket findBotComment: a human comment is not the note once the bot account is known', async () => {
  // Two bot comments fix the bot account; the human's paste is then not "ours".
  const p = bitbucket([
    bbComment({ id: 1, content: { raw: 'finding one <!-- ai-review:v1:active -->' } }),
    bbComment({ id: 2, content: { raw: 'finding two <!-- ai-review:v1:fixed -->' } }),
    { id: 3, content: { raw: NOTE }, user: { account_id: '{ada}' } },
  ]);
  assert.equal(await p.findBotComment('tl-on'), null);
});

// --- Azure DevOps -------------------------------------------------------------

function azure(threads) {
  return new AzureDevOpsReviewProvider({
    config: { auth: { azureToken: 'pat' }, markers: { prefix: 'ai-review' } },
    env: {
      AZURE_DEVOPS_TOKEN: 'pat',
      SYSTEM_COLLECTIONURI: 'https://dev.azure.com/org',
      SYSTEM_TEAMPROJECT: 'Proj',
      BUILD_REPOSITORY_ID: 'repo-guid',
      SYSTEM_PULLREQUEST_PULLREQUESTID: '42',
    },
    deps: {
      fetch: async (url) => {
        if (url.includes('connectionData')) {
          return json({ authenticatedUser: { id: '{bot-1}', displayName: 'AI Bot' } });
        }
        if (url.includes('/threads')) return json({ value: threads });
        throw new Error(`unexpected fetch: ${url}`);
      },
      sleep: async () => {},
    },
  });
}

const azThread = (over = {}) => ({
  id: 77,
  comments: [{ id: 7001, content: NOTE, publishedDate: '2026-10-01T00:00:00Z', author: { id: '{bot-1}' } }],
  ...over,
});

test('azure findBotComment: finds the bot note carrying tl-on', async () => {
  const found = await azure([azThread()]).findBotComment('tl-on');
  assert.equal(found.id, '7001');
  assert.equal(found.createdAt, '2026-10-01T00:00:00Z');
  assert.equal(found.editedByOther, false);
});

test('azure findBotComment: the waiting comment does not satisfy tl-on', async () => {
  const p = azure([azThread({ comments: [{ id: 7001, content: WAITING, author: { id: '{bot-1}' } }] })]);
  assert.equal(await p.findBotComment('tl-on'), null);
});

test('azure findBotComment: a review thread is skipped, since the note is a PR-level thread', async () => {
  const p = azure([azThread({
    id: 78,
    threadContext: { filePath: '/src/a.js' },
    comments: [{ id: 7002, content: NOTE, author: { id: '{bot-1}' } }],
  })]);
  assert.equal(await p.findBotComment('tl-on'), null);
});

test('azure findBotComment: a deleted root comment is skipped', async () => {
  const p = azure([azThread({
    comments: [
      { id: 7001, content: NOTE, isDeleted: true, author: { id: '{bot-1}' } },
      { id: 7002, content: NOTE, author: { id: '{bot-1}' } },
    ],
  })]);
  assert.equal((await p.findBotComment('tl-on')).id, '7002');
});

test('azure findBotComment: a human note is not the note', async () => {
  const p = azure([azThread({ comments: [{ id: 7001, content: NOTE, author: { id: '{ada}' } }] })]);
  assert.equal(await p.findBotComment('tl-on'), null);
});

test('the on-state key is a marker key markers.js recognises, and not the slot', () => {
  const { ON_KEY, GATE_KEY } = require('../../lib/port/tl-gate.js');
  assert.notEqual(ON_KEY, GATE_KEY, 'the slot is on every gate comment; it must not mean "on"');
  assert.match(ON_KEY, /^[a-z][a-z0-9-]*$/,
    'markers.js only recognises this shape, and Bitbucket detects the bot by marker presence');
});
