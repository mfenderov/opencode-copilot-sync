# Clean Architecture and DDD Structure Design

Date: 2026-09-25
Status: Draft for review
Branch: agents/structure-clean-ddd

## Objective

Restructure `src/` into Clean Architecture layers and DDD bounded contexts without changing external behavior.

## Scope

Included:

- Full `src/` restructure.
- Provider, stream, protocol, model catalog, sync, usage, and infrastructure boundaries.
- Import-level test updates.
- Small behavior-preserving cleanups exposed by the move.

Excluded:

- Public extension behavior changes.
- Dependency upgrades.
- Test-framework changes.
- Scripts, release workflow, packaging, and documentation overhaul.

## Constraints

- No generic `common/` package.
- Shared code must have an explicit domain owner.
- `npm test`, `npm run lint`, and `npm run crap` remain green.
- Existing 234-test baseline remains passing.
- Work stays in the `agents/structure-clean-ddd` worktree until reviewed.

## Bounded Contexts

### Models

Owns model identity, catalog membership, capabilities, authors metadata, and token budgets.

### Chat

Owns Copilot chat requests, streaming responses, tool calls, reasoning handling, retries, and usage reporting.

### Usage

Owns quota snapshots and presentation state for the status bar and sidebar.

## Target Layout

```text
src/
  extension.ts
  models/
    domain/
      model.ts
      model-catalog.ts
      token-budget.ts
    application/
      synchronize-models.ts
    infrastructure/
      models-dev-client.ts
      model-enricher.ts
      model-cache.ts
  chat/
    domain/
      chat-session.ts
      chat-request.ts
      model-capability.ts
    application/
      send-chat-message.ts
      recover-stream.ts
    infrastructure/
      opencode-chat-client.ts
      vscode-chat-provider.ts
      sse-reader.ts
      chat-completions-parser.ts
      responses-parser.ts
      usage-reporter.ts
  usage/
    domain/
      usage-snapshot.ts
    application/
      refresh-usage.ts
    infrastructure/
      quota-client.ts
      usage-tree-adapter.ts
  infrastructure/
    vscode/
    filesystem/
    http/
```

## Dependency Rules

- Domain modules hold business rules and perform no I/O.
- Application modules orchestrate domain logic and side effects.
- Infrastructure modules perform VS Code, filesystem, and network I/O.
- No ports-and-interfaces ceremony: this extension targets VS Code only, so adapters may use the `vscode` API directly. The existing `vscode` test mock covers adapter seams.
- Infrastructure never defines cross-context business rules.
- Bounded contexts communicate through explicit domain models.
- `token-budget.ts` is owned by the Models context; Chat imports that domain model rather than duplicating it.
- `infrastructure/` contains technical adapters only.

## Data Flow

- `extension.ts` wires authentication, models, chat, sync behavior, usage UI, and proxy configuration.
- Model synchronization flows through Models application services into provider registration and compatibility-file writing.
- Chat requests flow through Chat application services into protocol conversion, OpenCode transport, stream parsing, and VS Code response parts.
- Stream framing, protocol parsing, usage reporting, and idle recovery remain separate infrastructure responsibilities.

## Migration Order

1. Extract Models domain token budgets and model value objects.
2. Split Chat protocol conversion and stream parsing.
3. Separate Chat application orchestration from VS Code and OpenCode adapters.
4. Move synchronization collaborators behind Models application services.
5. Move usage domain, application, and adapters.
6. Consolidate technical filesystem, HTTP, and VS Code helpers under `infrastructure/`.
7. Update imports and run all quality gates after each move group.

## Acceptance Criteria

- All external requests, retries, errors, model IDs, limits, usage payloads, sync writes, and UI behavior remain unchanged.
- No new runtime dependencies.
- `npm test`: 234 passed, 0 failed.
- `npm run lint`: passed.
- `npm run crap`: passed.
- Independent review finds no Critical or Important issues.
