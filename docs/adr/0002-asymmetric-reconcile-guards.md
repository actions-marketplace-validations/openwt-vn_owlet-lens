# Reopen is permissive, close is strict

Reconcile can match a finding to a thread by fingerprint alone. That match is not perfectly reliable: a human comment can contain fingerprint-shaped text, and the LLM can drop or move a finding between runs because of sampling drift, a model swap or a severity filter. So the two actions are guarded differently, according to the cost of getting them wrong. A **reopen** only replies and sets the status back to active, so a wrong reopen is at worst a noisy reply. It needs only a fingerprint match. A **close** hides a live issue, so it needs every check: `marker.version` present, a bot-authored first comment, the bot holding the last word (a dev reply the bot has not answered is owed a verdict from the reply pass, not a silent `fixed`), the file covered, and the thread's line changed in this diff.

## Consequences

- A thread may stay open after its issue is fixed, if the fix touched other lines. We accept this: an extra open thread costs less than a wrongly closed one.
- Do not relax the close guards to "clean up" stale threads without reopening this ADR.
