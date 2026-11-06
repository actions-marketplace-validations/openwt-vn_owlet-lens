# Reply verdicts come from an LLM, not a regex

When a developer replies to a bot thread, the bot must decide whether the finding is `fixed`, `wontfix` or still `active`. A regex/keyword stub misreads replies such as "not fixing this, see X", replies with only a commit link, and disagreements. We use a small model (Claude Haiku by default, `reply.provider` / `reply.model`) with rich context: the full bot↔dev transcript, ±5 lines of current code at the finding location from HEAD, and the file's diff slice. The model must give evidence-citing reasoning. The extra cost per reply is small, and a wrong verdict silently closes or reopens a thread.

## Consequences

- The reply path needs an LLM key even when the review path uses another provider. The review and reply providers are chosen independently.
- `wontfix` verdicts feed `learn` (ADR-0004), so verdict quality directly affects proposed standards.
