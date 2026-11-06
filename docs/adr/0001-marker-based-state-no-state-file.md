# Cross-run identity lives in comment markers, not a state file

Each run has to recognise the threads that earlier runs posted, so it can reply, reopen or close them. Two options were a persistent state file or putting the identity inside the comment body. We chose to embed versioned HTML-comment markers (`<!-- ai-review:v1:status -->`, `<!-- ai-review:fingerprint=<16-hex> -->`) in every bot comment. Reconcile rebuilds state from the PR's threads on each run. The PR is the source of truth. There is nothing on disk to lose, migrate or keep in sync across CI runners, and a cache miss can never make the bot forget its own threads.

## Consequences

- Fingerprint = `sha256(filePath:line:ruleId)[:16]`. If a finding moves line or rule id, it becomes a new identity, so reconcile must guard against closing the old thread by mistake (see ADR-0002).
- The `v1` prefix lets a future marker schema ignore old markers instead of misreading them.
- Persistent cross-PR data (cumulative cost) is optional (`@actions/cache`) and never needed for correctness.
