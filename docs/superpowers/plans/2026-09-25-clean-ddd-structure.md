# Clean DDD Structure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure `src/` into Models, Chat, and Usage bounded contexts with domain/application/infrastructure layers, preserving all external behavior.

**Architecture:** Strangler-style moves behind re-export shims: each task moves one area, leaves `export ... from` shims in old files so existing tests keep resolving, fixes imports, then greens the gates. No new runtime behavior.

**Tech Stack:** TypeScript strict, NodeNext modules, Node built-in test runner, c8, ESLint, esbuild.

**Spec:** `docs/superpowers/specs/2026-09-25-clean-ddd-structure-design.md`

## Global Constraints

- No generic `common/` package.
- Shared code must have an explicit domain owner.
- `npm test`, `npm run lint`, and `npm run crap` remain green.
- Existing 234-test baseline remains passing.
- Work stays in the `agents/structure-clean-ddd` worktree until reviewed.
- No ports-and-interfaces ceremony: adapters may use the `vscode` API directly.
- No cleanups inside move commits; cleanups go in separate commits.

## Review Focus

- Stale import paths after a move break compilation of unrelated test files first; each task pins the exact failing import.
- Re-export shims left behind permanently would recreate the old coupling; the final task removes every shim.
- `token-budget.ts` imported by Chat must stay a pure domain model with no VS Code references.
- `usage` term clash: stream usage reporting vs quota UI must end up in different modules with distinct names.
- `extension.ts` must end up as wiring only, with catalog classification and sync orchestration moved out.

---

### Task 1: Extract Models domain token budget and model types

**Files:**
- Create: `src/models/domain/model.ts`
- Create: `src/models/domain/token-budget.ts`
- Modify: `src/provider-protocol.ts` (replace moved code with re-export shims)
- Modify: `src/enricher.ts` (import from new location)
- Modify: `src/provider.ts` (import from new location)

**Interfaces:**
- Consumes: nothing new.
- Produces: `src/models/domain/model.ts` exports `OpenCodeModelMeta`; `src/models/domain/token-budget.ts` exports `ModelTokenLimits`, `resolveModelTokenLimits`.

Move exactly these declarations out of `src/provider-protocol.ts`:

```ts
// src/models/domain/model.ts
export interface OpenCodeModelMeta {
  id: string;
  name: string;
  family: string;
  catalog?: 'go' | 'zen';
  isFree?: boolean;
  contextWindow: number;
  maxOutputTokens: number;
  vision: boolean;
  thinking?: boolean;
  supportsReasoningEffort?: string[];
  defaultReasoningEffort?: string;
  apiType?: 'chat-completions' | 'messages' | 'responses';
}
```

```ts
// src/models/domain/token-budget.ts
export interface ModelTokenLimits {
  contextWindow: number;
  maxInputTokens: number;
  maxOutputTokens: number;
}

const DEFAULT_CONTEXT_WINDOW = 1_048_576;
const DEFAULT_MAX_OUTPUT_TOKENS = 65_536;
const MIN_SAFE_CONTEXT_WINDOW = 4;
const MAX_OUTPUT_CONTEXT_RATIO = 0.25;

export function resolveModelTokenLimits(
  contextWindow: unknown,
  maxOutputTokens: unknown
): ModelTokenLimits {
  const context = typeof contextWindow === 'number' &&
    Number.isSafeInteger(contextWindow) &&
    contextWindow >= MIN_SAFE_CONTEXT_WINDOW
    ? contextWindow
    : DEFAULT_CONTEXT_WINDOW;
  const output = typeof maxOutputTokens === 'number' &&
    Number.isSafeInteger(maxOutputTokens) &&
    maxOutputTokens > 0
    ? maxOutputTokens
    : DEFAULT_MAX_OUTPUT_TOKENS;
  const safeOutput = Math.min(output, Math.floor(context * MAX_OUTPUT_CONTEXT_RATIO));

  return {
    contextWindow: context,
    maxInputTokens: context - safeOutput,
    maxOutputTokens: safeOutput,
  };
}
```

