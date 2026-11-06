# Bitbucket markers: runtime probe with inline-code fallback

Markers must stay in the stored comment (so the next run can parse them) and should be invisible when rendered, as they are on GitHub. Bitbucket Cloud keeps `<!-- … -->` in `content.raw` but renders it as visible text, and it auto-links a bare hex fingerprint as a commit. Hard-coding one style for Bitbucket would be wrong if Bitbucket rendering ever changed. So `resolveMarkerStyle()` posts a probe comment once per run and checks two things: the HTML token survives in `content.raw`, and it is absent from `content.html`. If both are true, the provider uses HTML markers. Otherwise it falls back to inline-code (`` `ai-review:…` ``), which is tidy and not auto-linked. Any probe error selects the safe inline-code fallback.

## Consequences

- `parseMarkers` reads both wire forms, so reconcile is style-agnostic, and a PR that mixes both styles is fine.
- Only `postThread` runs the probe. Reply and summary paths skip it (no extra network round-trip) and use inline-code. The difference is only cosmetic.
