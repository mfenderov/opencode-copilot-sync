import * as vscode from 'vscode';
import { isSyntheticVerificationTool, ThinkTagStreamParser } from './provider-protocol.js';

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function isTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function readReasoningTokens(details: unknown): number | undefined {
  if (!isRecord(details)) return undefined;
  return isTokenCount(details.reasoning_tokens) ? details.reasoning_tokens : undefined;
}

function buildUsagePayload(event: unknown): Record<string, unknown> | undefined {
  if (!isRecord(event) || !isRecord(event.response) || !isRecord(event.response.usage)) return undefined;

  const usage = event.response.usage;
  if (!isTokenCount(usage.input_tokens) || !isTokenCount(usage.output_tokens)) return undefined;

  const payload: Record<string, unknown> = {
    prompt_tokens: usage.input_tokens,
    completion_tokens: usage.output_tokens,
  };
  const details = isRecord(usage.output_tokens_details)
    ? usage.output_tokens_details
    : usage.completion_tokens_details;
  const reasoningTokens = readReasoningTokens(details);
  if (reasoningTokens !== undefined) {
    payload.completion_tokens_details = { reasoning_tokens: reasoningTokens };
  }
  return payload;
}

export async function consumeProviderStream(
  options: ConsumeProviderStreamOptions
): Promise<ConsumeProviderStreamResult> {
  if (!options.response.body) {
    throw new Error('OpenCode API returned empty body');
  }

  const reader = options.response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const pendingToolCalls = new Map<number, { id: string; name: string; args: string }>();
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

  const emitThinking = (thinking: string) => {
    if (!thinking) return;
    partsReportedCount++;
    const ThinkingPart = (vscode as any).LanguageModelThinkingPart;
    if (ThinkingPart) {
      options.progress.report(new ThinkingPart(thinking, currentThinkingId));
    } else {
      options.progress.report(new vscode.LanguageModelTextPart(thinking));
    }
  };

  const flushPendingToolCalls = () => {
    if (pendingToolCalls.size === 0) return;
    for (const [, call] of pendingToolCalls) {
      if (emittedToolCallIds.has(call.id)) continue;
      let parsedArgs: any = {};
      try {
        parsedArgs = JSON.parse(call.args);
      } catch {
        parsedArgs = { raw: call.args };
      }
      if (!isSyntheticVerificationTool(call.name, options.tools)) {
        partsReportedCount++;
        emittedToolCallIds.add(call.id);
        options.progress.report(new vscode.LanguageModelToolCallPart(call.id, call.name, parsedArgs));
      }
    }
    pendingToolCalls.clear();
  };

  const reportUsage = (event: unknown): void => {
    if (usageReported) return;
    const payload = buildUsagePayload(event);
    if (!payload) return;

    usageReported = true;
    partsReportedCount++;
    options.progress.report(vscode.LanguageModelDataPart.json(payload, 'usage'));
  };

  const processLine = (line: string): boolean => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(':')) return false;
    if (trimmed === 'data: [DONE]') {
      return true;
    }

    if (trimmed.startsWith('data: ')) {
      try {
        const data = JSON.parse(trimmed.slice(6));

        // 1. Handle OpenAI Responses API stream format (used by Muse, GPT, Grok)
        if (data.type === 'response.completed') {
          isReasoningActive = false;
          reportUsage(data);
          if (Array.isArray(data.response?.output)) {
            for (const item of data.response.output) {
              if (item?.type === 'function_call') {
                const callId = item.call_id || item.id || `call_${Date.now()}`;
                const idx = typeof item.output_index === 'number' ? item.output_index : pendingToolCalls.size;
                const existing = pendingToolCalls.get(idx) || { id: callId, name: item.name || '', args: '' };
                if (item.arguments) {
                  existing.args = typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments);
                }
                pendingToolCalls.set(idx, existing);
              }
            }
          }
          return true;
        }

        if (data.type === 'response.output_text.delta') {
          const delta = typeof data.delta === 'string' ? data.delta : data.delta?.text || data.delta?.value || '';
          if (delta) {
            partsReportedCount++;
            options.progress.report(new vscode.LanguageModelTextPart(delta));
          }
          return false;
        }

        if (data.type === 'response.output_item.added') {
          if (data.item?.type === 'reasoning') {
            isReasoningActive = true;
            if (data.item.id) {
              currentThinkingId = data.item.id;
            }
            partsReportedCount++;
            const ThinkingPart = (vscode as any).LanguageModelThinkingPart;
            if (ThinkingPart) {
              options.progress.report(new ThinkingPart(data.item.text || '', currentThinkingId));
            }
            return false;
          }
          if (data.item?.type === 'function_call') {
            const idx = typeof data.output_index === 'number' ? data.output_index : 0;
            pendingToolCalls.set(idx, {
              id: data.item.call_id || data.item.id || `call_${Date.now()}`,
              name: data.item.name || '',
              args: data.item.arguments || '',
            });
            return false;
          }
        }

        if (data.type === 'response.reasoning_text.delta') {
          const delta = typeof data.delta === 'string' ? data.delta : data.delta?.text || data.delta?.value || '';
          if (delta && delta.length > 0) {
            reasoningDeltasEmitted = true;
            partsReportedCount++;
            const ThinkingPart = (vscode as any).LanguageModelThinkingPart;
            if (ThinkingPart) {
              options.progress.report(new ThinkingPart(delta, currentThinkingId));
            }
          }
          return false;
        }

        if (data.type === 'response.function_call_arguments.delta') {
          const idx = typeof data.output_index === 'number' ? data.output_index : 0;
          const current = pendingToolCalls.get(idx) || { id: '', name: '', args: '' };
          const delta = typeof data.delta === 'string' ? data.delta : data.delta?.arguments || '';
          current.args += delta;
          pendingToolCalls.set(idx, current);
          return false;
        }

        if (data.type === 'response.output_item.done') {
          if (data.item?.type === 'reasoning') {
            isReasoningActive = false;
            if (!reasoningDeltasEmitted && typeof data.item.text === 'string' && data.item.text.length > 0) {
              partsReportedCount++;
              const ThinkingPart = (vscode as any).LanguageModelThinkingPart;
              if (ThinkingPart) {
                options.progress.report(new ThinkingPart(data.item.text, currentThinkingId));
              }
            }
            return false;
          }
          if (data.item?.type === 'function_call') {
            const idx = typeof data.output_index === 'number' ? data.output_index : 0;
            const call = pendingToolCalls.get(idx) || {
              id: data.item.call_id || data.item.id || `call_${Date.now()}`,
              name: data.item.name || '',
              args: '',
            };
            if (data.item.name && !call.name) call.name = data.item.name;
            if (data.item.call_id && !call.id) call.id = data.item.call_id;

            const itemArgsRaw = data.item.arguments;
            if (itemArgsRaw !== undefined && itemArgsRaw !== null) {
              const itemArgsStr = typeof itemArgsRaw === 'string' ? itemArgsRaw : JSON.stringify(itemArgsRaw);
              if (!call.args || !call.args.trim()) {
                call.args = itemArgsStr;
              } else {
                let callValid = false;
                let parsedCallArgs: any = null;
                try {
                  parsedCallArgs = JSON.parse(call.args);
                  callValid = true;
                } catch {}

                if (!callValid) {
                  call.args = itemArgsStr;
                } else {
                  try {
                    const parsedItemArgs = typeof itemArgsRaw === 'object' ? itemArgsRaw : JSON.parse(itemArgsStr);
                    if (
                      parsedItemArgs && typeof parsedItemArgs === 'object' && !Array.isArray(parsedItemArgs) &&
                      parsedCallArgs && typeof parsedCallArgs === 'object' && !Array.isArray(parsedCallArgs)
                    ) {
                      call.args = JSON.stringify({ ...parsedCallArgs, ...parsedItemArgs });
                    }
                  } catch {}
                }
              }
            }

            let parsedArgs: any = {};
            try {
              parsedArgs = JSON.parse(call.args);
            } catch {
              parsedArgs = { raw: call.args };
            }
            if (!emittedToolCallIds.has(call.id) && !isSyntheticVerificationTool(call.name, options.tools)) {
              partsReportedCount++;
              emittedToolCallIds.add(call.id);
              options.progress.report(new vscode.LanguageModelToolCallPart(call.id, call.name, parsedArgs));
            }
            pendingToolCalls.delete(idx);
            return false;
          }
        }

        // 2. Handle OpenAI Chat Completions API stream format (used by DeepSeek, Kimi, GLM, MiMo, Qwen)
        const choice = data.choices?.[0];
        if (!choice) return false;

        // 1. Stream reasoning / thinking content from explicit reasoning fields
        const rawReasoning =
          choice.delta?.reasoning_content ||
          choice.delta?.thought ||
          choice.delta?.reasoning ||
          (Array.isArray(choice.delta?.reasoning_details)
            ? choice.delta.reasoning_details.map((d: any) => d.text || '').join('')
            : undefined);

        if (rawReasoning && rawReasoning.length > 0) {
          emitThinking(rawReasoning);
        }

        // 2. Stream delta text content, splitting out inline <think> tags
        // via a chunk-boundary-safe parser (tags can be split across SSE chunks).
        const content = choice.delta?.content;
        if (content) {
          const { text, thinking } = thinkParser.feed(content);
          emitThinking(thinking);
          if (text) {
            partsReportedCount++;
            options.progress.report(new vscode.LanguageModelTextPart(text));
          }
        }

        // Accumulate streaming tool calls
        if (choice.delta?.tool_calls) {
          choice.delta.tool_calls.forEach((tc: any, i: number) => {
            const idx = tc.index ?? i;
            const current = pendingToolCalls.get(idx) || { id: '', name: '', args: '' };
            if (tc.id) current.id = tc.id;
            if (tc.function?.name) current.name += tc.function.name;
            if (tc.function?.arguments) current.args += tc.function.arguments;
            pendingToolCalls.set(idx, current);
          });
        }

        // If finish_reason indicates tool_calls, emit completed tool call parts
        if (choice.finish_reason === 'tool_calls' || (choice.finish_reason === 'stop' && pendingToolCalls.size > 0)) {
          flushPendingToolCalls();
        }

        if (choice.finish_reason === 'stop') {
          return true;
        }
      } catch {}
    }
    return false;
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
          flushPendingToolCalls();
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
        flushPendingToolCalls();
        break;
      }

      if (isDone) break;
    }
    const flushed = thinkParser.flush();
    if (flushed.thinking) emitThinking(flushed.thinking);
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
      options.stallAttempt < options.maxStallRetries &&
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
          `\n\n*(Response stream interrupted: ${errMsg || 'Connection closed by upstream OpenCode service'})*`
        )
      );
      return 'done';
    }
  } finally {
    if (!isStallRetry) {
      // Flush any remaining accumulated tool calls ONLY if stream was NOT interrupted/canceled
      if (!hasStreamError && !options.token.isCancellationRequested && !options.abortSignal.aborted && pendingToolCalls.size > 0) {
        flushPendingToolCalls();
      }
      if (!hasStreamError && !options.token.isCancellationRequested && !options.abortSignal.aborted) {
        options.log(`Stream completed for model=${options.modelId}`);
      }
    }
  }

  return isStallRetry ? 'retry' : 'done';
}
