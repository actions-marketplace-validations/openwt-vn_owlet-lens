# TL gate on Azure DevOps

Hold the AI back on a pull request until a team lead queues the manual build policy. Per-provider setup for [`review.tlGate.enabled`](./config.md#tl-gate-reviewtgate); the design is [ADR-0014](./adr/0014-tl-gate-reads-the-target-branch.md).

Azure needs two build-validation policies, because "for an Azure Repos Git repo, you cannot configure a PR trigger in the YAML file. You need to use branch policies."

## 1. Turn the switch on

In `ai-review.config.yaml` **on the pull request's target branch** (it is read from there, never from the PR's own copy):

```yaml
review:
  tlGate:
    enabled: true
    leads: ["{6f3a1c2e-1111-2222-3333-444455556666}"]   # Azure DevOps identity GUIDs
```

The id is what the press run reports as `Build.RequestedForId` (or `Build.QueuedById`). Find a user's GUID via **Organization Settings → Users → *user* → … → Details**, or read it off `GET https://dev.azure.com/{org}/_apis/identities?searchFilter=General&filterValue={display name}`. GUID casing differs between Azure endpoints; the comparison normalises it, so copy whichever form you find.

An empty `leads` with `enabled: true` is a config error (exit 2).

## 2. Add the button pipeline

[`examples/azure-pipelines-tl-gate.yml`](../examples/azure-pipelines-tl-gate.yml) is the pipeline the manual policy runs. Copy it into your repo (or a shared pipeline project) as, say, `azure-pipelines-tl-gate.yml`. Its essential parts:

```yaml
trigger: none
pr: none

variables:
  AI_REVIEW_TL_PRESSED: 'true'

steps:
  - checkout: self
  - task: NodeTool@0
    inputs:
      versionSpec: '22.x'
  - script: npm ci
  - script: node pipelines/scripts/ai-review.js review --provider=azure-devops
    env:
      AI_REVIEW_TL_PRESSED: $(AI_REVIEW_TL_PRESSED)
      SYSTEM_ACCESSTOKEN: $(SYSTEM_ACCESSTOKEN)
      # …or, instead of the line above, a PAT in a pipeline variable:
      # AZURE_DEVOPS_TOKEN: $(AZURE_DEVOPS_TOKEN)
```

**The pipeline declares the press itself.** Azure has no CI variable that distinguishes a manually queued build from a push in a way a push cannot imitate — `Build.Reason` is `Manual` for a build a user queued, but the gate keys off `AI_REVIEW_TL_PRESSED` because a `Manual` policy build queued by hand and one queued by a hook look identical in CI variables. Note that a variable declared at the top is not automatically an env var for a `script:` step: the `env:` block is required.

## 3. Add the two branch policies

Repos → your repo → **Policies** (or Branches → target branch → **Branch policies**):

1. **"AI code review"** — the automatic one, your existing policy. **Policy build:** Automatic. **Policy setting:** Blocking, or Optional if you would rather not block on build status.
2. **"AI code review — turn on (team lead)"** — the button. **Policy build:** your TL-gate pipeline from step 2. **Policy setting:** **Manual**, and **Optional**.

The settings are the whole button:

- "If you set the policy trigger to Manual, users must queue the build themselves."
- "Choose Optional to provide a notification of the build failure but still allow PRs to complete."

**Optional** is what keeps an unpressed policy and a denied press from blocking the PR. Optional also means findings a press run posts never fail strict mode. If you need a hard block, add a **TL approval rule** (branch policy) — not a pipeline change — that requires approval from a team lead subset before merge.

`System.PullRequest.PullRequestId` is initialized only for a build that ran because of a Git PR affected by a branch policy, which is how the provider finds the PR.

## 3.1 Add a TL approval rule (optional, for hard blocks)

If you need a hard block (e.g. strict mode findings must prevent merge), the "Optional" manual policy is not enough. Add a branch policy that requires approval from a team lead subset (e.g. **Require a minimum number of approvals from a subset of users** listing your leads). This is a separate branch policy — not part of the pipeline — and enforces that a lead must approve the PR before it can complete, independent of the build's exit code.

## 4. How a pull request goes

1. Someone opens a PR and pushes. The automatic policy build runs, sees `tlGate.enabled`, and posts "waiting for a team lead" with no LLM call. Exit 0.
2. A lead opens the PR's **Policies** page and queues the manual policy. The build reviews the PR and writes the bot's "AI on" note (who, and when).
3. Every later push finds that note and is reviewed as usual.

Turning the AI on is per PR and permanent — there is no turn-off.

## Open question

The Azure identity row that a policy build queued by hand reports is still to be confirmed against a live run (`Build.RequestedForId` / `Build.QueuedById` / `Build.RequestedFor`); `lib/providers/azure-tl-gate.js` carries the TODO. Until then the gate is **fail-closed**: a press whose id the platform does not report is refused, never trusted. If that turns out to be the wrong row, the documented fallback is for a team lead to comment `/ai-review on` on the PR — which needs a provider method that lists PR comments with author ids, since Azure has no PR-comment trigger to act on ("Comment triggers are supported only for GitHub repositories") and its thread API does not report who edited a comment.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| The PR is reviewed on the first push | The switch is off, or only on the PR's branch | Move `tlGate` to the **target** branch — a PR's own copy is ignored. |
| Queuing the policy does nothing | The pipeline does not export `AI_REVIEW_TL_PRESSED` into the step's `env:` | Restore both the `variables:` entry and the `env:` mapping. |
| "the platform reported no user id for this run" | Neither `Build.RequestedForId` nor `Build.QueuedById` was set | See **Open question** above. Add the identity GUID a queued build does report. |
| `ProviderError: Azure DevOps PR id missing` | The build was not triggered by a branch policy | Queue it from the PR's Policies page, not from the pipeline's own "Run pipeline" button. |
| The comment says the presser is not a lead | Their GUID is not in `leads` | Add it; casing does not matter. |
| Exit 2 and "leads is empty" | `enabled: true` with no ids | Fill in the list. |
| `ProviderError: Azure DevOps token missing` | `SYSTEM_ACCESSTOKEN` not exposed to the script step | Keep the `env:` line — Azure does not expose `$(SYSTEM_ACCESSTOKEN)` to scripts by itself. A PAT works the same way: map it explicitly as `AZURE_DEVOPS_TOKEN: $(AZURE_DEVOPS_TOKEN)`, with `$(AZURE_DEVOPS_TOKEN)` a pipeline variable holding the PAT, so the script is certain to see it. |
| Strict findings don't block merge | Manual policy is **Optional** | If you need a hard block, add a TL approval rule (branch policy) that requires approval from a team lead subset before merge (not a pipeline change). |
