// Chat application: chat message orchestration (stream loop, watchdog).
import * as vscode from 'vscode';
import { isSyntheticVerificationTool } from '../infrastructure/tool-mapper.js';
import type { LogFn } from '../infrastructure/vscode-chat-provider.js';
import {
  ThinkTagStreamParser,
  parseSseLine,
  type QueuedToolCall,
  type StreamSink,
} from '../infrastructure/sse-reader.js';
import { processChatCompletionsEvent } from '../infrastructure/chat-completions-parser.js';
import { processResponsesEvent } from '../infrastructure/responses-parser.js';
import { buildUsagePayload } from '../infrastructure/token-usage-reporter.js';
import { shouldRetryStall, stallInterruptionMessage } from './recover-stream.js';

export interface ConsumeProviderStreamOptions {
  response: Response;
  modelId: string;
  tools: readonly vscode.LanguageModelChatTool[] | undefined;
  toolMode?: vscode.LanguageModelChatToolMode;
  relaxedToolNames?: ReadonlySet<string>;
  progress: vscode.Progress<vscode.LanguageModelResponsePart>;
  token: vscode.CancellationToken;
  abortSignal: AbortSignal;
  idleTimeoutMs: number;
  stallAttempt: number;
  maxStallRetries: number;
  log: LogFn;
}

export type ConsumeProviderStreamResult = 'retry' | 'done';

