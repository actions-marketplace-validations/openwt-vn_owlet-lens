// @ts-check
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { detectProvider, makeProvider } = require('../../lib/providers/index.js');
const { ConfigError } = require('../../lib/errors.js');
const { BitbucketCloudReviewProvider } = require('../../lib/providers/bitbucket.js');

test('detectProvider: --provider=github wins', () => {
  assert.equal(detectProvider({ env: {}, cliFlag: 'github' }), 'github');
});

test('detectProvider: GITHUB_ACTIONS=true', () => {
  assert.equal(detectProvider({ env: { GITHUB_ACTIONS: 'true' } }), 'github');
});

test('detectProvider: throws when nothing detects', () => {
  assert.throws(() => detectProvider({ env: {} }), ConfigError);
});

test('detectProvider: rejects unknown provider name', () => {
  assert.throws(() => detectProvider({ env: {}, cliFlag: 'fake' }), ConfigError);
});

test('detectProvider: configValue=github used when no cli', () => {
  assert.equal(detectProvider({ env: {}, configValue: 'github' }), 'github');
});

test('detectProvider: --provider=bitbucket wins', () => {
  assert.equal(detectProvider({ env: {}, cliFlag: 'bitbucket' }), 'bitbucket');
});

test('detectProvider: auto-detects Bitbucket Pipelines via BITBUCKET_PIPELINE_UUID', () => {
  assert.equal(detectProvider({ env: { BITBUCKET_PIPELINE_UUID: '{abc}' } }), 'bitbucket');
});

test('detectProvider: configValue=bitbucket used when no cli', () => {
  assert.equal(detectProvider({ env: {}, configValue: 'bitbucket' }), 'bitbucket');
});

test('makeProvider: bitbucket returns BitbucketCloudReviewProvider', () => {
  const p = makeProvider('bitbucket', {
    config: { auth: { bitbucketToken: 't' } },
    env: { BITBUCKET_TOKEN: 't', BITBUCKET_WORKSPACE: 'ws', BITBUCKET_REPO_SLUG: 'repo', BITBUCKET_PR_ID: '1' },
    deps: { fetch: async () => ({}) },
  });
  assert.ok(p instanceof BitbucketCloudReviewProvider);
});

test('detectProvider: --provider=gitlab wins', () => {
  assert.equal(detectProvider({ env: {}, cliFlag: 'gitlab' }), 'gitlab');
});

test('detectProvider: GITLAB_CI=true auto-detects gitlab', () => {
  assert.equal(detectProvider({ env: { GITLAB_CI: 'true' } }), 'gitlab');
});

test('detectProvider: configValue=gitlab used when no cli', () => {
  assert.equal(detectProvider({ env: {}, configValue: 'gitlab' }), 'gitlab');
});

test('detectProvider: --provider=azure-devops wins', () => {
  assert.equal(detectProvider({ env: {}, cliFlag: 'azure-devops' }), 'azure-devops');
});

test('detectProvider: TF_BUILD=True auto-detects azure-devops', () => {
  assert.equal(detectProvider({ env: { TF_BUILD: 'True' } }), 'azure-devops');
});

test('detectProvider: configValue=azure-devops used when no cli', () => {
  assert.equal(detectProvider({ env: {}, configValue: 'azure-devops' }), 'azure-devops');
});

test('makeProvider: gitlab returns GitLabReviewProvider', () => {
  const { GitLabReviewProvider } = require('../../lib/providers/gitlab.js');
  const p = makeProvider('gitlab', {
    config: { auth: { gitlabToken: 't' } },
    env: { GITLAB_TOKEN: 't', CI_PROJECT_ID: '123', CI_MERGE_REQUEST_IID: '1' },
  });
  assert.ok(p instanceof GitLabReviewProvider);
});

test('makeProvider: azure-devops returns AzureDevOpsReviewProvider', () => {
  const { AzureDevOpsReviewProvider } = require('../../lib/providers/azure-devops.js');
  const p = makeProvider('azure-devops', {
    config: { auth: { azureToken: 't' } },
    env: {
      AZURE_DEVOPS_TOKEN: 't',
      AZURE_DEVOPS_ORG_URL: 'https://dev.azure.com/Org/',
      SYSTEM_TEAMPROJECT: 'Proj',
      BUILD_REPOSITORY_ID: 'repo-id',
      SYSTEM_PULLREQUEST_PULLREQUESTID: '1',
    },
  });
  assert.ok(p instanceof AzureDevOpsReviewProvider);
});
