# Task 2 Report — Bounded Timeout Retry and Partial-Text Continuation

## Status

DONE

## Implemented

- Added exported `ChatStreamPolicy` with Task 1 timeout defaults, OpenCode-style exponential retry delays (2s, 4s, 8s plus up to 100ms jitter; 10s per-gap cap), and a third constructor parameter accepting partial policy overrides.
- Each attempt gets its own `AbortController`, linked to VS Code cancellation, and an SDK fetch wrapper composed over the existing proxy-routed fetch. The `x-opencode-session` value and all request metadata remain stable across attempts.
- Retries only stream timeout errors, unwraps the AI SDK's timeout error cause, and stops after three retries. A cancellation aborts pending requests and interrupts backoff.
- Timed-out partial output is preserved. Subsequent request input carries only the timed-out attempt's partial text as an assistant message and a separate user continuation instruction; only new deltas are emitted to VS Code.
- SDK `finish` parts and raw protocol completion events prevent a delayed-body cleanup timeout from triggering another attempt.
- Tool calls are buffered until an attempt terminates and handed to VS Code once on timeout, preventing in-invocation retries or continuation when a tool call is ready.
- Retry exhaustion emits one interruption notice and leaves accumulated text intact.

## TDD Evidence

- RED: Added local HTTP server tests using 35ms timeouts and zero retry delay, then ran `node --test --test-timeout=10000 --test-name-pattern='chat adapter (retries|stops after|does not retry|continues timed-out)' test/lean-chat-adapter.test.js`. Before implementation, missing recovery behavior caused the retry, exhaustion, and continuation cases to hit the bounded test timeout; the cancellation case already passed. The tool-call handoff and finish-before-cleanup regressions were added and independently failed before their handling was implemented.
- GREEN: `npx eslint src/infrastructure/vscode/open-code-chat-adapter.ts && npx tsc && node --test test/lean-chat-adapter.test.js` — 39/39 passing.
- Full suite before commit: `npm test` — 197/197 passing.
- Focused expected suite: `npm test -- --test-name-pattern='lean chat adapter|stream fetch timeout'` — 196/196 passing (Node's test-name filter is interpreted as a regex; it runs all adapter tests because their names begin `chat adapter`, not `lean chat adapter`).
- `git diff --check` passed.

## Files Changed

- `src/infrastructure/vscode/open-code-chat-adapter.ts`
- `test/lean-chat-adapter.test.js`

## Self-Review

- Verified the proxy wrapper is preserved beneath timeout handling and SDK protocol selection remains based on model metadata.
- Verified original headers/session continuity, upstream tool-result forwarding, output-limit/content-filter handling, and privacy-safe diagnostics remain covered by passing existing tests.
- No settings, dependencies, or unrelated files changed.

## Concerns

None.

## Commit

`feat: recover timed out chat streams` (`b9afb9b`, implementation base)

## Task Review Fix Evidence

- **RED (reviewed behavior):** Against the original implementation at Task 2 base `b9afb9b5d8d23e1e991c4427f1eb491fded05036`, ran `node --test --test-timeout=1000 --test-name-pattern='terminal protocol completion' test/lean-chat-adapter.test.js`. The test failed with `provider waited for HTTP EOF after terminal completion`, reproducing the 900-second idle wait after raw `response.completed`. The partial fix was restored after the reproduction.
- **Fix:** Preserve terminal raw completion reporting and break the async iteration immediately, while letting `response.incomplete` continue to SDK `finish` so output-limit details and usage are retained. Set the exact required continuation instruction: “The previous response was interrupted. Continue from where you left off without repeating completed content.”
- **Regression coverage:** The terminal test keeps the HTTP body open with a 900,000ms chunk timeout, verifies provider completion within 100ms, verifies response handler remains open and only one request occurs. Existing continuation test asserts the exact assistant text plus separate user instruction.
- **Adjacent regression found/fixed:** First full test run exposed an output-limit truncation regression caused by treating `response.incomplete` as immediate terminal. It was excluded from the raw early-break path; focused check `node --test --test-timeout=5000 --test-name-pattern='terminal protocol completion|output-limit truncation' test/lean-chat-adapter.test.js` passed 2/2.
- **GREEN:** Focused `npx tsc && node --test --test-name-pattern='chat adapter|stream fetch timeout' test/lean-chat-adapter.test.js` — 16/16 passed. `npx eslint src/infrastructure/vscode/open-code-chat-adapter.ts` and `npx tsc` passed. Final `npm test` — 197/197 passed, 0 failures. `git diff --check` passed.
- Changed files remain `src/infrastructure/vscode/open-code-chat-adapter.ts` and `test/lean-chat-adapter.test.js`. No remaining concerns.

Fix commit: `fix: stop consuming stream on completion` (recorded in the Task 2 fix-round ledger).
