# ADR-0014: The TL gate reads its switch and lead list off the PR's target branch

- **Status**: Accepted
- **Date**: 2026-10-05

## Context

The tool reviews every pull request on every push. A team that wants the AI to wait until a lead opens the gate has no way to ask for that, and no code anywhere knows who started a run: `PRMetadata` carries no actor, and none of the platforms' "who started this" variables (`GITHUB_RUN_ATTEMPT`, `GITHUB_TRIGGERING_ACTOR`, `CI_JOB_MANUAL`, `BITBUCKET_STEP_TRIGGERER_UUID`, `Build.RequestedFor`) were read.

The obvious implementation — read `review.tlGate` from the config in the working folder — does not hold. In CI the working folder **is** the PR checkout (`ai-review.yml` checks out the PR; a `pull_request` event "runs the workflow file from the merge commit of the pull request"). A PR could therefore ship its own config that switches its own gate off, which is the tool reviewing itself.

## Decision

1. **The gate is a decision before any LLM work, not a review step.** `runReview` calls `tlGate.evaluate` right after `getPRMetadata()` and before the LLM clients are constructed, so a held-back PR costs one config read and one comment. The decision lives in `lib/port/tl-gate.js` because it cuts across all four providers; the two comment writes around the review live in `lib/port/tl-gate-run.js`.
2. **The switch and the lead list are read from the config file on the PR's target branch** - `provider.getFileContent(configPath, meta.targetSha)`. A PR cannot move its own gate. That holds for the *filename* as well as the content: the candidates are probed against the target branch, not taken from the working folder (`resolveConfigPath` still answers "which file is this run using" for logs only). Choosing the name locally would let a PR that adds or deletes a candidate file steer the gate onto a path the target branch does not have, where the read 404s and reads as "no config" - the gate disengaging silently while the PR reviews itself.
3. **Those two keys get no `${VAR}` interpolation and no env or CLI override**, unlike every other config key (`config-merge.js` interpolates and overrides). Interpolation would let a PR interpolate its way onto the lead list, and a CI variable could flip the switch. So the read is a raw `yaml.load` of the target-branch document, not `loadConfig`.
4. **The "AI on" state is the bot's own comment** on the PR, written with `upsertSummaryComment` — ADR-0001's rule that the PR is the source of truth, so there is nothing on disk to lose. Not the summary comment: in append mode every run adds a new one. Two marker keys, because the comment slot and the state are not the same thing: `tl-gate` is the slot (every gate comment carries it, so the PR keeps exactly one and later runs update it in place), and `tl-on` is the state, written only into the note a lead's press creates. A single key would let the bot's own "still waiting for a team lead" comment read back as permission and open the gate on the next push with no press at all. Only the bot's own comment counts; on GitHub a note someone else edited (GraphQL `IssueComment.editor`) is ignored, because "anyone with write access to a repository can edit comments". The mirror image of "the bot authors the comment the gate trusts" is that no untrusted text reaches a bot-authored body verbatim: the presser's platform display name is sanitised (`safeLabel`) before it goes in, since a name carrying marker syntax would let a non-lead's *denied* comment answer the next push's "is the AI on?" lookup and open the gate. The id beside it is the authoritative field.
5. **Only a button press turns the AI on, and only from a listed lead.** A push never can. There is no turn-off. `reply` is not gated.
6. **Platform facts stay in each provider** (ADR-0012): `getTriggerInfo()` reports whether this run is a button run and who pressed it, `findBotComment(markerKey)` finds the bot's own note. Bitbucket and Azure DevOps have no event that distinguishes a re-run from a push, so their templates export `AI_REVIEW_TL_PRESSED` themselves.
7. **Ids, never usernames**, in `review.tlGate.leads`. A login "can change over time"; a numeric user id or an account UUID cannot.
8. **The gate is off by default, and soft-fails off.** No `tlGate` block, no config file on the target branch, a provider that cannot read files, or a target-branch document that does not parse all mean "behave exactly as before" — a feature that is off by default must not break a repository that never asked for it. A *malformed* `tlGate` block is different: that is an operator's own switch, so it raises `ConfigError` (exit 2) rather than being guessed at. `enabled: true` with an empty `leads` list is likewise exit 2 — nobody could open the gate.
9. **Held runs exit 0.** Waiting for a lead is the configured behaviour, not a failure; failing the build would punish a repository for doing what it asked. A failed waiting or denied comment is a warn for the same reason. A failed **"AI on" note** is different: it loses the gate's only memory, so it counts as a partial failure (exit 6) like any other write.

## Alternatives considered

1. **Read the switch from the working folder, like every other config key.** Rejected: in CI that is the PR's own copy, so a PR could switch its own gate off.
2. **Interpolate and allow overrides, for consistency with the rest of the config.** Rejected for the same reason plus one more: a CI variable in the PR's control could flip the switch.
3. **Keep the switch in the repo's settings (a CI variable) instead of a config file.** Then it is not versioned with the target branch, so the two could disagree, and there is no natural place to keep the lead list next to it.
4. **Read the switch off the target branch, but store "AI on" in a file** (ADR-0001's alternatives). Rejected: the PR is where the state already lives, and the bot's comment is visible to everyone deciding whether to merge.
5. **Make the gate a review pass that returns "no findings".** Rejected: the LLM call would already have been paid for. The gate's whole value is that a held PR costs nothing.
6. **Gate `reply` too.** Rejected for now: `reply` only re-evaluates threads the AI already wrote, so a PR with no AI findings has nothing to reply to. It is a smaller change if the answer to that changes.
7. **Let the `/review` comment turn the AI on.** Rejected: the issue decided the button is the only door, and on GitHub a `/review` re-run is not a `pull_request` event, so it cannot be mistaken for a press.

## Consequences

- The gate cannot be hard-enforced: a PR can edit its own pipeline file and skip it. Accepted — the edit shows in the PR diff, and the platform's own "a TL must approve before merge" rule (a separate setup-guide issue) still holds. All four platforms run the PR's own pipeline or workflow file.
- Strict mode has a gap on GitLab and Azure DevOps: their button runs are `allow_failure: true` / Optional, so findings a press run posts never fail strict mode. Bitbucket has no gap — a failed manual step fails the PR's build status (live-tested 2026-10-05).
- GitHub re-runs are limited: 30 days after the initial run, 50 re-runs per run.
- Edit detection is uneven. GitHub reports an editor (checked). GitLab does not expose it, Bitbucket says "You can only edit your own comments", Azure DevOps's docs do not say. `BotComment.editedByOther` is `false` on those three — an accepted limit, not a claim that edits cannot happen.
- Enabling the switch on an existing repository holds back every open PR at once, since none of them carry the note yet. Leads press the button per PR, or on the next push to each.
- `tl-on` is a permanent marker key on the PR. Deleting the bot's own "AI on" comment re-closes the gate; nothing else on the PR can.
- Every held-back run prints `{"provider":…,"prId":…,"tlGate":{"on":false,"reason":…,"noteAction":…}}`, and every review prints the same block with `on: true`, so a build log says why nothing was reviewed.
