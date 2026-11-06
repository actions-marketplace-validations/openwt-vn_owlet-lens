// @ts-check
'use strict';

/**
 * `review.skipUnchanged` (ADR-0015): skip a push whose review fingerprint
 * matches the last full review, e.g. a push that only merged the target branch
 * in. The fingerprint lives in a `reviewed-<hex>` key marker on the bot's own
 * summary comment — the PR is the source of truth (ADR-0001), nothing on disk.
 *
 * Every doubt resolves to "review": no marker, a marker someone else edited, a
 * failed lookup, or a run a person asked for.
 */

const { safeMsg } = require('../log-safe.js');
const { serializeKeyMarker } = require('../markers.js');
const { strictDecisionFor } = require('./strict-port.js');

const SKIP_REASON = 'no-net-change';

/** @param {string} fingerprint */
function reviewedKey(fingerprint) {
  return `reviewed-${fingerprint}`;
}

/**
 * The marker a fully successful review stamps into its summary body.
 *
 * @param {{ renderSummaryMarker: (markerKey?: string) => string }} provider
 * @param {string} fingerprint
 */
function reviewedMarker(provider, fingerprint) {
  return provider.renderSummaryMarker(reviewedKey(fingerprint));
}

/**
 * Every full-marker spelling of `key` the summary may carry. Bitbucket resolves
 * its wire style lazily (only `postThread` runs the probe, ADR-0003), so before
 * the probe this run may render the inline-code form while the stored summary
 * was written in the HTML-comment form, or the other way round.
 *
 * @param {{ renderSummaryMarker: (markerKey?: string) => string, markers?: { prefix: string } }} provider
 * @param {string} key
 * @returns {string[]}
 */
function markerForms(provider, key) {
  const forms = [provider.renderSummaryMarker(key)];
  const prefix = provider.markers?.prefix;
  if (prefix) {
    forms.push(serializeKeyMarker({ prefix, key, style: 'html' }), serializeKeyMarker({ prefix, key, style: 'bitbucket' }));
  }
  return forms;
}

/**
 * Did the bot's own, unedited comment record this exact fingerprint? Only the
 * bot's comment counts: the hash is public and deterministic, so anyone could
 * compute it for code that was never reviewed and paste the marker.
 *
 * @param {import('../providers/provider.types.js').IReviewProvider} provider
 * @param {string} fingerprint
 * @param {(level: string, msg: string, fields?: Record<string, any>) => void} log
 * @returns {Promise<boolean>}
 */
async function lastReviewMatches(provider, fingerprint, log) {
  const key = reviewedKey(fingerprint);
  try {
    const hit = await provider.findBotComment(key);
    if (!hit) return false;
    if (hit.editedByOther) {
      log('warn', 'review.skipUnchanged.marker.edited', { commentId: hit.id });
      return false;
    }
    // Match the whole rendered marker, not the bare key: the key alone can sit
    // in prose, a quoted error, or as the prefix of a longer key, none of which
    // is a record that this fingerprint was reviewed.
    return markerForms(provider, key).some((form) => hit.body.includes(form));
  } catch (e) {
    log('warn', 'review.skipUnchanged.lookup.failed', { errMessage: safeMsg(e) });
    return false;
  }
}

/**
 * Why a person asked for this run, or null for a push. A manual run is
 * whatever the provider reports as one (GitHub re-run, GitLab manual job, the
 * TL press variable on Bitbucket/Azure); a failed lookup counts as forced.
 *
 * @param {{
 *   provider: import('../providers/provider.types.js').IReviewProvider,
 *   cliFlags: { forceReview?: boolean },
 *   env: NodeJS.ProcessEnv,
 *   log: (level: string, msg: string, fields?: Record<string, any>) => void,
 * }} opts
 * @returns {Promise<string|null>}
 */
async function forcedBy({ provider, cliFlags, env, log }) {
  if (cliFlags.forceReview) return 'flag';
  if (['1', 'true'].includes(String(env.AI_REVIEW_FORCE ?? '').trim().toLowerCase())) return 'env';
  try {
    return (await provider.getTriggerInfo()).manual ? 'manual' : null;
  } catch (e) {
    log('warn', 'review.skipUnchanged.trigger.failed', { errMessage: safeMsg(e) });
    return 'trigger-unknown';
  }
}

