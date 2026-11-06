// @ts-check
'use strict';

const { ConfigError } = require('../errors.js');
const { GitHubReviewProvider } = require('./github.js');
const { BitbucketCloudReviewProvider } = require('./bitbucket.js');
const { GitLabReviewProvider } = require('./gitlab.js');
const { AzureDevOpsReviewProvider } = require('./azure-devops.js');

const KNOWN_PROVIDERS = ['github', 'bitbucket', 'gitlab', 'azure-devops'];

/**
 * @param {string} name
 * @param {string} source
 * @returns {'github'|'bitbucket'|'gitlab'|'azure-devops'}
 */
function assertKnown(name, source) {
  if (!KNOWN_PROVIDERS.includes(name)) {
    const safe = String(name).slice(0, 50);
    throw new ConfigError(
      `Unknown provider '${safe}' from ${source}. Expected one of: ${KNOWN_PROVIDERS.join(', ')}`,
    );
  }
  // Narrowed by the KNOWN_PROVIDERS membership check above.
  return /** @type {'github'|'bitbucket'|'gitlab'|'azure-devops'} */ (name);
}

/**
 * @param {{ env: NodeJS.ProcessEnv, cliFlag?: string, configValue?: string }} opts
 * @returns {'github'|'bitbucket'|'gitlab'|'azure-devops'}
 */
function detectProvider({ env, cliFlag, configValue }) {
  if (cliFlag && cliFlag !== 'auto') return assertKnown(cliFlag, '--provider');
  if (configValue && configValue !== 'auto') return assertKnown(configValue, 'config.provider');
  if (env.GITHUB_ACTIONS === 'true') return 'github';
  if (env.BITBUCKET_PIPELINE_UUID || env.BITBUCKET_BUILD_NUMBER) return 'bitbucket';
  if (env.GITLAB_CI === 'true') return 'gitlab';
  if (env.TF_BUILD === 'True') return 'azure-devops';
  throw new ConfigError(
    'Cannot detect CI provider. Set --provider=github|bitbucket|gitlab|azure-devops or run in a supported CI environment.',
  );
}

/**
 * @param {string} name
 * @param {any} opts
 * @returns {import('./provider.types.js').IReviewProvider}
 */
function makeProvider(name, opts) {
  if (name === 'github') return new GitHubReviewProvider(opts);
  if (name === 'bitbucket') return new BitbucketCloudReviewProvider(opts);
  if (name === 'gitlab') return new GitLabReviewProvider(opts);
  if (name === 'azure-devops') return new AzureDevOpsReviewProvider(opts);
  throw new ConfigError(`Unknown provider: ${name}`);
}

module.exports = { detectProvider, makeProvider, KNOWN_PROVIDERS };