/**
 * Mutable per-stream state owned by consumeProviderStream. Extracted as a
 * class so the orchestration function stays a thin loop over small methods
 * instead of a 36-complexity closure nest.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class StreamState {
  readonly pendingToolCalls = new Map<number, QueuedToolCall>();
  readonly emittedToolCallIds = new Set<string>();
  readonly thinkParser = new ThinkTagStreamParser();
  readonly thinkingId = `thinking-${Date.now()}`;
  currentThinkingId: string;
  hasStreamError = false;
  lastReadAt = Date.now();
  partsReportedCount = 0;
  isReasoningActive = false;
  reasoningDeltasEmitted = false;
  textEmitted = false;
  isStallRetry = false;
  usageReported = false;

  constructor(private readonly options: ConsumeProviderStreamOptions) {
    this.currentThinkingId = this.thinkingId;
  }

  emitThinkingPart(thinking: string, id: string): void {
    this.partsReportedCount++;
    const ThinkingPart = (vscode as any).LanguageModelThinkingPart;
    if (ThinkingPart) {
      this.options.progress.report(new ThinkingPart(thinking, id));
    } else {
      this.options.progress.report(new vscode.LanguageModelTextPart(thinking));
    }
  }

  emitSingleToolCall(id: string, name: string, args: string): void {
    let parsedArgs: unknown;
    try {
      parsedArgs = args.trim().length === 0 ? {} : JSON.parse(args);
    } catch {
      parsedArgs = undefined;
    }
    // A crippled call (truncated JSON, non-object input) would fail Copilot's
    // tool-schema validation and send the agent into a retry loop. Drop it
    // loudly instead of emitting it with an invented shape.
    if (!isPlainObject(parsedArgs)) {
      this.options.log(`Dropping malformed tool call ${name} (${id}): arguments are not a JSON object`);
      return;
    }
    if (!this.emittedToolCallIds.has(id) && !isSyntheticVerificationTool(name, this.options.tools)) {
      this.partsReportedCount++;
      this.emittedToolCallIds.add(id);
      if (this.options.relaxedToolNames?.has(name)) {
        this.options.log(`Relaxed-schema tool invoked: ${name} (oversized enums were stripped from its schema; invalid arguments may fail the tool call)`);
      }
      this.options.progress.report(new vscode.LanguageModelToolCallPart(id, name, parsedArgs));
    }
  }

  flushQueuedToolCalls(): void {
    if (this.pendingToolCalls.size === 0) return;
    for (const [, call] of this.pendingToolCalls) {
      this.emitSingleToolCall(call.id, call.name, call.args);
    }
    this.pendingToolCalls.clear();
  }

  reportUsagePayload(event: unknown): void {
    if (this.usageReported) return;
    const payload = buildUsagePayload(event);
    if (!payload) return;

    this.usageReported = true;
    this.partsReportedCount++;
    this.options.progress.report(vscode.LanguageModelDataPart.json(payload, 'usage'));
  }

  buildSink(): StreamSink {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- getters/setters below capture `this` lexically per-accessor; an arrow wrapper per accessor would add noise without safety.
    const state = this;
    return {
      emitText: (text) => {
        state.partsReportedCount++;
        state.textEmitted = true;
        state.options.progress.report(new vscode.LanguageModelTextPart(text));
      },
      emitThinking: (thinking, id) => {
        state.emitThinkingPart(thinking, id);
      },
      emitToolCall: (id, name, args) => {
        state.emitSingleToolCall(id, name, args);
      },
      queueToolCall: (call) => {
        state.pendingToolCalls.set(call.index, { index: call.index, id: call.id, name: call.name, args: call.args });
      },
      queuedToolCall: (index) => state.pendingToolCalls.get(index),
      forgetQueuedToolCall: (index) => {
        state.pendingToolCalls.delete(index);
      },
      queuedToolCallCount: () => state.pendingToolCalls.size,
      flushToolCalls: () => {
        state.flushQueuedToolCalls();
      },
      reportUsage: (event) => {
        state.reportUsagePayload(event);
      },
      complete: () => {
        state.flushQueuedToolCalls();
      },
      get thinkingId(): string {
        return state.currentThinkingId;
      },
      set thinkingId(id: string) {
        state.currentThinkingId = id;
      },
      get reasoningActive(): boolean {
        return state.isReasoningActive;
      },
      set reasoningActive(active: boolean) {
        state.isReasoningActive = active;
      },
      get reasoningDeltasEmitted(): boolean {
        return state.reasoningDeltasEmitted;
      },
      set reasoningDeltasEmitted(emitted: boolean) {
        state.reasoningDeltasEmitted = emitted;
      },
      get textEmitted(): boolean {
        return state.textEmitted;
      },
      set textEmitted(emitted: boolean) {
        state.textEmitted = emitted;
      },
      feedThinkTags: (chunk) => state.thinkParser.feed(chunk),
      flushThinkTags: () => state.thinkParser.flush(),
    };
  }
}

function processSseLine(line: string, sink: StreamSink): boolean {
  const parsed = parseSseLine(line);
  if (parsed.kind === 'skip') return false;
  if (parsed.kind === 'done') return true;
  return processResponsesEvent(parsed.event, sink) || processChatCompletionsEvent(parsed.event, sink);
}

function processLineBatch(lines: string[], sink: StreamSink): boolean {
  for (let i = 0; i < lines.length; i++) {
    if (!processSseLine(lines[i], sink)) continue;
    // Ensure any remaining lines in this batch are processed before terminating
    for (let j = i + 1; j < lines.length; j++) {
      processSseLine(lines[j], sink);
    }
    return true;
  }
  return false;
}

async function readStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleTimeoutMs: number,
  lastReadAt: number
): Promise<{ done: boolean; value: Uint8Array | undefined }> {
  const idleMs = idleTimeoutMs - (Date.now() - lastReadAt);
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const idleTimeout = new Promise<never>((_, reject) => {
    idleTimer = setTimeout(
      () => { reject(new Error(`Stream idle for over ${Math.round(idleTimeoutMs / 1000)}s; no data received from OpenCode upstream.`)); },
      Math.max(0, idleMs)
    );
  });
  try {
    return await Promise.race([reader.read(), idleTimeout]);
  } finally {
    clearTimeout(idleTimer);
  }
}

function effectiveIdleTimeout(baseMs: number, reasoningActive: boolean): number {
  return reasoningActive ? baseMs * 2 : baseMs;
}

function processRemainingBuffer(buffer: { text: string }, sink: StreamSink): void {
  if (!buffer.text.trim()) return;
  const remainingLines = buffer.text.split('\n');
  buffer.text = '';
  processLineBatch(remainingLines, sink);
}

async function pumpStream(
  options: ConsumeProviderStreamOptions,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: { decode(input?: Uint8Array, options?: { stream?: boolean }): string },
  buffer: { text: string },
  state: StreamState,
  sink: StreamSink
): Promise<void> {
  while (true) {
    if (options.token.isCancellationRequested) break;

    const timeoutMs = effectiveIdleTimeout(options.idleTimeoutMs, state.isReasoningActive);
    const { done, value } = await readStreamChunk(reader, timeoutMs, state.lastReadAt);
    state.lastReadAt = Date.now();

    if (value) {
      buffer.text += decoder.decode(value, { stream: !done });
    }
    const lines = buffer.text.split('\n');
    buffer.text = lines.pop() ?? '';

    if (processLineBatch(lines, sink)) {
      processRemainingBuffer(buffer, sink);
      sink.complete();
      break;
    }

    if (done) {
      processRemainingBuffer(buffer, sink);
      sink.complete();
      break;
    }
  }
}

function flushThinkTagRemainder(
  options: ConsumeProviderStreamOptions,
  state: StreamState,
  sink: StreamSink
): void {
  const flushed = sink.flushThinkTags();
  if (flushed.thinking) state.emitThinkingPart(flushed.thinking, state.currentThinkingId);
  if (flushed.text) {
    state.partsReportedCount++;
    state.textEmitted = true;
    options.progress.report(new vscode.LanguageModelTextPart(flushed.text));
  }
}

function finalizeStream(options: ConsumeProviderStreamOptions, state: StreamState): void {
  if (state.isStallRetry) return;
  // Flush any remaining accumulated tool calls ONLY if stream was NOT interrupted/canceled
  if (streamSettledCleanly(options, state) && state.pendingToolCalls.size > 0) {
    state.flushQueuedToolCalls();
  }
  if (streamSettledCleanly(options, state)) {
    options.log(`Stream completed for model=${options.modelId}`);
  }
}

function streamSettledCleanly(options: ConsumeProviderStreamOptions, state: StreamState): boolean {
  return !state.hasStreamError && !options.token.isCancellationRequested && !options.abortSignal.aborted;
}

export async function consumeProviderStream(
  options: ConsumeProviderStreamOptions
): Promise<ConsumeProviderStreamResult> {
  if (!options.response.body) {
    throw new Error('OpenCode API returned empty body');
  }

  const reader = options.response.body.getReader();
  const decoder = new TextDecoder();
  const buffer = { text: '' };
  const state = new StreamState(options);
  const sink = state.buildSink();

  try {
    await pumpStream(options, reader, decoder, buffer, state, sink);
    flushThinkTagRemainder(options, state, sink);
  } catch (streamErr: unknown) {
    const outcome = handleStreamError(options, state, reader, streamErr);
    if (outcome === 'done') return 'done';
  } finally {
    finalizeStream(options, state);
  }

  enforceRequiredToolMode(options, state.emittedToolCallIds);

  return state.isStallRetry ? 'retry' : 'done';
}

function shouldRecoverStall(
  options: ConsumeProviderStreamOptions,
  state: StreamState,
  errMsg: string
): boolean {
  return (
    errMsg.includes('Stream idle for over') &&
    state.partsReportedCount === 0 &&
    !state.isReasoningActive &&
    shouldRetryStall(options.stallAttempt, options.maxStallRetries) &&
    !options.token.isCancellationRequested &&
    !options.abortSignal.aborted
  );
}

function handleStreamError(
  options: ConsumeProviderStreamOptions,
  state: StreamState,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  streamErr: unknown
): 'done' | 'continue' {
  void reader.cancel().catch(() => { /* ignore */ });
  const errMsg = streamErr instanceof Error ? streamErr.message : String(streamErr);
  if (shouldRecoverStall(options, state, errMsg)) {
    state.isStallRetry = true;
    options.log(
      `Stream stalled with 0 bytes received for model=${options.modelId}; initiating automatic recovery retry (${options.stallAttempt + 1}/${options.maxStallRetries})...`
    );
    return 'continue';
  }
  state.hasStreamError = true;
  if (options.token.isCancellationRequested) {
    options.log(`Stream canceled by user for model=${options.modelId}`);
    return 'done';
  }
  options.log(`Stream interrupted for model=${options.modelId}: ${errMsg}`, 'error');
  options.progress.report(
    new vscode.LanguageModelTextPart(
      stallInterruptionMessage(errMsg)
    )
  );
  return 'done';
}

/**
 * Honors the provider contract for `toolMode: Required`: when the caller
 * demands a tool call and the stream emitted none (excluding synthetic
 * verification calls, which are filtered before emission), say so loudly
 * rather than silently returning text the caller did not ask for.
 */
function enforceRequiredToolMode(
  options: ConsumeProviderStreamOptions,
  emittedToolCallIds: Set<string>
): void {
  const toolModes: { Required?: unknown } | undefined = (vscode as unknown as { LanguageModelChatToolMode?: { Required?: unknown } }).LanguageModelChatToolMode;
  const Required = toolModes?.Required;
  if (Required === undefined || options.toolMode !== Required) {
    return;
  }
  if (emittedToolCallIds.size > 0) {
    return;
  }
  if (!options.tools || options.tools.length === 0) {
    return;
  }
  const message =
    `Upstream model ${options.modelId} returned no tool call although toolMode Required was requested. ` +
    `The request carried ${options.tools.length} tool(s); retry with toolMode Auto or without tools.`;
  options.log(message, 'warn');
  options.progress.report(new vscode.LanguageModelTextPart(message));
}
