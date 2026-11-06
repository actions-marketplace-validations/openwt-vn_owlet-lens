// @ts-check
'use strict';

// Run lifecycle: the cross-cutting concerns every subcommand (review, reply,
// learn) shares — repo resolution, cross-run state-store append, audit-log
// write, and the error → exit-code cascade. Concentrating them here keeps
// ai-review.js down to orchestration and makes each concern testable without
// an LLM or a live provider.

const { appendAuditEntry } = require('./audit-log.js');
const stateStore = require('./port/state-store.js');
const { logEvent } = require('./log-helpers.js');
const { safeMsg, safeStack } = require('./log-safe.js');
const {
  ConfigError, AuthError, ProviderError, LLMError, ValidationError,
} = require('./errors.js');

/**
 * Ordered most-specific first: AuthError extends ProviderError, so it must be
 * matched before ProviderError. Exit codes match CLAUDE.md.
 */
const ERROR_TABLE = [
  [ConfigError, 2, 'config error'],
  [AuthError, 3, 'auth error'],
  [ProviderError, 4, 'provider error'],
  [LLMError, 5, 'LLM error'],
  [ValidationError, 7, 'validation error'],
];

/**
 * @param {any} e
 * @returns {{ code: number, label: string }}
 */
function describeError(e) {
  for (const [Cls, code, label] of ERROR_TABLE) {
    if (e instanceof Cls) return { code, label };
  }
  return { code: 4, label: `unexpected (${e?.name ?? 'Unknown'})` };
}

/**
 * @param {any} e
 * @returns {number}
 */
function exitCodeFor(e) {
  return describeError(e).code;
}

/**
 * Log a fatal error and return the process exit code it maps to. The single
 * error → exit-code cascade shared by all three runners.
 *
 * @param {any} e
 * @param {{ durationMs?: number, log?: typeof logEvent }} [opts]
 * @returns {number}
 */
function reportFatalError(e, { durationMs, log = logEvent } = {}) {
  const { code, label } = describeError(e);
  log('error', label, {
    errName: e?.name ?? 'Unknown', errMessage: safeMsg(e),
    stack: safeStack(e), durationMs,
  });
  return code;
}

/**
 * Build the per-run lifecycle context. Runners call these methods at the
 * points they need them (state append can happen mid-run, e.g. before the
 * summary needs the cumulative total).
 *
 * @param {{ env?: NodeJS.ProcessEnv, log?: typeof logEvent, now?: () => number }} [opts]
 */
function createLifecycle({ env = process.env, log = logEvent, now = Date.now } = {}) {
  const startMs = now();
  return {
    env,
    log,
    /** Milliseconds since the runner was entered. */
    elapsedMs: () => now() - startMs,

    /**
     * Append one invocation to the cross-run state store. No-op when disabled
     * or when the environment lacks a repo/PR. Never throws: a failed append
     * is a warn, not fatal.
     *
     * @param {{ prNumber?: string|number, invocation: { type: string, ts: string, costUsd: number, model: string, skipped?: string },
     *   enabled?: boolean, root?: string }} args
     * @returns {any|null} the next record, or null when skipped/failed
     */
    appendState({ prNumber, invocation, enabled = true, root } = {}) {
      if (!enabled) return null;
      // Deliberately GitHub-only: the cumulative cost ledger is keyed by
      // GITHUB_REPOSITORY (and reply's PR number comes from the GitHub-only
      // resolvePr), matching the pre-refactor behavior. Widening state tracking
      // to the other providers is a behavior change, not part of this refactor.
      const repo = env.GITHUB_REPOSITORY;
      const pr = Number(prNumber);
      if (!repo || !Number.isFinite(pr) || pr <= 0) return null;
      try {
        return stateStore.append(
          { repo, prNumber: pr, root: root ?? stateStore.resolveStateRoot(env) },
          invocation,
        );
      } catch (e) {
        log('warn', `state-store append failed (${invocation?.type ?? 'unknown'})`, {
          errMessage: safeMsg(e),
        });
        return null;
      }
    },

    /**
     * Append one JSONL audit entry, tagging it with the run's repository slug.
     * The caller supplies `repo` — each provider reports its own — so the
     * lifecycle stays platform-agnostic. No-op when disabled or no path. Never
     * throws.
     *
     * @param {{ path?: string, entry: Record<string, any>, enabled?: boolean, repo?: string|null }} args
     * @returns {boolean} true when a line was written
     */
    writeAudit({ path, entry, enabled = true, repo = null } = {}) {
      if (!enabled || !path) return false;
      try {
        appendAuditEntry(path, { ...entry, repo });
        return true;
      } catch (e) {
        log('warn', 'audit-log.write.failed', { event: entry?.event, errMessage: safeMsg(e) });
        return false;
      }
    },

    /** Report a thrown error and return its exit code. */
    reportFatal: (e) => reportFatalError(e, { durationMs: now() - startMs, log }),
  };
}

/**
 * Run a subcommand body under the shared fatal-error cascade. The runner
 * receives the lifecycle context, does its work, and returns a success exit
 * code; any thrown error is logged and mapped to its exit code.
 *
 * @template T
 * @param {{ env?: NodeJS.ProcessEnv, log?: typeof logEvent, now?: () => number }} opts
 * @param {(lifecycle: ReturnType<typeof createLifecycle>) => Promise<number>} runner
 * @returns {Promise<number>}
 */
async function runLifecycle(opts, runner) {
  const life = createLifecycle(opts);
  try {
    return await runner(life);
  } catch (e) {
    return life.reportFatal(e);
  }
}

module.exports = {
  runLifecycle, createLifecycle, reportFatalError, exitCodeFor, describeError,
};
