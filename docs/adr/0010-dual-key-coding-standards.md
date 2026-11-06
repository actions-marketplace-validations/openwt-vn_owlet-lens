# ADR-0010: Dual-key coding standards (`codingStandardsPath` + `codingStandards`)

- **Status**: Accepted
- **Date**: 2026-09-23

## Context

Issue #30 introduces per-language rule matching via `review.codingStandards: Array<{ glob, path }>`. The existing `review.codingStandardsPath: string` is the learn pipeline's read/write target — learn reads the file, appends a LEARNED block, and writes it back. Overloading a single key to serve both the new array form and the learn pipeline's single-file requirement creates ambiguity.

## Decision

Keep `codingStandardsPath` as the scalar learn read/write target. Introduce `codingStandards` as a separate array key for per-language review rules. Both can coexist:

- **`codingStandardsPath`** (string, optional): single file for learn read/write and suppression-rule extraction. When set alone, auto-wraps to `[{ glob: "*", path }]` for review.
- **`codingStandards`** (array, optional): `[{ glob, path }]` entries for per-language review injection.
- **Both set**: `codingStandardsPath` is prepended as `{ glob: "*", path }` to the array. Deduplicated by resolved absolute path.

Config-loader normalizes both forms into `config.review._codingStandards: Array<{ glob, path }>` at validation time. Downstream code (context-loader, ai-review.js) only sees the array.

## Alternatives considered

1. **Overload `codingStandardsPath` to accept string | array** — simpler config surface, but learn would need heuristics to find the write-target file (the `glob: "*"` entry? the first entry?). Fragile and surprising.

2. **Add `learn.codingStandardsPath`** — explicit learn target independent of review. Adds a new top-level key and forces users to configure the same path twice in the common case.

3. **Rename to `codingStandards` and deprecate** — clean forward but breaking. Users with `codingStandardsPath` in existing configs would need to migrate.

## Consequences

- Zero breaking change — existing `codingStandardsPath: string` configs work identically.
- Learn pipeline untouched — still reads/writes `codingStandardsPath`.
- Suppression rules extracted from `codingStandardsPath` only — per-language files are review-only.
- Reply path uses `codingStandardsPath` content only (catch-all).
- Users who only set `codingStandards` (array) get review but not learn/suppression — documented trade-off.
