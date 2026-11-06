# Reflection skips CRITICAL findings unconditionally

CRITICAL-severity findings bypass the reflection filter entirely. This is hardcoded in `review-pass.js`, not configurable. The reflection filter splits findings into `criticals` (passed through) and `reflectable` (sent to the reflector), then merges them back.

The asymmetry is deliberate: a false positive on a CRITICAL finding costs one developer a minute to dismiss. A false negative — the reflector incorrectly dropping a real security vulnerability or data-loss bug — can cost an incident. The reflector uses a smaller model (Haiku) that is more likely to misjudge severity than the primary review model (Opus/Sonnet), so the safe default is to never let it gate CRITICAL findings.

This mirrors the philosophy in the learn pipeline, where security findings were originally excluded from harvesting to prevent accepted-risk patterns from becoming team standards (see ADR-0004, which later relaxed that gate — reflection keeps its gate because the failure mode is different: learn proposes a PR for human review, reflection silently drops).

## Consequences

- CRITICAL findings are always posted, even when `review.reflection: true`. The reflection summary log and cost still reflect only the non-CRITICAL subset.
- If a team wants to suppress specific CRITICAL false positives, `review.noiseCategories` or coding standards are the correct tool, not reflection config.
