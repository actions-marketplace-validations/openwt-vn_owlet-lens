# `review.severityThreshold` drops findings below it, not just the strict gate

Originally `review.severityThreshold` fed only `computeStrictDecision` (`lib/port/strict-port.js`) — it decided whether `--strict` exits 8, but every finding still posted regardless of severity. A repo setting `severityThreshold: medium` still got LOW comments on every PR, which read as a visibility bug: the one knob for "how noisy is this" didn't touch noise.

`filterFindings` in `lib/review-pass.js` now drops any finding ranked below `review.severityThreshold` (via `rankSeverity` from `lib/config.js`), right after the noise-filter gates (`shouldDropAsNoise`) and before `reconcilePort` builds the action plan. Dropped findings are counted under `stats.dropped.belowThreshold` and logged as `finding.dropped.below-threshold`.

This reverses an earlier explicit design choice, which kept sub-threshold findings visible on the theory that strict mode and noise reduction were separate concerns. In practice, one threshold knob that only gates CI exit codes — while still posting every LOW nit as a PR comment — was confusing: `severityThreshold: medium` reads as "I only care about medium+", not "I only fail CI on medium+."

## Consequences

- `review.severityThreshold` now does double duty: filters what posts (via `filterFindings`) and what blocks strict CI (via `computeStrictDecision`). Both read the same config value, so they can't drift out of sync.
- A LOW finding below `medium` (the default) never reaches `toPost`/`toReopen`, so it can't trigger `--strict` either — the strict-mode "only low severity found" case now means **no activity at all** (exit 0), not "activity, but not blocking" (previously exit 1).
- Existing threads for a finding that drops below the (raised) threshold on a later run are handled like any other missing finding — reconcile's close guards apply as usual.
