# Reflection filter uses batch calls, not per-finding calls

The reflection filter validates findings in batches (≤20 per LLM call, split into ~15-sized chunks above that) instead of one call per finding like the reply evaluator does. The reply evaluator's per-finding approach is justified because each thread has unique developer context (thread transcript, code snippet, diff slice). Reflection has no developer context — every finding gets the same question ("is this factually correct and actionable?") against the same diff, so batching works.

Batch keeps reflection at ~1 Haiku call per review instead of N. At $0.25/MTok input, a 20-finding batch costs ~$0.002 versus ~$0.02 for 20 individual calls. The accuracy trade-off is acceptable: Haiku handles structured "for each item, verdict" prompts reliably, and the response maps back by array index so there's no ambiguity.

## Consequences

- Chunking at >20 findings adds a second LLM call. This is rare — most PRs produce <15 findings after noise filtering.
- Partial parse failures are handled per-chunk: verdicts that parsed are applied, findings without a verdict are kept (fail-open).
- If per-finding accuracy proves necessary later, the `reflectionFilter` interface stays the same — only the internal loop changes.
