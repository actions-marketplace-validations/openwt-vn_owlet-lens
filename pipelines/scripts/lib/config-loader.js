// @ts-check
'use strict';

const { DEFAULTS, mergeConfig } = require('./config-merge.js');
const { validateConfig } = require('./config-validate.js');

/**
 * Load layered config: defaults -> file -> env -> CLI.
 *
 * @param {{
 *   cwd: string,
 *   env: NodeJS.ProcessEnv,
 *   cliFlags: { provider?: string, configPath?: string },
 *   onWarn?: (msg: string) => void,
 * }} opts
 */
function loadConfig(opts) {
  const onWarn = opts.onWarn ?? (() => {});
  const { merged, unresolvedByPath } = mergeConfig({ ...opts, onWarn });
  return validateConfig({ merged, env: opts.env, unresolvedByPath, onWarn });
}

module.exports = { loadConfig, DEFAULTS };
