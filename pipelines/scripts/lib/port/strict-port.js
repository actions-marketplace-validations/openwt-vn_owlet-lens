// @ts-check
'use strict';

const { rankSeverity } = require('../config.js');

/**
 * @typedef {Object} Finding
 * @property {string} filePath
 * @property {number} line
 * @property {string} [severity]
 * @property {string} [ruleId]
 */

/**
 * @typedef {Object} StrictDecisionInput
 * @property {boolean} enabled
 * @property {string} threshold
 * @property {Array<Finding>} toPost
 * @property {Array<{ finding: Finding }>} toReopen
 * @property {Array<Finding & { carried: true }>} [carried] open threads from
 *   earlier runs that still block (see `carriedBlockers`)
 */

/**
 * @typedef {Object} StrictDecision
 * @property {boolean} enabled
 * @property {string} threshold
 * @property {boolean} triggered
 * @property {number} blockingCount
 * @property {Array<{ filePath: string, line: number, severity: string, ruleId: string, carried?: true }>} blockingFindings
 */

/**
 * Pure decision: given strict mode config and reconcile buckets, determine
 * whether the review should block (exit 8) and which findings caused it.
 *
 * Blocking candidates are `toPost` (new findings), `toReopen` (re-surfaced
 * findings) and `carried` (threads raised by an earlier run that are still
 * open). Without `carried`, a blocking finding failed only the run that first
 * posted it: the next push matched the still-open thread, posted nothing, and
 * turned the check green while the finding stayed unfixed.
 *
 * @param {StrictDecisionInput} input
 * @returns {StrictDecision}
 */
function computeStrictDecision({ enabled, threshold, toPost, toReopen, carried = [] }) {
  if (!enabled) {
    return { enabled: false, threshold, triggered: false, blockingCount: 0, blockingFindings: [] };
  }

  const thresholdRank = rankSeverity(threshold);

  const candidates = [
    ...toPost,
    ...toReopen.map((r) => r.finding),
    ...carried,
  ];

  const blockingFindings = candidates
    .filter((x) => {
      const r = rankSeverity(x.severity);
      return r > 0 && r >= thresholdRank;
    })
    .map((x) => ({
      filePath: x.filePath,
      line: x.line,
      severity: x.severity ?? 'UNKNOWN',
      ruleId: x.ruleId ?? '',
      ...('carried' in x && x.carried ? { carried: /** @type {const} */ (true) } : {}),
    }));

  return {
    enabled: true,
    threshold,
    triggered: blockingFindings.length > 0,
    blockingCount: blockingFindings.length,
    blockingFindings,
  };
}

// The severity the bot wrote into the finding's first comment (format-body.js):
// `**[HIGH/bug]**`. Threads carry no structured severity, so this is the record.
const SEVERITY_IN_BODY = /\*\*\[(CRITICAL|HIGH|MEDIUM|LOW)\//i;

/**
 * Bot threads from earlier runs that still block: status `active` (not yet
 * fixed, and not argued to wontfix through a reply verdict) and a stored
 * severity at or above the threshold. The platform's own Resolve button does
 * not clear one — that would let any developer turn the gate green with a click.
 * A severity that cannot be read does not block, the same as `UNKNOWN` above.
 *
 * @param {{
 *   threads: Array<{ id: string, status: string, filePath: string, line: number,
 *     comments: Array<{ isBot: boolean, body?: string }>, marker?: { fingerprint?: string|null } }>,
 *   threshold: string,
 *   excludeIds: Set<string>,
 *   log: (level: string, msg: string, fields?: Record<string, any>) => void,
 * }} input `excludeIds`: threads this run closes or reopens, which are already
 *   accounted for.
 * @returns {Array<Finding & { severity: string, ruleId: string, carried: true }>}
 */
function carriedBlockers({ threads, threshold, excludeIds, log }) {
  const thresholdRank = rankSeverity(threshold);
  const out = [];
  for (const t of threads) {
    const root = t.comments[0];
    if (t.status !== 'active' || excludeIds.has(t.id)) continue;
    // A finding thread: bot-rooted and fingerprinted, the same test reconcile uses.
    if (!root?.isBot || !t.marker?.fingerprint) continue;
    const m = SEVERITY_IN_BODY.exec(root.body ?? '');
    if (!m) {
      log('warn', 'strict.carried.severity.unknown', { threadId: t.id, filePath: t.filePath, line: t.line });
      continue;
    }
    const severity = m[1].toUpperCase();
    if (rankSeverity(severity) < thresholdRank) continue;
    out.push({ filePath: t.filePath, line: t.line, severity, ruleId: '', carried: /** @type {const} */ (true) });
  }
  return out;
}

/**
 * The run's strict decision: this run's new and reopened findings plus the open
 * threads earlier runs raised. Shared by the full review and the skip path
 * (ADR-0015) so a skipped push cannot turn a red check green.
 *
 * @param {{
 *   review: { strict?: boolean, severityThreshold: string },
 *   plan: { toPost: Array<Finding>, toReopen: Array<{ finding: Finding, thread: { id: string } }>, toClose: Array<{ id: string }> },
 *   threads: Parameters<typeof carriedBlockers>[0]['threads'],
 *   log: (level: string, msg: string, fields?: Record<string, any>) => void,
 * }} input
 * @returns {StrictDecision}
 */
function strictDecisionFor({ review, plan, threads, log }) {
  const enabled = review.strict === true;
  const threshold = review.severityThreshold;
  const excludeIds = new Set([...plan.toClose.map((t) => t.id), ...plan.toReopen.map((r) => r.thread.id)]);
  const carried = enabled ? carriedBlockers({ threads, threshold, excludeIds, log }) : [];
  return computeStrictDecision({ enabled, threshold, toPost: plan.toPost, toReopen: plan.toReopen, carried });
}

module.exports = { computeStrictDecision, carriedBlockers, strictDecisionFor };