Keep this shim in `src/provider-protocol.ts` so existing importers keep working:

```ts
export type { OpenCodeModelMeta } from './models/domain/model.js';
export type { ModelTokenLimits } from './models/domain/token-budget.js';
export { resolveModelTokenLimits } from './models/domain/token-budget.js';
```

- [ ] **Step 1: Baseline green**

Run: `npx tsc && node --test test/provider-protocol.test.js test/enricher.test.js`
Expected: PASS, 0 failed.

- [ ] **Step 2: Create the new domain files with the moved declarations**

Create `src/models/domain/model.ts` and `src/models/domain/token-budget.ts` with the code blocks above, copied verbatim from `src/provider-protocol.ts`.

- [ ] **Step 3: Point `src/enricher.ts` at the new location first (red)**

In `src/enricher.ts`, change the import to:

```ts
import { resolveModelTokenLimits } from './models/domain/token-budget.js';
```

Run: `npx tsc --noEmit`
Expected: FAIL with duplicate-export or unresolved-module errors, because `src/provider-protocol.ts` still declares the same names.

- [ ] **Step 4: Remove the moved declarations from `src/provider-protocol.ts`, keep the shims**

Delete the moved interfaces, constants, and function; add the shim block above. Update `src/provider.ts` to import `resolveModelTokenLimits` and `OpenCodeModelMeta` from the new paths.

- [ ] **Step 5: Verify green**

Run: `npx tsc && node --test test/provider-protocol.test.js test/enricher.test.js test/provider-chaos-responses-api.test.js`
Expected: PASS, 0 failed.

- [ ] **Step 6: Commit**

```bash
git add src/models/domain/model.ts src/models/domain/token-budget.ts src/provider-protocol.ts src/enricher.ts src/provider.ts
git commit -m "refactor(models): extract model and token-budget domain"
```

### Task 2: Split Chat protocol conversion out of provider-protocol.ts

**Files:**
- Create: `src/chat/infrastructure/message-mapper.ts`
- Create: `src/chat/infrastructure/tool-mapper.ts`
- Create: `src/chat/infrastructure/request-factory.ts`
- Create: `src/chat/infrastructure/reasoning-controls.ts`
- Modify: `src/provider-protocol.ts` (shims only after the move)
- Modify: `src/provider.ts` (import from new locations, keep its own re-exports)

**Interfaces:**
- Consumes: `OpenCodeModelMeta` from `src/models/domain/model.ts`.
- Produces: `message-mapper.ts` exports `formatProviderMessages`, `sanitizeResponsesInput`, `buildResponsesInput` plus `FormattedMessage`, `FormattedToolCall`, `ResponsesInputItem`, `ResponsesInputMessage`, `ResponsesInputFunctionCall`, `ResponsesInputFunctionCallOutput`; `tool-mapper.ts` exports `formatProviderTools`, `injectOpenCodeVerificationTools`, `isSyntheticVerificationTool`, `WireToolDefinition`, `OPENCODE_CLIENT_VERIFICATION_TOOLS_CHAT`, `OPENCODE_CLIENT_VERIFICATION_TOOLS_RESPONSES`; `request-factory.ts` exports `createProviderRequest`, `createOpenCodeRequestHeaders`, `isResponsesModel`, `isFreeOrZenModel`, `ProviderRequest`, `ProviderRequestInput`; `reasoning-controls.ts` exports `normalizeReasoningEffort`, `getReasoningEffort`, `isStaleReasoningInput`. `ThinkTagStreamParser` moves in Task 3 with the stream split.

Move each declaration verbatim; change only the relative import of `./models/domain/model.js` and `vscode`.

- [ ] **Step 1: Baseline green**

Run: `npx tsc && node --test test/provider-protocol.test.js test/provider-chaos-responses-api.test.js`
Expected: PASS, 0 failed.

