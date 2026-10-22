# Metadata-First Model Routing — Design

Date: 2026-10-19
Status: proposed (not approved — no product code may be built from this yet)
Context: issue #26 (Zen 400s), PR #25 follow-up. Investigation evidence in chat 2026-10-19; live data snapshots in /tmp (zen-models.json, go-models.json, models-opencode.json — regenerate, do not trust blindly).

## Intent and why

Today the extension decides per-model protocol, capabilities, and catalog routing from hardcoded name knowledge: substring checks (`muse`/`gpt-`/`grok-`/`claude`), a 14-entry family regex table, mini/nano + haiku special cases, reasoning-effort substrings, `-free`/`big-pickle`/`grok-code` routing exceptions, and suffix-stripping metadata lookup. Every new model family OpenCode adds breaks until someone adds another substring — Gemini (`gemini-3.8-flash`, issue #26) 400s today because nothing matches it and the silent default is chat-completions.

The goal: zero hardcoded model knowledge. Live catalog IDs + models.dev metadata + OpenCode's own npm→protocol mapping decide everything. A model OpenCode adds tomorrow works without a code change, or is skipped loudly at sync time — never silently misrouted.

## What we learned (evidence, not opinion)

- Live `/models` objects carry only `id`/`object`/`created`/`owned_by` — no protocol hint. Catalog = existence only. (85 Zen, 37 Go on 2026-10-19.)
- models.dev `limit`/`modalities`/`reasoning` present on 116/122 catalog IDs. 6 IDs have no metadata anywhere (`jev-1.13`, `jev-1.13-free`, `test`, `claude-opus-5-5-backup`, `omen-alpha`, `qwen3.7-max` fallback-only).
- `provider.npm` ∈ {`@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/openai-compatible`} maps to protocol per OpenCode's own `PACKAGES` table (verified in sst/opencode `packages/core/src/aisdk-native.ts`: openai → responses transport, anthropic → messages, openai-compatible → chat). `provider.shape` (`"responses" | "completions"`) exists in their schema but is unpopulated — watch, do not depend on.
- ~45 models have npm ∉ those three (`@ai-sdk/google`, `@ai-sdk/mistral`, or absent: deepseek/glm/kimi/mimo/minimax-m2.5/hy3/longcat/space-bunny/big-pickle/`-free` variants...). For these, neither live catalog nor models.dev determines which of our three proxy paths the model accepts.
- OpenCode's gateway is a pure path-rewriting proxy (`inference-proxy.ts`): all three shapes accepted on both Zen and Go; the *provider behind it* rejects mismatched shapes. "Model does not support this protocol" is the provider speaking, relayed by the proxy. There is no per-model endpoint mapping to fetch — the mapping is shape-per-model, known only empirically.
- OpenCode's own client never inspects model IDs: npm → provider implementation → provider knows its shape. Our extension must do the same, plus handle the npm-unknown remainder empirically.

## Goals

1. **Automatic adaptation to catalog change.** When OpenCode adds a model, renames one, moves one between catalogs, or rewires one to a different protocol, the extension absorbs it at the next sync with zero code changes — or skips it loudly with a named warning. This is the property being built; everything below is machinery for it.
2. Delete all name-based protocol/capability/routing logic (spec §Inventory below). No substring, regex, suffix-strip, or named-exception referencing a model ID may remain in `src/` — not as a rule to follow, but because the adaptation property makes them unnecessary.
3. Capabilities (context window, max outputs, vision, thinking, reasoning efforts) come from models.dev only, with neutral last-resort defaults when metadata is absent.
4. Protocol comes from `provider.npm` via the OpenCode PACKAGES mapping for the known three; anything else is determined by a sync-time shape probe (below), cached per model ID.
5. A model that cannot be classified is skipped at sync with a warning in the output channel — never announced with a guessed protocol. No silent default anywhere on the classification path.
6. Offline startup (no network/key) announces the last-successful-sync snapshot, clearly stale-labeled, instead of the hand-maintained 26-model `verified-catalog.ts`.
7. **Reclassification on change.** A model that moves Go→Zen, or whose accepted shape changes between syncs, must reclassify on resync — cached answers (probe winners, snapshot entries) invalidate rather than stick. Adaptation covers OpenCode changing things under us, not just adding.

## Non-goals

- Changing the chat/usage request paths, the alert card contract, or the extension-version mechanism (all settled by PR #25 + follow-ups).
- Populating `provider.shape` upstream or asking OpenCode to publish a mapping (out of our control; the probe makes it unnecessary).
- Real-time re-probing: probe runs at sync time only, winners cached alongside the existing model cache.

## Anti-goals (failure even if it technically works)

- A new table (JSON, config, or const) mapping model families to protocols — that is the same hardcode in a different file.
- A probe that sends real completions or costs money: probes must be shape-discrimination only (minimal body, expect 400-vs-accept discrimination, never a billable completion).
- Silently dropping a previously-working model: any model announced by the previous sync that the new logic would skip must be named in the output channel warning.

## Design

### Inventory to delete (all in `src/`, verified 2026-10-19)

1. `model-enricher.ts` — `FAMILY_CAPABILITIES` table + `fallbackCapabilities` (incl. mini/nano, haiku branches) + `resolveCapability` helper; `resolveTransport` heuristic branches (keep signature, metadata + probe determine result); `resolveReasoningEfforts` name-fallback branch (`deepseek`/`kimi-k3`/`glm`); `TITLE_CASE_EXCEPTIONS` — MAY keep: display cosmetics, cannot misroute. Builder's call, document it.
2. `request-factory.ts` — `isResponsesModel` heuristic branch (keep metadata branch; callers must supply stored `apiType`, no ID guessing); `isZenModel` fallback branch (`-free`/`big-pickle`/`grok-code`) — catalog membership comes from which live list contained the ID, period.
3. `synchronize-models.ts` — `getGoModelMetadata`/`getZenModelMetadata` suffix-stripping; look up the exact ID only.
4. `verified-catalog.ts` — replace with generated snapshot (below), not hand edits.
5. Tests asserting heuristic behavior for invented IDs (e.g. `freeform-9000` — actually that test asserts the *narrowed* heuristic; it goes with the heuristic).

### New data flow

```
live /models (go+zen) ──► exact-ID metadata join (models.dev, opencode/opencode-go authoritative, then global fallback)
        │                                   │
        │                          ┌────────┴─────────┐
        │                     metadata found      metadata missing ──► skip + warn (covers jev-*, test, backup, omen-alpha)
        │                          │                  (no neutral-defaults announcement path: without metadata a model
        │                          │                   cannot be classified, and an unclassified model is never announced)
        │              ┌───────────┼────────────┐
        │         npm=openai  npm=anthropic  npm=openai-compatible ──► responses / messages / chat-completions
        │              │
        │         npm=other/absent ──► shape probe (cached) ──► winner | all-rejected → skip + warn
        │
        └──► announced models carry { apiType, url, limits, vision, thinking, efforts } — all stored, none recomputed from ID downstream
```

**Catalog tie-break (Go wins).** 22 IDs appear in both live lists today (beam-free, claude-haiku-5-5, deepseek-*, glm-*, gpt-6-*, grok-*, kimi-*, longcat-2.5-preview-free, minimax-*, qwen3.6-plus, qwen3.8-*). Preserve current shipped behavior: an ID present in the Go list is announced once, routed to Go, and never duplicated to Zen (`buildZenModels` skips Go-set members today). Rationale: Go is the paid flat-rate gateway; on ambiguity route to the gateway with the stronger delivery guarantee.

**Metadata join precedence (record-level, authoritative-provider-wins).** Keep today's two-phase merge in `models-dev-client.ts` (`collectFallbackModels` then `applyAuthoritativeModels` overwrite): for any ID present in `opencode`/`opencode-go`, the authoritative record replaces the fallback record *wholesale* — no field-level merging (a half-authoritative franken-record is worse than either source). Consequence: `qwen3.7-max` (fallback-only, `aihubmix`) keeps its fallback record as-is; it is announced with neutral-default capabilities and goes through the shape probe like any npm-unknown model. Fallback is a source of last resort, not a demotion — the skip rule applies only when NO source has the ID.

**Partial metadata (field-level rule).** `limit`/`modalities`/`reasoning` are read per-field with `??` fallback to neutral defaults (today's `devCapability` semantics, unchanged): contextWindow 1048576, maxOutputTokens 65536, vision false, thinking true. `supportsReasoningEffort`: keep today's rule — models.dev `reasoning_options` effort values when present, else undefined (no effort list invented; the picker simply offers no effort choices). Vision/thinking are booleans with safe defaults (false/true); efforts are an open-ended list where a wrong guess invents UI — hence undefined, not a default list.

### Shape probe (builder designs details, constraints are binding)

- Runs at sync time, only for IDs whose npm is outside the known three.
- Discriminates shape without billable work: minimal body; treat 400-with-"does not support this protocol" (and 404) as "wrong shape", any other response (including auth/rate-limit errors, which prove the shape was *accepted*) as "shape works". Order candidates to minimize expected calls; stop at first acceptance.
- Cache: winner stored per model ID in the existing model cache; cache invalidates on sync (re-probe only IDs not in cache or whose cached shape recently 400d — builder decides exact policy, keep it simple).
- Offline: no probing (no network by definition); snapshot covers it.
- Rate-limit safety: bound total probes per sync (builder proposes a number; suggestion: reuse the existing retry budgets, probe sequentially not concurrently).

### Sync-failure / offline snapshot (replaces `verified-catalog.ts`)

- After every successful sync, persist the announced list to a checked-in snapshot file (mechanical `JSON.stringify`, no hand edits) with a `syncedAt` timestamp.
- Startup with no network/key announces the snapshot and logs `announcing stale snapshot from <date>`; the picker works offline exactly as today, minus the fiction that 26 hand-picked models are "verified".
- Builder's call: snapshot file location + whether generation is a sync side-effect or explicit script. Must be mechanical either way.

### Neutral defaults (field-level fallback only — there is no announce-without-metadata path)

- contextWindow 1048576, maxOutputTokens 65536, vision false, thinking true (today's values, kept deliberately boring).
- These size token budgets only; they cannot cause a 400. No family-specific defaults ever again.
- `supportsReasoningEffort`: models.dev `reasoning_options` effort values when present, else undefined — never an invented list.

## Constraints

- TDD per repo practice; full suite + lint + CRAP gate green before merge. New probe logic needs chaos-style fault tests (mock server already supports fault scenarios).
- No new runtime dependencies (esbuild, node:test, c8 already present).
- Backward compatible: announced-model shape for existing consumers (`CustomEndpointModel`) unchanged; only how the fields are *derived* changes.
- The 6 metadata-less IDs must disappear from the picker with a named warning (verify: `jev-1.13-free` was asserted in honest-client tests — those assertions change to skip-behavior).
- **Acceptance gate: the new-model scenario test.** A mock-catalog test introduces fictitious models in each possible state — full metadata, npm-unknown (probe path), metadata missing entirely (skip path), dual-listed in both catalogs (tie-break), a model that *changes* protocol between syncs (reclassification) — and the system classifies each correctly with no code change beyond the fixture. If a future OpenCode change needs anything more than a fixture update to handle, the design failed.

## What the builder decides

- Probe request bodies, candidate order, caching/invalidation policy, per-sync probe bound.
- Snapshot file location and generation mechanism.
- Whether `TITLE_CASE_EXCEPTIONS` stays (cosmetic) or goes (purist).
- Exact output-channel warning wording (must name skipped IDs — that part is required, wording is free).

## Open question for the human (answered during brainstorming)

- Offline fallback: snapshot-of-last-sync (chosen) vs announce-nothing vs keep hand list. → Chosen: snapshot. Locked.
