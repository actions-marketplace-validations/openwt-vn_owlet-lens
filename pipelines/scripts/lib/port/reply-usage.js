// @ts-check
'use strict';

// Reply spend accounting. Every evaluate() call reports the model that actually
// answered plus its tokens and cost (reply-evaluator.js); this module folds those
// per-verdict results into one usage record and renders it into the three places
// a reply run reports itself: the cumulative state invocation, the stdout result
// and the audit entry. Extracted from ai-review.js so the attribution rules are
// testable on their own and that file keeps shrinking toward the <500-line
// convention (CLAUDE.md, Conventions).
//
// Cost follows the model that answered, not `config.reply.model`: with
// `reply.fallbackModels` a verdict can come from a fallback (docs/config.md,
// ADR-0005).

/**
 * @typedef {{ inputTokens: number, outputTokens: number, costUsd: number, models: string[] }} ReplyUsage
 */

/**
 * @typedef {{ processed: number, evalFailures: number, writeFailures: number }} ReplyCounts
 */

/**
 * @typedef {ReturnType<typeof summarizeReplyUsage>} ReplyReport
 */

/** A run that answered nothing yet.
 * @returns {ReplyUsage}
 */
function emptyReplyUsage() {
  return { inputTokens: 0, outputTokens: 0, costUsd: 0, models: [] };
}

/**
 * Fold one evaluate() result into the run totals, keeping each answering model
 * once, in first-answer order.
 *
 * @param {ReplyUsage} usage  mutated in place
 * @param {{ costUsd?: number, inputTokens?: number, outputTokens?: number, model?: string|null }} result
 * @returns {ReplyUsage} the same usage, for chaining
 */
function addVerdictUsage(usage, result) {
  usage.costUsd += Number.isFinite(result.costUsd) ? result.costUsd : 0;
  usage.inputTokens += result.inputTokens ?? 0;
  usage.outputTokens += result.outputTokens ?? 0;
  const answered = typeof result.model === 'string' && result.model.trim() ? result.model : null;
  if (answered && !usage.models.includes(answered)) usage.models.push(answered);
  return usage;
}

/**
 * Render the run's spend into the shapes the reply reports use: `model` lists
 * every model that answered, comma-joined, and falls back to the configured
 * model only when no verdict reported one.
 *
 * @param {ReplyUsage} usage
 * @param {{ configuredModel: string, provider: string, dryRun: boolean, counts: ReplyCounts, wouldReply?: any[] }} opts
 * @returns {{
 *   model: string, costUsd: number, inputTokens: number, outputTokens: number,
 *   invocation: { type: 'reply', ts: string, costUsd: number, model: string },
 *   result: Record<string, any>,
 * }}
 */
function summarizeReplyUsage(usage, { configuredModel, provider, dryRun, counts, wouldReply = [] }) {
  const model = usage.models.join(',') || configuredModel;
  const spend = {
    costUsd: usage.costUsd, model,
    inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
  };
  const base = { provider, ...counts, ...spend };
  return {
    ...spend,
    invocation: { type: 'reply', ts: new Date().toISOString(), ...spend },
    // A dry run reports what it would post instead of the post counts.
    result: dryRun ? { dryRun: true, ...base, wouldReply } : base,
  };
}

/**
 * Write the reply run's state invocation and audit entry. Both are suppressed on
 * a dry run; the state ledger only records a run that actually spent or
 * answered something, so its cumulative cost stays the real one.
 *
 * @param {{ appendState: Function, writeAudit: Function }} life
 * @param {{
 *   prNumber: number, prId: string|number|null|undefined, repo: string,
 *   auditPath: string|null, dryRun: boolean, processed: number, report: ReplyReport,
 * }} opts
 */
function recordReplyRun(life, { prNumber, prId, repo, auditPath, dryRun, processed, report }) {
  life.appendState({
    prNumber,
    enabled: (processed > 0 || report.costUsd > 0) && !dryRun,
    invocation: report.invocation,
  });
  life.writeAudit({
    path: auditPath,
    enabled: !dryRun,
    repo,
    entry: { event: 'reply', prId, model: report.model, ...report.result },
  });
}

module.exports = {
  emptyReplyUsage, addVerdictUsage, summarizeReplyUsage, recordReplyRun,
};