- [ ] **Step 2: Create the four mapper files and move one function (red)**

Create the four files. Move `formatProviderMessages` (with its types) into `message-mapper.ts` first and update `src/provider-protocol.ts` to re-export it from there while the other functions stay declared locally.

Run: `npx tsc --noEmit`
Expected: FAIL with duplicate declaration of `formatProviderMessages`.

- [ ] **Step 3: Finish the move, keep shims**

Move the remaining functions into their files. Replace the whole moved surface in `src/provider-protocol.ts` with re-exports. Update `src/provider.ts` imports to the new paths; keep its existing `export { ... } from` block but repoint it at the new files.

- [ ] **Step 4: Verify green**

Run: `npx tsc && node --test test/provider-protocol.test.js test/provider-chaos-responses-api.test.js test/provider-stream.test.js`
Expected: PASS, 0 failed.

- [ ] **Step 5: Commit**

```bash
git add src/chat/infrastructure/message-mapper.ts src/chat/infrastructure/tool-mapper.ts src/chat/infrastructure/request-factory.ts src/chat/infrastructure/reasoning-controls.ts src/provider-protocol.ts src/provider.ts
git commit -m "refactor(chat): split protocol conversion into infrastructure mappers"
```

### Task 3: Split stream parsing out of provider-stream.ts

**Files:**
- Create: `src/chat/infrastructure/sse-reader.ts` (SSE framing, `ThinkTagStreamParser` stays with framing)
- Create: `src/chat/infrastructure/chat-completions-parser.ts`
- Create: `src/chat/infrastructure/responses-parser.ts`
- Create: `src/chat/infrastructure/token-usage-reporter.ts`
- Modify: `src/provider-stream.ts` (orchestration only, plus re-export shim for `consumeProviderStream` consumers)
- Modify: `src/provider.ts` (import `consumeProviderStream` from the new home)

**Interfaces:**
- Consumes: mapper functions from Task 2.
- Produces: `sse-reader.ts` exports `createSseReader(response: Response)` returning an async iterable of parsed `SseEvent` values (`{ type: string; data: unknown }`), plus the moved `ThinkTagStreamParser` class; `chat-completions-parser.ts` exports `processChatCompletionsEvent(event: SseEvent, sink: StreamSink): boolean` returning true when the stream is complete; `responses-parser.ts` exports `processResponsesEvent(event: SseEvent, sink: StreamSink): boolean` with the same contract; `StreamSink` is an interface defined in `sse-reader.ts` with methods `emitText(text: string)`, `emitThinking(text: string, id: string)`, `queueToolCall(call)`, `flushToolCalls()`, and `complete()`; `token-usage-reporter.ts` exports `buildUsagePayload(event: unknown): Record<string, unknown> | undefined`. Naming uses `token-usage` deliberately to avoid the quota-`usage` clash.

- [ ] **Step 1: Baseline green**

Run: `npx tsc && node --test test/provider-stream.test.js test/provider-chaos-responses-api.test.js`
Expected: PASS, 0 failed.

- [ ] **Step 2: Move the usage reporter first (red)**

Create `token-usage-reporter.ts` with `buildUsagePayload` and its `isRecord`/`isTokenCount`/`readReasoningTokens` helpers moved verbatim. Update `src/provider-stream.ts` to import `buildUsagePayload` from the new path, but leave the old local copies in place.

Run: `npx tsc --noEmit`
Expected: FAIL with duplicate declarations.

- [ ] **Step 3: Finish the split**

Move framing, Chat Completions handling, and Responses handling into their files. `consumeProviderStream` in `src/provider-stream.ts` keeps orchestration (reader loop, idle watchdog, stall retry) and delegates parsing. Keep `export { consumeProviderStream }` working via its current module path for now.

- [ ] **Step 4: Verify green**

Run: `npx tsc && node --test test/provider-stream.test.js test/provider-chaos-responses-api.test.js`
Expected: PASS, 0 failed. The usage-forwarding test must still see exactly one `usage` data part.

