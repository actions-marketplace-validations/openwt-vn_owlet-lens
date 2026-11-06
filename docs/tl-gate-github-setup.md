# TL gate on GitHub

Hold the AI back on a pull request until a team lead re-runs the review. Per-provider setup for [`review.tlGate.enabled`](./config.md#tl-gate-reviewtgate); the design is [ADR-0014](./adr/0014-tl-gate-reads-the-target-branch.md).

## 1. Turn the switch on

In `ai-review.config.yaml` **on the pull request's target branch** (it is read from there, never from the PR's own copy):

```yaml
review:
  tlGate:
    enabled: true
    leads: ["12345", "67890"]   # numeric GitHub user IDs
```

Get a numeric id from the user's profile page — the numeric id is in the API response (`GET /user/{account_id}`), or hover a commit authored by them. Ids, not logins: a login "can change over time".

An empty `leads` with `enabled: true` is a config error (exit 2).

## 2. No workflow change

There is nothing to add. The button **is** GitHub's own **Re-run all jobs** on the PR's AI review run: the gate recognises it from a `pull_request` event with `GITHUB_RUN_ATTEMPT` > 1, and resolves `GITHUB_TRIGGERING_ACTOR` through `GET /users/{username}` to the durable numeric id.

Two consequences worth knowing:

- **Write access can re-run.** Write, Maintain and Admin all hold "Create, edit, run, re-run, and cancel GitHub Actions workflows". The code checks `leads` anyway, so a re-run by anyone else posts an explanation and leaves the AI off (exit 0).
- **A `/review` comment cannot open the gate.** It is an `issue_comment` event, not `pull_request`, so it never looks like a press. Once the AI is on, `/review` still reruns the review exactly as before.

## 3. How a pull request goes

1. Someone opens a PR and pushes. The `review` job runs, sees `tlGate.enabled`, and posts "waiting for a team lead" with no LLM call. Exit 0, so the check stays green.
2. A lead opens the latest **Owlet Lens** run in the Actions tab and clicks **Re-run all jobs**. The run reviews the PR head and writes the bot's "AI on" note (who, and when).
3. Every later push finds that note and is reviewed as usual.

A re-run reuses the original event's SHA, but the provider reads the head from the API, so the re-run reviews whatever the PR head is now. Turning the AI on is per PR and permanent — there is no turn-off.

## Limits

- A re-run is available **up to 30 days** after the initial run, and a run can be re-run **at most 50 times**.
- Only the bot's own note counts, and the gate checks whether someone else edited it: "Anyone with write access to a repository can edit comments on issues, discussions, pull requests, and commits." Deleting the note re-closes the gate.
- Strict mode works normally here: findings on a re-run fail the run, and a failed check blocks a merge.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| The PR is reviewed on the first push | The switch is off, or only on the PR's branch | Move `tlGate` to the **base** branch — a PR's own copy is ignored. |
| Re-running does nothing | `GITHUB_RUN_ATTEMPT` is 1 | A press must be a re-run of an existing run; the first run of a new push is not a press. |
| The comment says the presser is not a lead | Their numeric id is not in `leads` | Add it. A `GITHUB_TRIGGERING_ACTOR` that resolves to no user is also reported this way. |
| Exit 2 and "leads is empty" | `enabled: true` with no ids | Fill in the list. |
| "the note was edited by someone else" in the log | A human edited the bot's "AI on" comment | Have the bot rewrite it: a lead re-runs the review. |
