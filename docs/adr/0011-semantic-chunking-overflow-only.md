# ADR-0011: Semantic file bundling applies to overflow chunks only

- **Status**: Accepted
- **Date**: 2026-09-23

## Context

`chunk-diffs.js` splits overflow files (those that didn't fit the main LLM call) into token-budget-sized chunks. The split is purely greedy — a service file and its test can land in different chunks, losing cross-file context the LLM needs to catch spanning issues.

Issue #31 proposes grouping files by semantic relationship: import graph edges and test/implementation pairing.

## Decision

1. **Overflow only.** Semantic grouping applies to the overflow chunking step, not the main call. The main call already includes every file that fits its budget, prioritized by changed-line count. Grouping there would sacrifice high-signal files to keep low-signal related files together.

2. **Pre-computed groups.** `buildFileGroups(diffs, fileDiffs)` in `chunk-diffs.js` builds groups from two signals, then `chunkFileDiffs` receives them via `opts.groups` and tries to keep each group in one chunk. The chunker doesn't know about imports — separation of concerns.

3. **Two signals, not three.** Import graph (via `buildImportGraph` in `import-tracer.js`, diff-only, no filesystem) and test/implementation basename pairing. Directory-based grouping was in the original spec but deferred — it's the weakest signal with the highest false-positive rate for unrelated files that happen to share a directory.

4. **Budget is the hard constraint.** When a semantic group exceeds the token budget, it's split file-by-file (falling back to the original greedy behavior). A log warning is emitted. The LLM context window is non-negotiable.

## Alternatives considered

1. **Group the main call too** — would deprioritize high-signal files in favor of keeping groups intact. The main call's changed-line-count priority is the right heuristic for "what to show the LLM first."

2. **Directory-based grouping** — groups files in the same directory. Low precision: `src/utils/` may contain 20 unrelated utility files. Deferred until there's evidence it improves review quality.

3. **Filesystem-based import resolution** — `buildImportGraph` could use `resolveImport` (which hits the filesystem) instead of heuristic path matching against the diff set. Unnecessary: we only need edges between changed files, and the diff set is the complete list. Avoids filesystem I/O in the review path.

## Consequences

- Overflow chunks now co-locate related files, improving cross-file review quality.
- When no relationships exist, files may be re-ordered largest-first, so chunk boundaries can differ from legacy in-order greedy packing, though every file is still chunked and reviewed exactly once.
- No config knob — always on. Strictly better than budget-only chunking.
- `import-tracer.js` exports `buildImportGraph` in addition to the existing `traceImports`.
- `chunk-diffs.js` exports `buildFileGroups` and accepts `opts.groups` in `chunkFileDiffs`.