- [ ] **Step 5: Commit**

```bash
git add src/chat/infrastructure/sse-reader.ts src/chat/infrastructure/chat-completions-parser.ts src/chat/infrastructure/responses-parser.ts src/chat/infrastructure/token-usage-reporter.ts src/provider-stream.ts src/provider.ts
git commit -m "refactor(chat): split stream parsing into dedicated modules"
```

### Task 4: Separate Chat application orchestration from the VS Code adapter

**Files:**
- Create: `src/chat/application/send-chat-message.ts` (owns `consumeProviderStream` orchestration moved from `src/provider-stream.ts`)
- Create: `src/chat/application/recover-stream.ts` (owns idle-timeout and stall-retry policy moved from `src/provider-stream.ts` and `src/provider.ts`)
- Create: `src/chat/infrastructure/vscode-chat-provider.ts` (owns `OpenCodeChatProvider`, session cache, request routing, error mapping)
- Create: `src/chat/domain/chat-session.ts` (owns session-id generation and the bounded conversation cache)
- Create: `src/models/infrastructure/verified-catalog.ts` (owns `VERIFIED_OPENCODE_MODELS`)
- Modify: `src/provider.ts` and `src/provider-stream.ts` (shims only)
- Modify: `src/extension.ts` (import provider from the new path)

**Interfaces:**
- Consumes: mappers and parsers from Tasks 2-3, `OpenCodeModelMeta` from Models domain.
- Produces: `send-chat-message.ts` exports `consumeProviderStream(options): Promise<'retry' | 'done'>` with the same `ConsumeProviderStreamOptions` shape; `recover-stream.ts` exports `shouldRetryStall(attempt: number, maxRetries: number): boolean` and `stallInterruptionMessage(): string`; `chat-session.ts` exports `generateOpenCodeSessionId`, `generateOpenCodeDescendingId`, `generateOpenCodeRequestId`, and a `ChatSessionCache` class with `get(key)`, `set(key, value)`, and LRU eviction; `verified-catalog.ts` exports `VERIFIED_OPENCODE_MODELS`.

- [ ] **Step 1: Baseline green**

Run: `npx tsc && node --test test/provider-chaos-responses-api.test.js test/provider-stream.test.js`
Expected: PASS, 0 failed.

- [ ] **Step 2: Move the session cache first (red)**

Create `chat-session.ts`, move the ID generators and cache, update `vscode-chat-provider.ts` (new file holding the moved `OpenCodeChatProvider` class) to import them, but do not yet remove them from `src/provider.ts`.

Run: `npx tsc --noEmit`
Expected: FAIL with duplicate declarations.

- [ ] **Step 3: Finish the separation**

Move the provider class, orchestration, and recovery policy into their new files. Reduce `src/provider.ts` and `src/provider-stream.ts` to re-export shims. Update `src/extension.ts` to import `OpenCodeChatProvider` from `src/chat/infrastructure/vscode-chat-provider.js`.

- [ ] **Step 4: Verify green**

Run: `npm test`
Expected: PASS, 234 passed, 0 failed.

- [ ] **Step 5: Commit**

```bash
git add src/chat/application/send-chat-message.ts src/chat/application/recover-stream.ts src/chat/infrastructure/vscode-chat-provider.ts src/chat/domain/chat-session.ts src/models/infrastructure/verified-catalog.ts src/provider.ts src/provider-stream.ts src/extension.ts
git commit -m "refactor(chat): separate application orchestration from VS Code adapter"
```

### Task 5: Move model fetching, enrichment, and sync behind Models application

