// Chat application: chat message orchestration (stream loop, watchdog).
import * as vscode from 'vscode';
import { isSyntheticVerificationTool } from '../infrastructure/tool-mapper.js';
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
  progress: vscode.Progress<vscode.LanguageModelResponsePart>;
  token: vscode.CancellationToken;
  abortSignal: AbortSignal;
  idleTimeoutMs: number;
  stallAttempt: number;
  maxStallRetries: number;
  log(message: string): void;
}

export type ConsumeProviderStreamResult = 'retry' | 'done';

export async function consumeProviderStream(
  options: ConsumeProviderStreamOptions
): Promise<ConsumeProviderStreamResult> {
  if (!options.response.body) {
    throw new Error('OpenCode API returned empty body');
  }

  const reader = options.response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const pendingToolCalls = new Map<number, QueuedToolCall>();
  const emittedToolCallIds = new Set<string>();
  const thinkingId = `thinking-${Date.now()}`;
  let currentThinkingId = thinkingId;
  const thinkParser = new ThinkTagStreamParser();
  let hasStreamError = false;
  let lastReadAt = Date.now();
  let partsReportedCount = 0;
  let isReasoningActive = false;
  let reasoningDeltasEmitted = false;
  let isStallRetry = false;
  let usageReported = false;

  const emitThinkingPart = (thinking: string, id: string) => {
    partsReportedCount++;
    const ThinkingPart = (vscode as any).LanguageModelThinkingPart;
    if (ThinkingPart) {
      options.progress.report(new ThinkingPart(thinking, id));
    } else {
      options.progress.report(new vscode.LanguageModelTextPart(thinking));
    }
  };

  const emitSingleToolCall = (id: string, name: string, args: string) => {
    let parsedArgs: any = {};
    try {
      parsedArgs = JSON.parse(args);
    } catch {
      parsedArgs = { raw: args };
    }
    if (!emittedToolCallIds.has(id) && !isSyntheticVerificationTool(name, options.tools)) {
      partsReportedCount++;
      emittedToolCallIds.add(id);
      options.progress.report(new vscode.LanguageModelToolCallPart(id, name, parsedArgs));
    }
  };

  const flushQueuedToolCalls = () => {
    if (pendingToolCalls.size === 0) return;
    for (const [, call] of pendingToolCalls) {
      emitSingleToolCall(call.id, call.name, call.args);
    }
    pendingToolCalls.clear();
  };

  const reportUsagePayload = (event: unknown): void => {
    if (usageReported) return;
    const payload = buildUsagePayload(event);
    if (!payload) return;

    usageReported = true;
    partsReportedCount++;
    options.progress.report(vscode.LanguageModelDataPart.json(payload, 'usage'));
  };

  const sink: StreamSink = {
    emitText: (text) => {
      partsReportedCount++;
      options.progress.report(new vscode.LanguageModelTextPart(text));
    },
    emitThinking: (thinking, id) => {
      emitThinkingPart(thinking, id);
    },
    emitToolCall: (id, name, args) => {
      emitSingleToolCall(id, name, args);
    },
    queueToolCall: (call) => {
      pendingToolCalls.set(call.index, { index: call.index, id: call.id, name: call.name, args: call.args });
    },
    queuedToolCall: (index) => pendingToolCalls.get(index),
    forgetQueuedToolCall: (index) => {
      pendingToolCalls.delete(index);
    },
    queuedToolCallCount: () => pendingToolCalls.size,
    flushToolCalls: () => {
      flushQueuedToolCalls();
    },
    reportUsage: (event) => {
      reportUsagePayload(event);
    },
    complete: () => {
      flushQueuedToolCalls();
    },
    get thinkingId() {
      return currentThinkingId;
    },
    set thinkingId(id: string) {
      currentThinkingId = id;
    },
    get reasoningActive() {
      return isReasoningActive;
    },
    set reasoningActive(active: boolean) {
      isReasoningActive = active;
    },
    get reasoningDeltasEmitted() {
      return reasoningDeltasEmitted;
    },
    set reasoningDeltasEmitted(emitted: boolean) {
      reasoningDeltasEmitted = emitted;
    },
    feedThinkTags: (chunk) => thinkParser.feed(chunk),
    flushThinkTags: () => thinkParser.flush(),
  };

  const processLine = (line: string): boolean => {
    const parsed = parseSseLine(line);
    if (parsed.kind === 'skip') return false;
    if (parsed.kind === 'done') return true;
    return processResponsesEvent(parsed.event, sink) || processChatCompletionsEvent(parsed.event, sink);
  };

  try {
    while (true) {
      if (options.token.isCancellationRequested) break;

      const effectiveIdleTimeoutMs = isReasoningActive ? options.idleTimeoutMs * 2 : options.idleTimeoutMs;
      const idleMs = effectiveIdleTimeoutMs - (Date.now() - lastReadAt);
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const idleTimeout = new Promise<never>((_, reject) => {
        idleTimer = setTimeout(
          () => { reject(new Error(`Stream idle for over ${Math.round(effectiveIdleTimeoutMs / 1000)}s; no data received from OpenCode upstream.`)); },
          Math.max(0, idleMs)
        );
      });

      let done: boolean, value: Uint8Array | undefined;
      try {
        ({ done, value } = await Promise.race([reader.read(), idleTimeout]));
      } finally {
        clearTimeout(idleTimer);
      }
      lastReadAt = Date.now();

      if (value) {
        buffer += decoder.decode(value, { stream: !done });
      }
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      let isDone = false;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const finished = processLine(line);
        if (finished) {
          // Ensure any remaining lines in this batch are processed before terminating
          for (let j = i + 1; j < lines.length; j++) {
            processLine(lines[j]);
          }
          // If buffer still has remaining content, process it
          if (buffer.trim()) {
            const remainingLines = buffer.split('\n');
            buffer = '';
            for (const remLine of remainingLines) {
              processLine(remLine);
            }
          }
          sink.complete();
          isDone = true;
          break;
        }
      }

      if (done) {
        // Process any trailing lines in buffer
        if (buffer.trim()) {
          const remainingLines = buffer.split('\n');
          buffer = '';
          for (const remLine of remainingLines) {
            processLine(remLine);
          }
        }
        sink.complete();
        break;
      }

      if (isDone) break;
    }
    const flushed = sink.flushThinkTags();
    if (flushed.thinking) emitThinkingPart(flushed.thinking, currentThinkingId);
    if (flushed.text) {
      partsReportedCount++;
      options.progress.report(new vscode.LanguageModelTextPart(flushed.text));
    }
  } catch (streamErr: unknown) {
    void reader.cancel().catch(() => { /* ignore */ });
    const errMsg = streamErr instanceof Error ? streamErr.message : String(streamErr);
    const isIdleTimeout = errMsg.includes('Stream idle for over');
    if (
      isIdleTimeout &&
      partsReportedCount === 0 &&
      !isReasoningActive &&
      shouldRetryStall(options.stallAttempt, options.maxStallRetries) &&
      !options.token.isCancellationRequested &&
      !options.abortSignal.aborted
    ) {
      isStallRetry = true;
      options.log(
        `Stream stalled with 0 bytes received for model=${options.modelId}; initiating automatic recovery retry (${options.stallAttempt + 1}/${options.maxStallRetries})...`
      );
    } else {
      hasStreamError = true;
      if (options.token.isCancellationRequested) {
        options.log(`Stream canceled by user for model=${options.modelId}`);
        return 'done';
      }
      options.log(`Stream interrupted for model=${options.modelId}: ${errMsg}`);
      options.progress.report(
        new vscode.LanguageModelTextPart(
          stallInterruptionMessage(errMsg)
        )
      );
      return 'done';
    }
  } finally {
    if (!isStallRetry) {
      // Flush any remaining accumulated tool calls ONLY if stream was NOT interrupted/canceled
      if (!hasStreamError && !options.token.isCancellationRequested && !options.abortSignal.aborted && pendingToolCalls.size > 0) {
        flushQueuedToolCalls();
      }
      if (!hasStreamError && !options.token.isCancellationRequested && !options.abortSignal.aborted) {
        options.log(`Stream completed for model=${options.modelId}`);
      }
    }
  }

  return isStallRetry ? 'retry' : 'done';
}
