// @ts-check
'use strict';

// Action poster: turns the reconcile action plan into provider writes. Owns
// all four batches (post / reply / reopen / close), the GitHub pending-review
// fast-path, and per-item failure accounting. Each provider retries its own
// requests (ADR-0013). See CONTEXT.md (Action plan) and
// lib/providers/github-write.js#postThreadsBatch.

const { formatBody: formatFindingBody } = require('./format-body.js');
const { fingerprint } = require('./fingerprint.js');
const { mapWithConcurrency } = require('./concurrency.js');
const { safeMsg } = require('./log-safe.js');

const WRITE_CONCURRENCY = 4;

/**
 * Emit the structured stderr record for one failed provider action.
 *
 * @param {string} msg
 * @param {any} e
 * @param {Record<string, any>} [context]
 */
function logActionFailure(msg, e, context = {}) {
  process.stderr.write(JSON.stringify({
    level: 'error', msg, ...context,
    ...(e?.commentDbId ? { commentDbId: e.commentDbId } : {}),
    errName: e?.name, errMessage: safeMsg(e), errStatus: e?.status,
  }) + '\n');
}

/**
 * Execute every batch of the action plan, collecting per-item failures rather
 * than aborting on the first one. Counts are attempt counts (plan length), not
 * success counts — matching the historical summary/report semantics.
 *
 * @param {{ toPost?: any[], toReply?: any[], toReopen?: any[], toClose?: any[], toResolve?: any[] }} plan
 * @param {any} provider
 * @param {{
 *   providerName?: string,
 *   concurrency?: number,
 *   formatBody?: (finding: any) => string,
 *   onFailure?: (msg: string, e: any, context?: Record<string, any>) => void,
 * }} [opts]
 * @returns {Promise<{ posted: number, replied: number, reopened: number, closed: number, retried: number, failures: number }>}
 */
async function postActionPlan(plan, provider, opts = {}) {
  const { toPost = [], toReply = [], toReopen = [], toClose = [], toResolve = [] } = plan ?? {};
  // Neutral default: provider-specific formatting (e.g. GitHub suggestion
  // fences) must be opted into explicitly, never injected by omission.
  const providerName = opts.providerName ?? '';
  const concurrency = opts.concurrency ?? WRITE_CONCURRENCY;
  const formatBody = opts.formatBody ?? ((f) => formatFindingBody(f, providerName));
  const onFailure = opts.onFailure ?? logActionFailure;

  let failures = 0;
  const fail = (msg, e, context) => {
    failures += 1;
    onFailure(msg, e, context);
  };

  // Batch toPost under a single pending review to avoid GitHub's
  // "one pending review per user per PR" 422 race on parallel
  // createReviewComment calls.
  const postBatchThreads = toPost.map((f) => ({
    filePath: f.filePath, line: f.line, body: formatBody(f),
    status: 'active', ruleId: f.ruleId ?? '',
  }));
  // Fallback: providers without postThreadsBatch (older adapters, test
  // doubles) get per-thread postThread with mapWithConcurrency. Pending-review
  // race is GitHub-specific; this fallback path is safe for providers that
  // don't have the pending-review concept.
  const postResults = postBatchThreads.length === 0
    ? []
    : typeof provider.postThreadsBatch === 'function'
      ? await provider.postThreadsBatch(postBatchThreads)
      : await mapWithConcurrency(postBatchThreads,
          (t) => provider.postThread(t),
          concurrency);
  postResults.forEach((r, i) => {
    if (r.ok) return;
    const f = toPost[i];
    fail('postThread failed', r.error, { filePath: f.filePath, line: f.line, ruleId: f.ruleId });
  });

  const replyResults = await mapWithConcurrency(toReply,
    (r) => provider.replyToThread(r.thread.id, formatBody({ ...r.finding, suggestion: null })),
    concurrency);
  replyResults.forEach((res, i) => {
    if (res.ok) return;
    const r = toReply[i];
    fail('replyToThread failed', res.error, {
      threadId: r.thread.id, filePath: r.finding.filePath, line: r.finding.line,
    });
  });

  // Reopen: reply + status-flip per item; run items in parallel, sub-steps
  // serially per item so the marker reply precedes the unresolve.
  const reopenResults = await mapWithConcurrency(toReopen, async (r) => {
    const fp = fingerprint(r.finding.filePath, r.finding.line, r.finding.ruleId ?? '');
    await provider.replyToThread(
      r.thread.id,
      `**[REGRESSION]** ${formatBody({ ...r.finding, suggestion: null })}`,
      { status: 'active', fingerprintHash: fp },
    );
    await provider.patchThreadStatus(r.thread.id, 'active', { skipMarkerReply: true });
  }, concurrency);
  reopenResults.forEach((res, i) => {
    if (res.ok) return;
    const r = toReopen[i];
    fail('reopen failed', res.error, {
      threadId: r.thread.id, filePath: r.finding.filePath, line: r.finding.line,
    });
  });

  const closeResults = await mapWithConcurrency(toClose,
    (t) => provider.patchThreadStatus(t.id, 'fixed'),
    concurrency);
  closeResults.forEach((res, i) => {
    if (res.ok) return;
    const t = toClose[i];
    fail('patchThreadStatus failed', res.error, {
      threadId: t.id, filePath: t.filePath, line: t.line,
    });
  });

  // Resolve retry (#105): threads whose marker already says fixed/wontfix but
  // which the platform still shows open, because a previous resolve call
  // failed. Replay the resolve step alone — the marker is already there, and
  // posting it again would be a duplicate comment. A failure here counts like a
  // failed close (ADR-0013), so the run exits 6 and the next run retries.
  const resolveResults = await mapWithConcurrency(toResolve,
    (t) => provider.patchThreadStatus(t.id, t.status, { skipMarkerReply: true }),
    concurrency);
  resolveResults.forEach((res, i) => {
    if (res.ok) return;
    const t = toResolve[i];
    fail('patchThreadStatus (resolve retry) failed', res.error, {
      threadId: t.id, filePath: t.filePath, line: t.line,
    });
  });

  return {
    posted: toPost.length,
    replied: toReply.length,
    reopened: toReopen.length,
    closed: toClose.length,
    retried: toResolve.length,
    failures,
  };
}

module.exports = { postActionPlan, logActionFailure, WRITE_CONCURRENCY };