**Files:**
- Create: `src/models/infrastructure/models-dev-client.ts` (from `src/fetcher.ts`)
- Create: `src/models/infrastructure/model-enricher.ts` (from `src/enricher.ts`)
- Create: `src/models/infrastructure/model-cache.ts` (cache read/write moved out of the provider)
- Create: `src/models/application/synchronize-models.ts` (owns `syncOpenCodeModels` moved from `src/syncer.ts`, plus `fetchOpenCodeCatalogIds`, `fetchOpenCodeModelMetadata`, `buildUnifiedModels` moved from `src/sync-catalog.ts`)
- Create: `src/models/domain/model-catalog.ts` (owns `OpenCodeCatalogIds`, `UnifiedOpenCodeModels`)
- Modify: `src/fetcher.ts`, `src/enricher.ts`, `src/sync-catalog.ts`, `src/syncer.ts` (shims only)
- Modify: `src/config.ts`, `src/sync-writer.ts`, `src/sync-targets.ts`, `src/sync-files.ts` import paths only

**Interfaces:**
- Consumes: Models domain types from Task 1.
- Produces: `synchronize-models.ts` exports `syncOpenCodeModels` with the identical `SyncOpenCodeOptions`/`SyncOpenCodeResult` shapes; `model-catalog.ts` exports the catalog interfaces; `model-cache.ts` exports `readModelCache(dir)` and `writeModelCache(dir, models)`.

- [ ] **Step 1: Baseline green**

Run: `npx tsc && node --test test/fetcher.test.js test/enricher.test.js test/provider-chaos-responses-api.test.js`
Expected: PASS, 0 failed.

- [ ] **Step 2: Move the fetcher first (red)**

Create `models-dev-client.ts` with `src/fetcher.ts` contents moved verbatim. Update `src/sync-catalog.ts` to import from the new path while `src/fetcher.ts` still declares everything.

Run: `npx tsc --noEmit`
Expected: FAIL with duplicate declarations.

- [ ] **Step 3: Finish the move**

Move enricher, catalog building, sync orchestration, and cache persistence. Reduce old files to shims. Update `src/extension.ts` and sync-file modules to the new import paths.

- [ ] **Step 4: Verify green**

Run: `npm test`
Expected: PASS, 234 passed, 0 failed.

- [ ] **Step 5: Commit**

```bash
git add src/models/infrastructure/models-dev-client.ts src/models/infrastructure/model-enricher.ts src/models/infrastructure/model-cache.ts src/models/application/synchronize-models.ts src/models/domain/model-catalog.ts src/fetcher.ts src/enricher.ts src/sync-catalog.ts src/syncer.ts src/config.ts src/sync-writer.ts src/sync-targets.ts src/sync-files.ts src/extension.ts
git commit -m "refactor(models): move fetch, enrich, and sync behind application service"
```

### Task 6: Move usage context and consolidate technical infrastructure

**Files:**
- Create: `src/usage/domain/usage-snapshot.ts` (move `GoUsagePeriod`, `GoUsageData`, `GoUsageResult` from `src/usage.ts`)
- Create: `src/usage/application/refresh-usage.ts` (move `fetchOpenCodeUsage` orchestration from `src/usage.ts`)
- Create: `src/usage/infrastructure/quota-client.ts` (move the quota HTTP call)
- Create: `src/usage/infrastructure/usage-tree-adapter.ts` (move `src/views/usageTreeProvider.ts`)
- Create: `src/infrastructure/http/fetch-policy.ts` (move `fetchWithRetry`, retry options, offline check from `src/network.ts`)
- Create: `src/infrastructure/http/proxy-routing.ts` (move proxy functions from `src/network.ts`)
- Create: `src/infrastructure/vscode/secret-store.ts` (move `src/auth.ts`)
- Modify: `src/usage.ts`, `src/views/usageTreeProvider.ts`, `src/network.ts`, `src/auth.ts` (shims only)
- Modify: `src/extension.ts` (import from new paths; keep it wiring-only by moving catalog classification into `synchronize-models.ts` and usage-meter updates into `refresh-usage.ts`)

