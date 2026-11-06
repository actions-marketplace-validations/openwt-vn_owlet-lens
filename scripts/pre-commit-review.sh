#!/usr/bin/env bash
# Pre-commit hook: run AI review on staged changes via --dry-run --strict.
# Install: cp scripts/pre-commit-review.sh .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit
# Or symlink: ln -sf ../../scripts/pre-commit-review.sh .git/hooks/pre-commit
#
# The hook pipes `git diff --cached` into the review tool as stdin-diff
# so the review covers staged changes, not a remote PR.
#
# Requires: ANTHROPIC_API_KEY (or whichever LLM provider key is configured)
# Optional: AI_REVIEW_CONFIG — path to config file (defaults to ai-review.config.yaml)

# Skip if AI_REVIEW_PRECOMMIT is explicitly disabled
if [ "${AI_REVIEW_PRECOMMIT:-}" = "0" ] || [ "${AI_REVIEW_PRECOMMIT:-}" = "false" ]; then
  exit 0
fi

if git diff --cached --quiet; then
  exit 0
fi

echo "[Owlet Lens] Reviewing staged changes..."

CONFIG_ARGS=()
if [ -n "${AI_REVIEW_CONFIG:-}" ]; then
  CONFIG_ARGS+=("--config=${AI_REVIEW_CONFIG}")
fi

# Verify the review script exists before invoking — avoids confusing
# exit-code-1 from a missing module with real review activity.
SCRIPT="$(git rev-parse --show-toplevel)/pipelines/scripts/ai-review.js"
if [ ! -f "$SCRIPT" ]; then
  echo "[Owlet Lens] $SCRIPT not found — skipping." >&2
  exit 0
fi

# Run in dry-run + strict mode so the tool itself gates on severity.
# Exit code 8 = blocking findings; 0 = clean; 2-7 = tool errors.
EXIT_CODE=0
node "$SCRIPT" review --dry-run --strict "${CONFIG_ARGS[@]}" || EXIT_CODE=$?

case $EXIT_CODE in
  0)
    echo "[Owlet Lens] No blocking findings."
    ;;
  8)
    echo "[Owlet Lens] Blocking findings detected — commit blocked."
    echo "[Owlet Lens] To bypass: git commit --no-verify"
    exit 1
    ;;
  1)
    echo "[Owlet Lens] Review activity (non-blocking findings)."
    ;;
  6)
    echo "[Owlet Lens] Partial failure — some operations failed. Commit allowed."
    echo "[Owlet Lens] Check stderr for details." >&2
    ;;
  2|3|4|5|7)
    echo "[Owlet Lens] Review tool failed (exit $EXIT_CODE) — commit allowed."
    echo "[Owlet Lens] Check stderr for details." >&2
    ;;
  126|127)
    echo "[Owlet Lens] node not found or not executable — install Node.js or set AI_REVIEW_PRECOMMIT=0 to skip."
    ;;
  *)
    echo "[Owlet Lens] Unexpected exit code $EXIT_CODE — commit allowed."
    ;;
esac

exit 0
