# ADR-0016: The strict gate counts open blocking threads from earlier runs

- **Status**: Accepted
- **Date**: 2026-10-23

## Context

`review.strict` exited `8` only for the current run's `toPost` and `toReopen`. When a finding matches a thread that is still `active`, reconcile puts it in neither list (`reconcile.js`). So the push after a red run posted nothing new and exited `0`, and the required check turned green while the blocking finding was still unfixed. ADR-0015's skip inherited the same gap. The automated security review flagged it on that path.

## Decision

1. **Carried blockers.** With strict on, the decision also counts bot threads raised by earlier runs that are still `active` and whose stored severity is at or above `severityThreshold` (`carriedBlockers` in `lib/port/strict-port.js`). A bot thread is one whose root comment is the bot's and which has a fingerprint marker, the same test reconcile uses. Threads this run closes or reopens are left out, because the run already accounts for them.
2. **What clears one:** the bot marking the thread `fixed` (reconcile or a reply verdict) or `wontfix` (a reply verdict, ADR-0007). **The platform's Resolve button does not**: it would let any developer turn the gate green with one click. A `wontfix` still needs a reply argument that a model accepts, and it stays traceable in the thread.
3. **Severity comes from the finding's first comment** (`**[HIGH/bug]**`, `format-body.js`), because threads carry no structured severity. A severity that cannot be read does not block, and logs `strict.carried.severity.unknown`. That matches how `UNKNOWN` was already treated.
4. **The skip path checks too.** When ADR-0015 skips a push and strict is on, it calls `listThreads` once and exits `8` while a carried blocker remains. If that read fails, the run reviews instead of skipping, so it never reports green without having checked the gate. With strict off, the skip reads no threads, as before.
5. **No new config key.** Staying red until the finding is fixed is what `review.strict` already promised. Repositories on strict will see red where they used to see green after a second push, so the release notes call it out (minor bump).
6. **Reporting.** Carried entries appear in `strict.blockingFindings` with `carried: true`. The summary line reads "N blocking finding(s) (M from earlier runs, still open)".

## Consequences

- A strict run with an open blocking thread costs one extra `listThreads` call on a skip. A full review already reads the threads, so it costs nothing extra there.
- A developer who disagrees with a blocking finding has to reply. A model verdict of `wontfix` clears it, which makes the reply path the only way out of the gate, not the Resolve button. A team that wants a lead to sign off on `wontfix` for blocking findings needs a further change.
- An old thread whose first comment someone hand-edited until the severity is unreadable stops blocking, with a warning in the log. GitLab and Azure DevOps cannot report edits (ADR-0014 point 4, ADR-0015).