**Interfaces:**
- Consumes: fetch policy from `infrastructure/http`.
- Produces: `refresh-usage.ts` exports `refreshUsage(apiKey): Promise<GoUsageResult>` and `updateUsageMeter(context, usage): void`; `fetch-policy.ts` exports `fetchWithRetry`, `isOfflineMode`, `FetchWithRetryOptions`, `FetchInit`; `proxy-routing.ts` exports `resolveProxyUrl`, `getProxyDispatcher`, `withProxy`, `setVSCodeProxyUrl`; `secret-store.ts` exports `resolveApiKey`, `promptAndSetApiKey`, `SECRET_KEY`.

- [ ] **Step 1: Baseline green**

Run: `npm test`
Expected: PASS, 234 passed, 0 failed.

- [ ] **Step 2: Move the usage snapshot types first (red)**

Create `usage-snapshot.ts`, update `src/usage.ts` to import the types from there while still declaring them locally.

Run: `npx tsc --noEmit`
Expected: FAIL with duplicate declarations.

- [ ] **Step 3: Finish usage and infrastructure moves**

Move quota orchestration, tree adapter, fetch policy, proxy routing, and secret store. Reduce old files to shims. Move catalog classification and usage-meter updates out of `src/extension.ts`.

- [ ] **Step 4: Verify green**

Run: `npm test && npm run lint`
Expected: PASS, 234 passed, 0 failed, lint clean.

- [ ] **Step 5: Commit**

```bash
git add src/usage/domain/usage-snapshot.ts src/usage/application/refresh-usage.ts src/usage/infrastructure/quota-client.ts src/usage/infrastructure/usage-tree-adapter.ts src/infrastructure/http/fetch-policy.ts src/infrastructure/http/proxy-routing.ts src/infrastructure/vscode/secret-store.ts src/usage.ts src/views/usageTreeProvider.ts src/network.ts src/auth.ts src/extension.ts
git commit -m "refactor(usage): move quota context and consolidate technical adapters"
```

### Task 7: Remove re-export shims and run final gates

**Files:**
- Delete shim-only files: `src/provider.ts`, `src/provider-protocol.ts`, `src/provider-stream.ts`, `src/fetcher.ts`, `src/enricher.ts`, `src/sync-catalog.ts`, `src/syncer.ts`, `src/network.ts`, `src/auth.ts`, `src/usage.ts` (only if each file contains nothing but re-exports at this point; verify with `grep -L` first)
- Modify: every `test/*.test.js` still importing from `../out/<old>.js` to import from the new `out/` paths
- Modify: `src/extension.ts` if it still references any removed path

**Interfaces:**
- Consumes: all new modules from Tasks 1-6.
- Produces: no shims remain; every import resolves to the owning module.

- [ ] **Step 1: Confirm each candidate file is shim-only**

Run: `grep -H "^export" src/provider.ts src/provider-protocol.ts src/provider-stream.ts src/fetcher.ts src/enricher.ts src/sync-catalog.ts src/syncer.ts src/network.ts src/auth.ts src/usage.ts`
Expected: every `export` line is an `export ... from '...'` re-export. If any file still declares logic, stop and move that logic first.

- [ ] **Step 2: Delete one shim and update its importers (red)**

Run: `git rm src/auth.ts`, then update `src/extension.ts` and tests to `../out/infrastructure/vscode/secret-store.js`.

Run: `npx tsc --noEmit`
Expected: FAIL listing each remaining stale importer; fix them one file at a time.

- [ ] **Step 3: Repeat Step 2 for each remaining shim file**

Delete exactly one shim per cycle, fix its importers, re-run `npx tsc --noEmit` until clean.

- [ ] **Step 4: Update test imports and run the full gates**

Run: `npm test && npm run lint && npm run crap`
Expected: 234 passed, 0 failed; lint clean; CRAP gate passed (regenerate the baseline with `node scripts/crap-report.mjs --update-baseline` only after the final tree shape is stable, then re-run `npm run crap`).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(structure): remove re-export shims after clean DDD move"
```
