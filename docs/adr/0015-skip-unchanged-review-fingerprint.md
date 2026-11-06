# ADR-0015: Skip a push whose review fingerprint matches the last full review

- **Status**: Accepted
- **Date**: 2026-10-23

## Context

Every `review` run sends the whole PR diff (target...head) to the LLM. When a developer merges the target branch (usually `develop`) into the PR, the PR's own changes stay the same, but the run still spends a full review. Because the model is not deterministic, it can also post new findings on code it already reviewed. Noise is the main cost; tokens are second.

Nothing recorded what the last review covered: no marker or summary carried a SHA or a hash, and none of the four providers has a commit-list or compare API. Only GitHub reports the previous head (`before`, on `synchronize`).

## Decision

1. **Detect by content, not by the git graph.** A run is skipped when its **review fingerprint** equals the one stamped by the last full review. This works the same on every provider and needs no new provider API. It also covers a rebase onto the target and empty commits. An "evil merge", where conflict resolution adds code, changes the fingerprint and is reviewed. A commit-message regex (`Merge branch 'develop'`) was rejected as fragile. A parent-graph check was rejected because it needs a `before` SHA that only GitHub has, plus commit APIs or a deep clone everywhere, and it misses an evil merge.
2. **The PR's own changes, not the raw diff.** For each reviewable file the fingerprint takes the path, the change status, the rename source, and the added and removed lines in order. Hunk headers and context lines are left out, because a merge from the target shifts both when the target touched the same files. Lines before the first hunk are file headers, so a removed line starting with `--` still counts. Files the LLM never sees are left out through the same `partitionReviewable` the review pass uses, so the two cannot drift.
3. **What else is hashed.** The effective config without `auth` (a rotated key must not force a review; a model, threshold or filter change must), and the documents the prompt carries: coding standards, learned suppressions and `contextPaths` documents. **Traced import bodies are not hashed.** A merge from the target usually changes files the PR imports, so hashing them would stop the skip from firing in exactly the case it exists for. This is part of the accepted risk below. The tool version is left out, so a release does not re-review every open PR. Config keys are sorted before hashing. The hash is truncated SHA-256, 32 hex characters, with a version field so a format change never matches an old marker.
4. **Stored as a key marker on the bot's own summary.** A full review stamps `reviewed-<hash>` into the summary comment (ADR-0001: the PR is the state). The check is `findBotComment('reviewed-<hash>')`. **Only the bot's own, unedited comment counts**, the same rule as ADR-0014 point 4. The hash is public and deterministic, so without that rule anyone could compute it for unreviewed code, paste the marker, and make the next run skip.
5. **Written only by a complete run.** The marker is stamped only when no write failed and every chunk parsed, so exit `0`, `1` or `8`. After a partial failure (exit `6`) the next push retries the failed posts instead of skipping. A dry run never writes it.
6. **Every doubt reviews.** No marker, an edited marker, a failed lookup, or a failed trigger lookup all mean "review". A run a person asked for never skips: a button run (`getTriggerInfo().manual`: GitHub re-run, GitLab manual job, `AI_REVIEW_TL_PRESSED` on Bitbucket and Azure), `--force-review`, or `AI_REVIEW_FORCE=1`.
7. **The check runs after the TL gate and before any LLM client is built.** A held PR is held exactly as before. A skip costs the diff fetch, local file reads and one comment lookup. It reads no threads, writes nothing to the PR, prints `{"skipped":"no-net-change",…}`, records a `costUsd: 0` entry in the audit log and state store, and exits `0`.
8. **On by default** (`review.skipUnchanged: true`).

## Consequences

- ~~A skip exits `0` even if the last review triggered the strict gate.~~ Superseded by [ADR-0016](./0016-strict-gate-counts-open-blocking-threads.md): with `review.strict` on, a skip reads the threads once and exits `8` while a blocking thread is still open.
- **Accepted risk:** a target merge can break lines the PR did not change (the target renames a function the PR still calls). The skip will not catch it. The previous review would not have either, because it only sees the diff. Build and tests catch this.
- In `summary.mode: append`, `findBotComment` matches any earlier summary. A PR reverted to an exact earlier state skips, and threads raised on the reverted code stay open until the next real change. In `sticky` mode the single summary holds only the latest fingerprint, so this does not happen.
- "Unedited" is only as good as the platform's report, as in ADR-0014. GitHub reports the editor. Bitbucket lets only the author edit. GitLab (Maintainers and Owners can edit other users' notes) and Azure DevOps report no editor, so `editedByOther` is always false there: someone with that role could edit the bot's summary to plant a marker and make the next push skip. This is an accepted limit, the same as the AI on note.
- One hash covers the whole PR. Per-file hashes would help a future incremental review, and will be designed with it.
