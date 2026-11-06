# TL gate on Bitbucket

Hold the AI back on a pull request until a team lead presses **Run** on the manual step. Per-provider setup for [`review.tlGate.enabled`](./config.md#tl-gate-reviewtgate); the design is [ADR-0014](./adr/0014-tl-gate-reads-the-target-branch.md).

## 1. Turn the switch on

In `ai-review.config.yaml` **on the pull request's target branch** (it is read from there, never from the PR's own copy):

```yaml
review:
  tlGate:
    enabled: true
    leads: ["{1c2d3e4f-5a6b-7c8d-9e0f-1a2b3c4d5e6f}"]   # Bitbucket account UUIDs, braces included
```

The id is the same value `BITBUCKET_STEP_TRIGGERER_UUID` holds; the live test confirmed it is the presser's account UUID. **Keep the braces** — they are what the variable contains. (Comparison strips them, so a list without braces also matches; write what the platform gives you.)

An empty `leads` with `enabled: true` is a config error (exit 2).

## 2. Keep the manual step

[`bitbucket-pipelines.yml`](../bitbucket-pipelines.yml) ships it as the second step of the `pull-requests` pipeline:

```yaml
      - step:
          name: Turn AI review on (team lead)
          trigger: manual
          script:
            - npm ci
            - export AI_REVIEW_TL_PRESSED=true
            - node pipelines/scripts/ai-review.js review --provider=bitbucket
```

**Do not drop the `export AI_REVIEW_TL_PRESSED=true`.** `BITBUCKET_STEP_TRIGGERER_UUID` is also set in the *automatic* step (live-tested 2026-10-05), so on its own it cannot tell a press from a push. The manual step marks its own run instead.

Bitbucket's own rules for manual steps, which the template already satisfies:

- "Can't be the first step or stage in a pipeline" — so the automatic review step stays first.
- "Can only be triggered by users with write access to the repository."
- `BITBUCKET_PR_ID` **is** set in the manual step, so the provider finds the PR.

## 3. How a pull request goes

1. Someone opens a PR and pushes. The review step runs, sees `tlGate.enabled`, and posts "waiting for a team lead" with no LLM call. Exit 0.
2. A lead presses **Run** on the "Turn AI review on (team lead)" step. The step reviews the PR and writes the bot's "AI on" note (who, and when).
3. Every later push finds that note and is reviewed as usual.

A failed manual step fails the PR's build status (live-tested), so blocking findings on a press run do block — subject to Premium: "If your workspace has a Premium plan, repository admins can prevent pull requests from merging based on build status." Turning the AI on is per PR and permanent.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| The PR is reviewed on the first push | The switch is off, or only on the PR's branch | Move `tlGate` to the **destination** branch — a PR's own copy is ignored. |
| Pressing Run does nothing | The step does not export `AI_REVIEW_TL_PRESSED` | Restore the `export` line; the triggerer UUID alone is not enough. |
| Bitbucket rejects the pipeline | The manual step was made the first one | Put the automatic review step first. |
| The comment names only a user id | The account lookup failed | Harmless — the decision uses the id. Only the display name is missing. |
| The comment says the presser is not a lead | Their account UUID is not in `leads` | Add it, braces included. |
| Exit 2 and "leads is empty" | `enabled: true` with no ids | Fill in the list. |
