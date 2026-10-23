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

`feat: recover timed out chat streams`
