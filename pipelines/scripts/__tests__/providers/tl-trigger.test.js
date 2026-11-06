// @ts-check
'use strict';

/**
 * Per-provider TL-gate platform facts, each driven by a fake CI env (ADR-0012:
 * reading the environment is the provider's job, the gate just consumes the
 * result). Every provider must answer the same three questions identically:
 * was this run pressed, by whom (an id, never a username), and how would a lead
 * press it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { GitHubReviewProvider } = require('../../lib/providers/github.js');
const { GitLabReviewProvider } = require('../../lib/providers/gitlab.js');
const { BitbucketCloudReviewProvider } = require('../../lib/providers/bitbucket.js');
const { AzureDevOpsReviewProvider } = require('../../lib/providers/azure-devops.js');
const { TL_PRESS_ENV, tlPressSet } = require('../../lib/providers/provider.types.js');

// --- GitHub ------------------------------------------------------------------

function github(env, overrides = {}) {
  const calls = [];
  const rest = {
    users: {
      getByUsername: async ({ username }) => {
        calls.push({ username });
        return { data: overrides.user ?? { id: 900, login: username, name: 'Ada L' } };
      },
    },
  };
  const p = new GitHubReviewProvider({
    config: { auth: { token: 'tok' }, markers: { prefix: 'ai-review' } },
    env: { GITHUB_TOKEN: 'tok', GITHUB_REPOSITORY: 'o/r', GITHUB_PR_NUMBER: '7', ...env },
    deps: { restClient: rest, graphqlClient: async () => ({}), resolveDelays: [0] },
  });
  return { p, calls };
}

test('github trigger: a first-attempt pull_request run is not a press', async () => {
  const { p, calls } = github({ GITHUB_EVENT_NAME: 'pull_request', GITHUB_RUN_ATTEMPT: '1' });
  const t = await p.getTriggerInfo();
  assert.equal(t.manual, false);
  assert.equal(t.actorId, null);
  assert.deepEqual(calls, [], 'no user lookup on a push');
});

test('github trigger: an absent GITHUB_RUN_ATTEMPT means the first attempt', async () => {
  const { p } = github({ GITHUB_EVENT_NAME: 'pull_request' });
  assert.equal((await p.getTriggerInfo()).manual, false);
});

test('github trigger: attempt > 1 on pull_request is the "Re-run all jobs" press', async () => {
  const { p } = github({
    GITHUB_EVENT_NAME: 'pull_request', GITHUB_RUN_ATTEMPT: '2', GITHUB_TRIGGERING_ACTOR: 'ada',
  });
  const t = await p.getTriggerInfo();
  assert.equal(t.manual, true);
  assert.equal(t.actorId, '900', 'the login is resolved to the durable numeric id');
  assert.equal(t.actorLabel, 'Ada L');
});

test('github trigger: a /review comment re-run is NOT a press (its event is not pull_request)', async () => {
  const { p } = github({
    GITHUB_EVENT_NAME: 'issue_comment', GITHUB_RUN_ATTEMPT: '2', GITHUB_TRIGGERING_ACTOR: 'ada',
  });
  const t = await p.getTriggerInfo();
  assert.equal(t.manual, false, 'the /review comment must never be able to turn the AI on');
  assert.equal(t.actorId, null);
});

test('github trigger: a push-triggered run cannot be a press whatever the attempt says', async () => {
  const { p } = github({ GITHUB_EVENT_NAME: 'push', GITHUB_RUN_ATTEMPT: '3' });
  assert.equal((await p.getTriggerInfo()).manual, false);
});

test('github trigger: an unresolvable login yields a press with no id, never a trusted one', async () => {
  const rest = { users: { getByUsername: async () => { throw new Error('404 Not Found'); } } };
  const p = new GitHubReviewProvider({
    config: { auth: { token: 'tok' } },
    env: {
      GITHUB_TOKEN: 'tok', GITHUB_REPOSITORY: 'o/r', GITHUB_PR_NUMBER: '7',
      GITHUB_EVENT_NAME: 'pull_request', GITHUB_RUN_ATTEMPT: '2', GITHUB_TRIGGERING_ACTOR: 'ghost',
    },
    deps: { restClient: rest, graphqlClient: async () => ({}), resolveDelays: [0] },
  });
  const t = await p.getTriggerInfo();
  assert.equal(t.manual, true);
  assert.equal(t.actorId, null, 'the gate treats a missing id as "not a team lead"');
});

test('github trigger: howToTurnOn names GitHub\u2019s own re-run button', async () => {
  const { p } = github({ GITHUB_EVENT_NAME: 'pull_request' });
  assert.match((await p.getTriggerInfo()).howToTurnOn, /Re-run all jobs/);
});

// --- GitLab ------------------------------------------------------------------

function gitlab(env) {
  return new GitLabReviewProvider({
    config: { auth: { gitlabToken: 't' }, markers: { prefix: 'ai-review' } },
    env: {
      GITLAB_TOKEN: 'glpat-t', CI_PROJECT_ID: '42', CI_MERGE_REQUEST_IID: '10', ...env,
    },
    deps: { fetch: async () => { throw new Error('no network'); }, sleep: async () => {} },
  });
}

test('gitlab trigger: a push pipeline is not a press', async () => {
  const p = gitlab({ GITLAB_USER_ID: '77', GITLAB_USER_LOGIN: 'ada' });
  const t = await p.getTriggerInfo();
  assert.equal(t.manual, false, 'CI_JOB_MANUAL is only set for a job a human started');
  assert.equal(t.actorId, null);
});

test('gitlab trigger: CI_JOB_MANUAL=true is the manual-job press', async () => {
  const p = gitlab({ CI_JOB_MANUAL: 'true', GITLAB_USER_ID: '77', GITLAB_USER_LOGIN: 'ada' });
  const t = await p.getTriggerInfo();
  assert.equal(t.manual, true);
  assert.equal(t.actorId, '77', 'the numeric user id, not the login');
  assert.equal(t.actorLabel, 'ada');
});

test('gitlab trigger: CI_JOB_MANUAL is case-insensitive, and "false" is not a press', async () => {
  assert.equal((await gitlab({ CI_JOB_MANUAL: 'True' }).getTriggerInfo()).manual, true);
  assert.equal((await gitlab({ CI_JOB_MANUAL: 'false' }).getTriggerInfo()).manual, false);
});

test('gitlab trigger: a press with no GITLAB_USER_ID reports no id rather than an empty-string match', async () => {
  const t = await gitlab({ CI_JOB_MANUAL: 'true' }).getTriggerInfo();
  assert.equal(t.manual, true);
  assert.equal(t.actorId, null);
});

test('gitlab trigger: a missing GITLAB_USER_LOGIN still yields the id', async () => {
  const t = await gitlab({ CI_JOB_MANUAL: 'true', GITLAB_USER_ID: '77' }).getTriggerInfo();
  assert.equal(t.actorId, '77');
  assert.equal(t.actorLabel, null);
});

// --- Bitbucket ---------------------------------------------------------------

function bitbucket(env, routes = {}) {
  const fakeFetch = async (url) => {
    for (const [frag, json] of Object.entries(routes)) {
      if (url.includes(frag)) {
        return { ok: true, status: 200, json: async () => json, text: async () => '', headers: { get: () => null } };
      }
    }
    throw new Error(`fakeFetch: no route for ${url}`);
  };
  const p = new BitbucketCloudReviewProvider({
    config: { auth: { bitbucketToken: 'tok' }, markers: { prefix: 'ai-review' } },
    env: {
      BITBUCKET_TOKEN: 'tok', BITBUCKET_WORKSPACE: 'ws', BITBUCKET_REPO_SLUG: 'repo', BITBUCKET_PR_ID: '7', ...env,
    },
    deps: { fetch: fakeFetch, sleep: async () => {} },
  });
  return p;
}

test('bitbucket trigger: the triggerer UUID alone is NOT a press (it is set in the automatic step too)', async () => {
  const p = bitbucket({ BITBUCKET_STEP_TRIGGERER_UUID: '{abc-123}' });
  const t = await p.getTriggerInfo();
  assert.equal(t.manual, false, 'only the manual step\u2019s own AI_REVIEW_TL_PRESSED marks a press');
  assert.equal(t.actorId, null);
});

test('bitbucket trigger: the manual step\u2019s variable plus the triggerer UUID is a press', async () => {
  const p = bitbucket(
    { AI_REVIEW_TL_PRESSED: 'true', BITBUCKET_STEP_TRIGGERER_UUID: '{abc-123}' },
    { '/users/': { uuid: '{abc-123}', display_name: 'Ada' } },
  );
  const t = await p.getTriggerInfo();
  assert.equal(t.manual, true);
  assert.equal(t.actorId, '{abc-123}', 'the braces are kept; the gate normalises both sides');
  assert.equal(t.actorLabel, 'Ada');
});

test('bitbucket trigger: a failed account lookup keeps the id and drops the name', async () => {
  const p = bitbucket({ AI_REVIEW_TL_PRESSED: 'true', BITBUCKET_STEP_TRIGGERER_UUID: '{abc-123}' });
  const t = await p.getTriggerInfo();
  assert.equal(t.manual, true);
  assert.equal(t.actorId, '{abc-123}');
  assert.equal(t.actorLabel, null);
});

test('bitbucket trigger: a press with no triggerer UUID reports no id', async () => {
  const p = bitbucket({ AI_REVIEW_TL_PRESSED: 'true' });
  const t = await p.getTriggerInfo();
  assert.equal(t.manual, true);
  assert.equal(t.actorId, null);
});

// --- Azure DevOps ------------------------------------------------------------

function azure(env) {
  const fakeFetch = async () => {
    throw new Error('no network');
  };
  return new AzureDevOpsReviewProvider({
    config: { auth: { azureToken: 'pat' }, markers: { prefix: 'ai-review' } },
    env: {
      AZURE_DEVOPS_TOKEN: 'pat', SYSTEM_COLLECTIONURI: 'https://dev.azure.com/org',
      SYSTEM_TEAMPROJECT: 'Proj', BUILD_REPOSITORY_ID: 'repo-guid',
      SYSTEM_PULLREQUEST_PULLREQUESTID: '42', ...env,
    },
    deps: { fetch: fakeFetch, sleep: async () => {} },
  });
}

test('azure trigger: an automatic PR build is not a press', async () => {
  const p = azure({ BUILD_REASON: 'PullRequest', BUILD_REQUESTEDFORID: '{guid-1}' });
  const t = await p.getTriggerInfo();
  assert.equal(t.manual, false, 'Build.Reason alone cannot tell the press from a push');
  assert.equal(t.actorId, null);
});

test('azure trigger: the pipeline\u2019s own AI_REVIEW_TL_PRESSED is the press', async () => {
  const p = azure({
    AI_REVIEW_TL_PRESSED: 'true', BUILD_REQUESTEDFORID: '{GUID-1}', BUILD_REQUESTEDFOR: 'Ada',
  });
  const t = await p.getTriggerInfo();
  assert.equal(t.manual, true);
  assert.equal(t.actorId, '{GUID-1}');
  assert.equal(t.actorLabel, 'Ada');
});

test('azure trigger: Build.QueuedById is the fallback when RequestedForId is absent', async () => {
  const p = azure({ AI_REVIEW_TL_PRESSED: 'true', BUILD_QUEUEDBYID: '{guid-2}', BUILD_QUEUEDBY: 'Bob' });
  const t = await p.getTriggerInfo();
  assert.equal(t.actorId, '{guid-2}');
  assert.equal(t.actorLabel, 'Bob');
});

test('azure trigger: a press with neither identity reports no id', async () => {
  const p = azure({ AI_REVIEW_TL_PRESSED: 'true' });
  const t = await p.getTriggerInfo();
  assert.equal(t.manual, true);
  assert.equal(t.actorId, null);
});

test('azure trigger: howToTurnOn names the manual policy build', async () => {
  assert.match((await azure({}).getTriggerInfo()).howToTurnOn, /polic/i);
});

// --- shared ------------------------------------------------------------------

test('TL_PRESS_ENV is one name for every platform', () => {
  assert.equal(TL_PRESS_ENV, 'AI_REVIEW_TL_PRESSED');
});

test('tlPressSet accepts only affirmative values, so a template cannot open the gate by accident', () => {
  assert.equal(tlPressSet({ AI_REVIEW_TL_PRESSED: 'true' }), true);
  assert.equal(tlPressSet({ AI_REVIEW_TL_PRESSED: 'TRUE' }), true);
  assert.equal(tlPressSet({ AI_REVIEW_TL_PRESSED: ' 1 ' }), true);
  assert.equal(tlPressSet({ AI_REVIEW_TL_PRESSED: 'yes' }), true);
  assert.equal(tlPressSet({ AI_REVIEW_TL_PRESSED: 'false' }), false);
  assert.equal(tlPressSet({ AI_REVIEW_TL_PRESSED: '0' }), false);
  assert.equal(tlPressSet({ AI_REVIEW_TL_PRESSED: 'no' }), false);
  assert.equal(tlPressSet({ AI_REVIEW_TL_PRESSED: '' }), false);
  assert.equal(tlPressSet({}), false);
  assert.equal(tlPressSet({ AI_REVIEW_TL_PRESSED: 'true but only for the review job' }), false);
});

test('every provider answers the same TriggerInfo shape', async () => {
  const infos = await Promise.all([
    github({ GITHUB_EVENT_NAME: 'pull_request' }).p.getTriggerInfo(),
    gitlab({}).getTriggerInfo(),
    bitbucket({}).getTriggerInfo(),
    azure({}).getTriggerInfo(),
  ]);
  for (const t of infos) {
    assert.equal(typeof t.manual, 'boolean');
    assert.ok('actorId' in t);
    assert.ok('actorLabel' in t);
    assert.equal(typeof t.howToTurnOn, 'string');
    assert.ok(t.howToTurnOn.length > 0, 'a held-back PR must be told how to turn the AI on');
  }
});
