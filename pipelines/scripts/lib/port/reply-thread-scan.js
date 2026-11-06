// @ts-check
'use strict';

// Which threads a reply run should evaluate, and the status repair for threads
// whose verdict already went out. Split out of ai-review.js so both rules are
// testable without a provider and that file keeps shrinking toward the
// <500-line convention (CLAUDE.md, Conventions).

const { safeMsg } = require('../log-safe.js');

/**
 * Index of the developer's most recent comment in the thread, or -1 when the
 * thread has none — a bot-only thread has nothing to evaluate.
 *
 * @param {{ comments?: Array<{ isBot?: boolean }> }} thread
 * @returns {number}
 */
function lastDevReplyIndex(thread) {
  const comments = thread?.comments ?? [];
  for (let k = comments.length - 1; k >= 0; k--) {
    if (!comments[k].isBot) return k;
  }
  return -1;
}

/**
 * The last bot verdict posted after the developer's latest reply, if any.
 * `.some()` used to be enough to decide "skip"; the repair path needs the value,
 * so keep the last one rather than the count.
 *
 * @param {{ comments?: any[] }} thread
 * @param {{ hasKey: (body: string, key: string) => boolean }} markers
 * @param {number} fromIdx  index of the developer's latest reply
 * @returns {any|null}
 */
function findPostedVerdict(thread, markers, fromIdx) {
  const comments = thread?.comments ?? [];
  let verdictComment = null;
  for (const c of comments.slice(fromIdx + 1)) {
    if (c.isBot && markers.hasKey(c.body ?? '', 'verdict')) verdictComment = c;
  }
  return verdictComment;
}

/**
 * Apply the thread status a posted verdict is still missing. The verdict reply
 * already went out, so without this the thread sits `active` forever and every
 * later run skips it; replaying only the status step costs no LLM call.
 *
 * `patched` / `skipped` / `failed` — `failed` tells the caller to count a write
 * failure, which has to reach the exit code the way a failed post does
 * (ADR-0013).
 *
 * @param {{ id: string }} thread
 * @param {{ body?: string }} verdictComment
 * @param {{ provider: any, parseVerdictText: (body: string) => ('fixed'|'wontfix'|'active'|null), dryRun: boolean }} opts
 * @returns {Promise<'patched'|'skipped'|'failed'>}
 */
async function repairVerdictStatus(thread, verdictComment, { provider, parseVerdictText, dryRun }) {
  const written = parseVerdictText(verdictComment.body);
  // A written verdict of `active`, or one that cannot be read back, is left
  // alone: the former needs no status change, and guessing at the latter would
  // flip a thread on a malformed marker. A dry run must not mutate the provider.
  if (dryRun || (written !== 'fixed' && written !== 'wontfix')) return 'skipped';
  try {
    // No `skipMarkerReply`: the status step must write its status marker, because
    // that marker is what makes the thread read as `fixed`/`wontfix` on the next
    // run and take it out of this branch. Skipping it leaves the thread looking
    // `active` forever, so the repair would re-patch on every run - and
    // re-resolving an already-resolved thread can fail, turning into a
    // recurring write failure. It is also what the normal path does: runReply
    // posts the verdict reply and then a status reply, so replaying that second
    // step is the same output, not a duplicate.
    await provider.patchThreadStatus(thread.id, written);
    return 'patched';
  } catch (e) {
    process.stderr.write(JSON.stringify({
      level: 'error', msg: 'reply status repair failed',
      threadId: thread.id, verdict: written, errName: e?.name, errMessage: safeMsg(e),
    }) + '\n');
    return 'failed';
  }
}

module.exports = { lastDevReplyIndex, findPostedVerdict, repairVerdictStatus };
