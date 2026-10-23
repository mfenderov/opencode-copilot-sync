# Task 4 Report — Restore Model-Aware Token Estimates

**Status:** DONE

## Change

Restored `OpenCodeChatAdapter.provideTokenCount` estimates based on `model.id`, matching the previous provider behavior: GPT/o1/o3/o4 and Muse/Gemini use 4 characters/token; Claude uses 3.7; Grok, DeepSeek, Qwen, Llama, MiMo/Mix, Kimi, and GLM use 3.4; unknown models use 3.6. Estimates are clamped to at least one token. String inputs are counted directly and message inputs use their JSON serialization. No stream code was changed.

## TDD Evidence

- **RED:** Added focused tests before the implementation and ran `node --test --test-name-pattern='chat adapter estimates (string|message|at least)' test/lean-chat-adapter.test.js`. All 3 tests failed on the prior fixed `/4` behavior: Claude ratio, serialized DeepSeek message estimate, and empty input minimum.
- **GREEN:** After restoring the estimator, ran `npx tsc && node --test --test-name-pattern='chat adapter estimates (string|message|at least)' test/lean-chat-adapter.test.js`; 3/3 tests passed.
- The tests cover string input across GPT, Muse, Gemini, Claude, Grok, DeepSeek, Qwen, Llama, MiMo, Mix, Kimi, GLM and unknown fallback; a serialized message input for known ratios; and empty-string minimum count.

## Quality Gates

- `npm run crap`: The complete coverage suite passed (200/200 tests); global function coverage is 88.12%, above the 88% requirement. The command still exits 1 in the separate CRAP-score gate: 9 functions are not grandfathered (including existing complex stream/model-cache functions). No unrelated baseline or stream changes were made.
- `npm run lint`: passed.
- `git diff --check`: passed.

## Files Changed

- `src/infrastructure/vscode/open-code-chat-adapter.ts`
- `test/lean-chat-adapter.test.js`

## Concern

The token-count coverage shortfall is resolved. The remaining `npm run crap` exit is from existing/unrelated CRAP-score findings; its full suite and global function-coverage portion pass.

---

# Task 4 Report — Scoped CRAP Quality-Gate Fix

**Status:** DONE

## Changes

- Confirmed by source-and-test search that `readModelCache` and `writeModelCache` had no references outside the now-dead module. Deleted `src/models/infrastructure/model-cache.ts` and removed its unused ESLint suppressions.
- Reduced only the newly introduced adapter functions listed by the CRAP report: extracted schema sanitation traversal and enum restoration, split prompt-part translation and response text extraction into cohesive helpers, grouped chat reasoning extraction and stream diagnostics updates, and separated stream reporting and attempt/retry orchestration. Adapter report shows none of the seven targeted functions exceed CRAP 10 after the refactor. `provideLanguageModelChatResponse`'s request preparation and retry work is delegated to helpers.
- No new behavior was intended; existing tests already exercise schema sanitation, tool results, reasoning formats, completion-text fallback, cancellation, timeout/retry and diagnostic paths, so no additional focused tests were needed.
- Left `crap-baseline.json`, thresholds, dependencies, and configuration unchanged.

## Verification

- Focused adapter suite: `npx tsc && node --test test/lean-chat-adapter.test.js` — 42/42 passed.
- One earlier full-suite run transiently failed the timeout-retry integration test (observed 3 instead of 4 requests); isolated rerun passed, as did the subsequent full suite.
- Final requested gate command: `set -o pipefail && npm test 2>&1 | tail -n 18 && npm run lint && npm run crap 2>&1 | tail -n 18 && git diff --check` — exit 0.
  - `npm test`: 200 tests, 200 passed, 0 failed.
  - `npm run lint`: passed.
  - `npm run crap`: passed; 322 functions analyzed, 3 at/above threshold, all existing offenders grandfathered; 88% function-coverage minimum retained.
  - `git diff --check`: passed.
- `git diff --exit-code -- crap-baseline.json` — passed; baseline unchanged.
- `git grep -n -E 'readModelCache|writeModelCache|model-cache' -- ':!src/models/infrastructure/model-cache.ts'` over source/tests — no matches.

## Files Changed

- `src/infrastructure/vscode/open-code-chat-adapter.ts`
- `src/models/infrastructure/model-cache.ts` (deleted)
- `eslint-suppressions.json`
- `.superpowers/sdd/2026-10-23-opencode-stream-recovery/task-4-report.md`

## Self-review / Concerns

The timeout retry test had one initial flaky failure but passed in isolated and full reruns. No changes were made to retry semantics; the refactor retained the existing behavior and all 200 tests pass. The adapter's un-grandfathered CRAP findings are cleared without modifying the baseline.