/**
 * Skip the run when nothing the review depends on changed. Returns the exit
 * code when it skipped, having already printed the result line and recorded the
 * run, or null to review. A skip exits 0, or 8 when strict mode still has an
 * open blocking thread from an earlier run: a push with no net change must not
 * turn a red check green.
 *
 * @param {{
 *   provider: import('../providers/provider.types.js').IReviewProvider,
 *   providerName: string,
 *   config: { review: { skipUnchanged?: boolean, model: string, auditLogPath?: string|null, strict?: boolean, severityThreshold: string } },
 *   cliFlags: { forceReview?: boolean, dryRun?: boolean },
 *   env: NodeJS.ProcessEnv,
 *   meta: import('../providers/provider.types.js').PRMetadata,
 *   fingerprint: string,
 *   tlGate: Record<string, any>,
 *   life: {
 *     log: (level: string, msg: string, fields?: Record<string, any>) => void,
 *     elapsedMs: () => number,
 *     appendState: (a: { prNumber?: string|number, enabled?: boolean, invocation: { type: string, ts: string, costUsd: number, model: string, skipped?: string } }) => any,
 *     writeAudit: (a: { path?: string|null, entry: Record<string, any>, enabled?: boolean, repo?: string|null }) => boolean,
 *   },
 * }} opts
 * @returns {Promise<number|null>}
 */
async function guard({ provider, providerName, config, cliFlags, env, meta, fingerprint, tlGate, life }) {
  if (config.review.skipUnchanged !== true) return null;
  if (!(await lastReviewMatches(provider, fingerprint, life.log))) return null;
  const forced = await forcedBy({ provider, cliFlags, env, log: life.log });
  if (forced) {
    life.log('info', 'review.skipUnchanged.forced', { by: forced, fingerprint });
    return null;
  }
  const strict = await strictOnSkip(provider, config.review, life.log);
  if (!strict) return null;

  const enabled = !cliFlags.dryRun;
  life.appendState({
    prNumber: Number(meta.id),
    enabled,
    invocation: {
      type: 'review', ts: new Date().toISOString(), costUsd: 0, model: config.review.model, skipped: SKIP_REASON,
    },
  });
  const result = {
    provider: providerName, prId: meta.id,
    skipped: SKIP_REASON, fingerprint,
    costUsd: 0, durationMs: life.elapsedMs(),
    strict, tlGate,
  };
  const auditLogged = life.writeAudit({
    path: config.review.auditLogPath,
    enabled,
    repo: provider.repoSlug,
    entry: { event: 'review', ...result },
  });
  life.log('info', 'review.skipUnchanged.skipped', { fingerprint, prId: meta.id });
  process.stdout.write(JSON.stringify({ ...result, ...(cliFlags.dryRun ? { dryRun: true } : {}), auditLogged }) + '\n');
  return strict.triggered ? 8 : 0;
}

/**
 * The strict decision for a skipped run: no new findings, so only the open
 * threads earlier runs raised. Reads threads only when strict is on. A failed
 * read returns null so the caller reviews instead — never a green skip that
 * could not check the gate.
 *
 * @param {import('../providers/provider.types.js').IReviewProvider} provider
 * @param {{ strict?: boolean, severityThreshold: string }} review
 * @param {(level: string, msg: string, fields?: Record<string, any>) => void} log
 */
async function strictOnSkip(provider, review, log) {
  const plan = { toPost: [], toReopen: [], toClose: [] };
  if (review.strict !== true) return strictDecisionFor({ review, plan, threads: [], log });
  try {
    const threads = await provider.listThreads();
    return strictDecisionFor({ review, plan, threads, log });
  } catch (e) {
    log('warn', 'review.skipUnchanged.threads.failed', { errMessage: safeMsg(e) });
    return null;
  }
}

module.exports = { guard, reviewedMarker, reviewedKey, SKIP_REASON };
