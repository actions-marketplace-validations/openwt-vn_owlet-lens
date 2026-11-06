# ADR-0018: The project is named Owlet Lens; identifiers stored in other people's data keep `ai-review`

- **Status**: Accepted
- **Date**: 2026-11-06

## Context

The project started as `ai-code-review`, a description rather than a name: it cannot be searched for and says nothing about the project. Before publishing it as open source it was renamed to **Owlet Lens**.

A deployed copy keeps some of the old name in places the project does not own. Review state lives in comment markers (`<!-- ai-review:v1:... -->`, ADR-0001), so every pull request already reviewed carries them. Workflows set `AI_REVIEW_*` variables, repositories hold `ai-review.config.yaml`, and workflow files call this project by its repository path.

## Decision

1. **Everything a reader sees is renamed:** the repository (`openwt-vn/owlet-lens`), the documentation, the action name, the prefix of the bot's comments (`[Owlet Lens]`), the learn branch prefix (`owlet-lens/learn`), the package and the command (`owlet-lens`, with `ai-review` kept as an alias), and the GitLab job names in the template.
2. **Identifiers that are stored in other people's data or configuration keep `ai-review`:** the marker prefix (`markers.prefix`), the state cache key, the `AI_REVIEW_*` variables, the `ai-review.config.yaml` file name and the workflow file names.
3. The repository is a new one with a clean history. A GitHub repository rename was rejected: `uses: owner/repo@ref` in a workflow is not redirected after a rename, so every consumer would break at once.

## Why

Changing the marker prefix would make the tool forget the threads it already posted: reopen, reply and close all depend on finding them again. The variables, the config file name and the workflow file names are contracts with every consumer, and changing them needs a deprecation path, not a flag day.

## Consequences

- A reader meets two names: Owlet Lens in the documentation and the comments, `ai-review` in configuration and markers. The documentation says which is which.
- A later rename of the configuration surface adds the new names as the preferred ones and keeps the old as a fallback for at least one major version. The marker prefix has no reason to change.
- Consumers move to the new repository by changing `uses:` to `openwt-vn/owlet-lens` and a new version tag. Their markers, variables and config keep working.

## Alternatives considered

1. **Rename everything at once**, markers and variables included: a clean surface, but it breaks existing deployments and orphans their threads.
2. **Rename the existing repository:** keeps the history, but breaks every `uses:` reference (see Decision 3) and publishes a history with internal context.
