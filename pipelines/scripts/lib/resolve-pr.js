// @ts-check
'use strict';

const fs = require('node:fs');

function _parseRef(ref) {
  const m = /refs\/pull\/(\d+)\//.exec(ref ?? '');
  return m ? Number(m[1]) : null;
}

function _readEvent(evtPath) {
  if (!evtPath) return null;
  try {
    const evt = JSON.parse(fs.readFileSync(evtPath, 'utf8'));
    return evt?.pull_request?.number ?? evt?.issue?.number ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve the PR number from inputs/env in this precedence:
 *   1. explicit override (e.g. action input `pr-number`)
 *   2. env.GITHUB_PR_NUMBER
 *   3. parse env.GITHUB_REF (`refs/pull/<n>/head`)
 *   4. parse env.GITHUB_EVENT_PATH JSON (`pull_request.number` or `issue.number`)
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {{ override?: string|number|null }} opts
 * @returns {number|null}
 */
function resolvePr(env, opts = {}) {
  const overrideRaw = opts.override;
  if (overrideRaw !== undefined && overrideRaw !== null && String(overrideRaw).trim() !== '') {
    const n = Number(overrideRaw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const fromEnv = Number(env.GITHUB_PR_NUMBER ?? 0);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  const fromRef = _parseRef(env.GITHUB_REF);
  if (fromRef) return fromRef;
  const fromEvent = _readEvent(env.GITHUB_EVENT_PATH);
  if (fromEvent !== null) {
    const n = Number(fromEvent);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

module.exports = { resolvePr };
