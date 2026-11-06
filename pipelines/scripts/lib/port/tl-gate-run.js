// @ts-check
'use strict';

/**
 * `runReview`'s half of the TL gate: the two calls around the review work.
 *
 * Split out of `ai-review.js` for budget reasons only — the decision itself
 * belongs to `tl-gate.js` (ADR-0014), and the platform facts to the providers
 * (ADR-0012). Nothing here decides anything.
 */

const tlGate = require('./tl-gate.js');
const { logActionFailure } = require('../action-poster.js');
const { logEvent } = require('../log-helpers.js');

/**
 * Answer "may this run spend a token?" before any LLM client is built, and do
 * the one comment write the decision implies.
 *
 * Returns `held: true` when the gate stopped the run, having already printed the
 * result line; the caller then exits 0, because waiting for a team lead is the
 * configured behaviour rather than a failure.
 *
 * @param {{
 *   provider: import('../providers/provider.types.js').IReviewProvider,
 *   providerName: string,
 *   cwd: string,
 *   cliFlags: { configPath?: string, dryRun?: boolean },
 *   meta: import('../providers/provider.types.js').PRMetadata,
 *   life: {
 *     log: typeof logEvent,
 *     elapsedMs: () => number,
 *     writeAudit: (a: { path?: string|null, entry: Record<string, any>, enabled?: boolean, repo?: string|null }) => boolean,
 *   },
 *   auditLogPath?: string|null,
 * }} opts
 * @returns {Promise<{
 *   gate: import('./tl-gate.js').GateDecision,
 *   held: boolean,
 *   noteFailed: boolean,
 * }>}
 */
async function guard({ provider, providerName, cwd, cliFlags, meta, life, auditLogPath }) {
  // The gate reads its switch and lead list off the PR's TARGET branch, so
  // `meta.targetSha` is all it needs — `getPRMetadata` is the same call the
  // review path needs anyway, which is why it is not duplicated here.
  const gate = await tlGate.evaluate({ provider, cwd, cliFlags, targetSha: meta.targetSha });
  if (gate.on) return { gate, held: false, noteFailed: await persistNote({ gate, provider, prId: meta.id, dryRun: cliFlags.dryRun }) };

  life.log('info', 'review.tlGate.held', {
    reason: gate.reason,
    configPath: gate.configPath,
    presser: gate.presser?.actorId ?? null,
  });
  // A failed comment is a warn, not an error: failing the build would punish a
  // repository for behaving exactly as it configured. The outcome is still
  // reported, so tooling can tell a skipped write (--dryRun) from a failed one.
  let noteAction = null;
  let noteFailed = false;
  if (!cliFlags.dryRun) {
    try {
      noteAction = await tlGate.publish(provider, gate);
    } catch (e) {
      noteFailed = true;
      logActionFailure('write TL-gate comment failed', e, {});
    }
  }
  const tlGateJson = { on: false, reason: gate.reason, noteAction, noteFailed };
  // The held decision belongs in the audit trail like every other run's: "why
  // did the AI not review this PR?" is the question the trail exists to answer.
  // writeAudit never throws, so rule 9's exit 0 cannot be affected by this.
  const auditLogged = life.writeAudit({
    path: auditLogPath,
    enabled: !cliFlags.dryRun,
    repo: provider.repoSlug,
    entry: {
      event: 'review', prId: meta.id, provider: providerName,
      costUsd: 0, durationMs: life.elapsedMs(),
      tlGate: tlGateJson,
    },
  });
  process.stdout.write(JSON.stringify({
    provider: providerName,
    prId: meta.id,
    tlGate: tlGateJson,
    auditLogged,
  }) + '\n');
  // The JSON line reports the write; this return value answers a different
  // question — does the run's outcome depend on it — and for a held run it
  // never does: ai-review.js returns 0 before noteFailed is read (rule 9).
  return { gate, held: true, noteFailed: false };
}

/**
 * Persist the "AI on" note on the press that turns the AI on. It is the gate's
 * only memory, so it is written before the review work: if this run dies later,
 * the next push must still be reviewed.
 *
 * @param {{
 *   gate: import('./tl-gate.js').GateDecision,
 *   provider: import('../providers/provider.types.js').IReviewProvider,
 *   prId: string|number,
 *   dryRun?: boolean,
 * }} opts
 * @returns {Promise<boolean>} true when the note write failed
 */
async function persistNote({ gate, provider, prId, dryRun }) {
  if (!gate.writeNote || dryRun) return false;
  try {
    await tlGate.publish(provider, gate);
    return false;
  } catch (e) {
    logActionFailure('write TL-gate "AI on" note failed', e, { prId });
    return true;
  }
}

/**
 * The `tlGate` block of the review result JSON. Kept next to the two writers so
 * the three shapes cannot drift: a held run, a review that wrote the note, and a
 * review that found one.
 *
 * @param {import('./tl-gate.js').GateDecision} gate
 * @param {{ dryRun?: boolean, noteFailed?: boolean }} opts
 */
function report(gate, { dryRun, noteFailed }) {
  return { on: gate.on, reason: gate.reason, wroteNote: gate.writeNote && !dryRun && !noteFailed };
}

module.exports = { guard, persistNote, report };
