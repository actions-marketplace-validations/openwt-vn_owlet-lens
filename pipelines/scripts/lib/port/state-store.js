// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { safeMsg } = require('../log-safe.js');

const DEFAULT_ROOT = '/tmp/ai-review';

/**
 * Where per-PR state lives. On a GitHub Actions runner this is
 * RUNNER_TEMP/ai-review: actions/cache stores a path outside the workspace
 * relative to it, so /tmp/ai-review would restore to a missing directory on a
 * runner whose workspace sits at another depth. RUNNER_TEMP (_work/_temp) is
 * the same offset from the workspace on every runner.
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
function resolveStateRoot(env) {
  if (env.AI_REVIEW_STATE_ROOT) return env.AI_REVIEW_STATE_ROOT;
  if (env.RUNNER_TEMP) return path.join(env.RUNNER_TEMP, 'ai-review');
  return DEFAULT_ROOT;
}

/**
 * A missing root falls back to resolveStateRoot(process.env), so every caller
 * shares the root that action-entry caches unless it overrides it.
 * @param {{ repo: string, prNumber: number, root?: string | null }} key
 */
function _statePathFor({ repo, prNumber, root }) {
  const resolvedRoot = root ?? resolveStateRoot(process.env);
  const slug = crypto
    .createHash('sha256')
    .update(`${repo}:${prNumber}`)
    .digest('hex')
    .slice(0, 12);
  return path.join(resolvedRoot, slug, 'state.json');
}

function _emptyRecord(repo, prNumber) {
  return { version: 1, repo, prNumber, cumulativeCostUsd: 0, invocations: [] };
}

/**
 * @param {{ repo: string, prNumber: number, root?: string | null }} key
 * @returns {{ version:1, repo:string, prNumber:number, cumulativeCostUsd:number, invocations:Array<object> }}
 */
function load(key) {
  const p = _statePathFor(key);
  if (!fs.existsSync(p)) return _emptyRecord(key.repo, key.prNumber);
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.invocations)) {
      throw new Error('shape mismatch');
    }
    return {
      version: parsed.version ?? 1,
      repo: parsed.repo ?? key.repo,
      prNumber: parsed.prNumber ?? key.prNumber,
      cumulativeCostUsd: typeof parsed.cumulativeCostUsd === 'number' ? parsed.cumulativeCostUsd : 0,
      invocations: parsed.invocations,
    };
  } catch (e) {
    process.stderr.write(JSON.stringify({
      level: 'warn', msg: 'state-store: load failed; treating as empty',
      path: p, errMessage: safeMsg(e),
    }) + '\n');
    return _emptyRecord(key.repo, key.prNumber);
  }
}

/**
 * @param {{ repo: string, prNumber: number, root?: string | null }} key
 * @param {{ type: 'review'|'reply', ts: string, costUsd: number, model: string, skipped?: string }} invocation
 */
function append(key, invocation) {
  const p = _statePathFor(key);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const current = load(key);
  const next = {
    ...current,
    cumulativeCostUsd: (current.cumulativeCostUsd || 0) + (invocation.costUsd || 0),
    invocations: [...current.invocations, invocation],
  };
  // Atomic write: tmp + rename. Single-process runner → no lock needed.
  const tmpPath = `${p}.tmp.${process.pid}`;
  fs.writeFileSync(tmpPath, JSON.stringify(next));
  fs.renameSync(tmpPath, p);
  return next;
}

module.exports = { load, append, resolveStateRoot, _statePathFor };
