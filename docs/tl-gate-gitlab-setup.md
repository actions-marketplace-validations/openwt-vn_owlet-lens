# TL gate on GitLab

Hold the AI back on a merge request until a team lead presses **Play**. Per-provider setup for [`review.tlGate.enabled`](./config.md#tl-gate-reviewtgate); the design is [ADR-0014](./adr/0014-tl-gate-reads-the-target-branch.md).

## 1. Turn the switch on

In `ai-review.config.yaml` **on the merge request's target branch** (it is read from there, never from the MR's own copy):

```yaml
review:
  tlGate:
    enabled: true
    leads: ["1234", "5678"]   # numeric GitLab user IDs
```

Get a numeric id from **User settings → Preferences → Profile** (the `User ID` field), or `GET /api/v4/users?username=<login>`. Ids, not usernames: "By default, all users can create top-level groups and change their usernames."

An empty `leads` with `enabled: true` is a config error (exit 2) — nobody could open the gate.

## 2. Keep the manual job

[`examples/gitlab-ci.yml`](../examples/gitlab-ci.yml) ships it:

```yaml
owlet-lens-review-tl:
  extends: .ai-review-base
  stage: test
  when: manual
  allow_failure: true
  variables:
    AI_REVIEW_CMD: review
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
  script: *ai-review-run
```

If your `.gitlab-ci.yml` predates the gate, add that job. Nothing `needs:` it — a press is optional, so making another job depend on it would stall the pipeline.

The job is what the gate watches for: `when: manual` makes GitLab set `CI_JOB_MANUAL=true` on that run, and `GITLAB_USER_ID` is "the ID of the user who started the job" in a manual job.

- **`allow_failure: true`** keeps the pipeline green when a lead is not around. GitLab: "If `allow_failure: true` is set, the job is always considered successful."
- **Anyone with permission to merge to the assigned branch** can press Play. The code checks `leads` anyway, so a press by anyone else posts an explanation and leaves the AI off (exit 0).

## 3. How a merge request goes

1. Someone opens an MR and pushes. `owlet-lens-review` runs, sees `tlGate.enabled`, and posts "waiting for a team lead" with no LLM call. Exit 0.
2. A lead opens the MR pipeline widget and presses **Play** on `owlet-lens-review-tl`. The run reviews the MR and writes the bot's "AI on" note (who, and when).
3. Every later push finds that note and is reviewed as usual.

Turning the AI on is per MR, and permanent — there is no turn-off. A lead may press on their own MR.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| The MR is reviewed on the first push | The switch is off, or only on the MR's branch | Move `tlGate` to the **target** branch — a PR's own copy is ignored. |
| Pressing Play does nothing | The gate has no `AI_REVIEW_TL_PRESSED` to read on GitLab; it reads `CI_JOB_MANUAL` | Make sure the job is `when: manual` on an MR pipeline. |
| "no user id for this run" in the comment | `GITLAB_USER_ID` was absent | Unlikely on GitLab; the gate refuses the press rather than trusting it. |
| The comment says the presser is not a lead | Their user id is not in `leads` | Add the numeric id. Check for quotes and whitespace. |
| The comment says the switch is on but nothing is listed | `leads` empty | Exit 2 is expected here; fill in the list. |
| Blocked findings never fail the pipeline | The press job is `allow_failure: true` | Blocking on build status needs a Premium plan; a TL approval rule is the supported route. |
