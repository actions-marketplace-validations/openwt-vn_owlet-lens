// @ts-check
'use strict';

const { CONFIG } = require('../config.js');

const MARKER = '<!-- ai-review:v1:summary -->';

/**
 * Build the markdown body for the PR-level summary comment. Embeds the
 * v1 summary marker so subsequent runs find + edit it.
 *
 * `now` is injected (defaulting to the wall clock) so tests can pin
 * the timestamp for deterministic snapshots and so future "skip upsert
 * if body unchanged" optimizations can compare bodies excluding it.
 *
 * @param {{
 *   meta: { id: string, title: string },
 *   reconcile: { posted: number, replied: number, reopened: number, closed: number, failures: number },
 *   cost: { totalUsd: number, byType: Record<string, { count: number, totalUsd: number }> },
 *   dismissed: { dismissedCount: number },
 *   securityContext: { enabled: boolean, degraded: boolean, reason?: string },
 *   strict?: { enabled: boolean, triggered: boolean, threshold: string, blockingCount: number, blockingFindings?: Array<{ carried?: true }> },
 *   cumulative?: { totalUsd: number, runCount: number },
 *   metrics?: { bySeverity?: Record<string, number>, durationMs?: number, filesReviewed?: number, filesSkipped?: number },
 *   now?: Date,
 *   marker?: string,
 *   reviewedMarker?: string,
 * }} input
 * @returns {string}
 */
function buildBody(input) {
  const {
    meta, reconcile, cost, dismissed, securityContext, strict, now = new Date(), cumulative,
    // The summary marker is provider-styled (HTML comment on GitHub, inline-code
    // on Bitbucket). Callers pass `provider.renderSummaryMarker()`; the default
    // keeps the GitHub/HTML form for direct/test callers.
    marker = MARKER,
    // The review fingerprint marker (ADR-0015), present only when this run
    // reviewed everything and every write landed.
    reviewedMarker,
  } = input;
  const callCount =
    (cost.byType?.review?.count ?? 0) + (cost.byType?.reply?.count ?? 0);

  let secStatus;
  if (!securityContext.enabled) secStatus = 'disabled';
  else if (securityContext.degraded) secStatus = `degraded — ${securityContext.reason ?? 'unknown'}`;
  else secStatus = 'active';

  const failureSuffix =
    reconcile.failures > 0 ? ` · **${reconcile.failures} failure(s)**` : '';

  const lines = [
    `### ${CONFIG.aiReviewPrefix} Summary`,
    '',
    `**PR:** #${meta.id} — ${meta.title}`,
    `**Findings:** ${reconcile.posted} new · ${reconcile.replied} replied · ${reconcile.reopened} reopened · ${reconcile.closed} closed${failureSuffix}`,
    `**Cost:** $${cost.totalUsd.toFixed(4)} (${callCount} call(s))`,
    ...(cumulative && Number(cumulative.runCount) > 0
      ? [`**Cumulative cost:** $${Number(cumulative.totalUsd).toFixed(4)} over ${cumulative.runCount} run(s)`]
      : []),
    `**Dismissed context:** ${dismissed.dismissedCount} prior wontfix/fixed thread(s) included`,
    `**Security context:** ${secStatus}`,
  ];

  if (strict?.enabled) {
    const carriedCount = (strict.blockingFindings ?? []).filter((b) => b.carried).length;
    const carriedNote = carriedCount > 0 ? ` (${carriedCount} from earlier runs, still open)` : '';
    lines.push(
      strict.triggered
        ? `> ⚠️ Strict mode: ${strict.blockingCount} blocking finding(s)${carriedNote} at severity ≥ \`${strict.threshold}\`. Workflow will exit non-zero.`
        : `> ✅ Strict mode: no blocking findings at severity ≥ \`${strict.threshold}\`.`,
    );
  }

  if (input.metrics) {
    const m = input.metrics;
    const sevParts = [];
    for (const s of ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN']) {
      const n = m.bySeverity?.[s];
      if (n > 0) sevParts.push(`${n} ${s}`);
    }
    const sevLine = sevParts.length > 0 ? sevParts.join(' · ') : 'none';
    const filesLine = typeof m.filesReviewed === 'number'
      ? `${m.filesReviewed} reviewed` + (m.filesSkipped > 0 ? ` · ${m.filesSkipped} skipped` : '')
      : null;
    const durationLine = typeof m.durationMs === 'number'
      ? `${(m.durationMs / 1000).toFixed(1)}s`
      : null;
    lines.push('', '**Metrics**');
    lines.push(`Severity: ${sevLine}`);
    if (filesLine) lines.push(`Files: ${filesLine}`);
    if (durationLine) lines.push(`Duration: ${durationLine}`);
  }

  lines.push('', `_Last run: ${now.toISOString()}_`, '', marker);
  if (reviewedMarker) lines.push('', reviewedMarker);

  // Emit a markdown hard break (two trailing spaces) between adjacent content
  // lines. GitHub (GFM) already treats a single newline as a line break, but
  // Bitbucket (CommonMark/Python-Markdown) collapses single newlines into
  // spaces — without this the metadata lines render as one run-on paragraph.
  // Blank-line-separated blocks are left untouched. The trailing spaces live
  // only in the join separator, not as literal source whitespace.
  return lines
    .map((line, i) => {
      const next = lines[i + 1];
      return line !== '' && next !== undefined && next !== '' ? `${line}  ` : line;
    })
    .join('\n');
}

/**
 * Post or update the AI-review summary comment.
 *
 * mode='sticky' (default) keeps a single summary comment, updated in place
 * across runs. mode='append' posts a NEW comment per run by encoding runId
 * (the provider's CI run id, falling back to the wall clock for local runs)
 * into the marker key, so each run leaves a permanent timeline entry on the PR.
 *
 * @param {{
 *   upsertSummaryComment(key: string, body: string): Promise<{ id: string, action: 'created'|'updated' }>,
 *   renderSummaryMarker?: (markerKey?: string) => string,
 * }} provider
 * @param {string} body the summary body, embedding the bare `summary` marker
 * @param {{ mode?: 'sticky'|'append', runId?: string }} [opts]
 */
async function upsert(provider, body, opts) {
  const mode = opts?.mode === 'append' ? 'append' : 'sticky';
  if (mode === 'append') {
    const runId = opts?.runId
      || String(Date.now());
    const key = `summary-${runId}`;
    // The body was built with the bare `summary` marker. Rewrite it to the
    // run-keyed marker so the embedded marker matches the lookup key — otherwise
    // upsertSummaryComment never finds its own comment and re-runs of the same
    // runId post duplicates instead of updating in place.
    let keyedBody = body;
    if (typeof provider.renderSummaryMarker === 'function') {
      keyedBody = body.replace(provider.renderSummaryMarker(), provider.renderSummaryMarker(key));
    }
    return provider.upsertSummaryComment(key, keyedBody);
  }
  return provider.upsertSummaryComment('summary', body);
}

module.exports = { buildBody, upsert, MARKER };
