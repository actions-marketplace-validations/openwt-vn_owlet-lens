// @ts-check
'use strict';

const fs = require('node:fs');
const { safeMsg } = require('../log-safe.js');

const KEY_PREFIX = 'ai-review-state-v1';

function _buildKey({ repoId, prNum, runId }) {
  return `${KEY_PREFIX}-${repoId}-pr-${prNum}-${runId}`;
}

function _restorePrefix({ repoId, prNum }) {
  return `${KEY_PREFIX}-${repoId}-pr-${prNum}-`;
}

function _warn(stage, fields) {
  process.stderr.write(JSON.stringify({
    level: 'warn',
    msg: `cache-port.${stage}`,
    ...fields,
  }) + '\n');
}

function _info(stage, fields) {
  process.stderr.write(JSON.stringify({
    level: 'info',
    msg: `cache-port.${stage}`,
    ...fields,
  }) + '\n');
}

function _resolveClient(injected) {
  if (injected) return injected;
  return require('@actions/cache');
}

/**
 * @param {{
 *   stateRoot: string,
 *   repoId: string|number|undefined,
 *   prNum: number|null,
 *   env: NodeJS.ProcessEnv,
 *   cacheClient?: { restoreCache: Function, saveCache: Function },
 * }} opts
 * @returns {Promise<{ hit: boolean, key: string|null }>}
 */
async function restore(opts) {
  const { stateRoot, repoId, prNum, env, cacheClient } = opts;
  if (env.GITHUB_ACTIONS !== 'true') return { hit: false, key: null };
  if (repoId == null || repoId === '' || prNum == null) {
    _warn('restore', { detail: 'skipped (repoId or prNum missing)', repoId: repoId ?? null, prNum: prNum ?? null });
    return { hit: false, key: null };
  }
  const prefix = _restorePrefix({ repoId, prNum });
  try {
    const client = _resolveClient(cacheClient);
    // Pass prefix as primaryKey; no exact match exists (real keys have a runId
    // suffix), so the call falls through to the restoreKeys prefix search.
    const hitKey = await client.restoreCache([stateRoot], prefix, [prefix]);
    return { hit: !!hitKey, key: hitKey ?? null };
  } catch (e) {
    _warn('restore', { detail: 'failed; proceeding without cache', errName: e?.name, errMessage: safeMsg(e) });
    return { hit: false, key: null };
  }
}

/**
 * @param {{
 *   stateRoot: string,
 *   repoId: string|number|undefined,
 *   prNum: number|null,
 *   runId: string|undefined,
 *   dryRun: boolean,
 *   env: NodeJS.ProcessEnv,
 *   cacheClient?: { restoreCache: Function, saveCache: Function },
 * }} opts
 * @returns {Promise<void>}
 */
async function save(opts) {
  const { stateRoot, repoId, prNum, runId, dryRun, env, cacheClient } = opts;
  if (env.GITHUB_ACTIONS !== 'true') return;
  if (dryRun) return;
  if (repoId == null || repoId === '' || prNum == null || runId == null || runId === '') {
    _warn('save', { detail: 'skipped (repoId, prNum, or runId missing)', repoId: repoId ?? null, prNum: prNum ?? null, runId: runId ?? null });
    return;
  }
  if (!fs.existsSync(stateRoot)) {
    _info('save', { detail: 'skipped (state path does not exist; nothing to cache)', stateRoot });
    return;
  }
  const primaryKey = _buildKey({ repoId, prNum, runId });
  try {
    const client = _resolveClient(cacheClient);
    await client.saveCache([stateRoot], primaryKey);
  } catch (e) {
    _warn('save', { detail: 'failed; state not persisted across runs', errName: e?.name, errMessage: safeMsg(e) });
  }
}

module.exports = { restore, save, _buildKey };
