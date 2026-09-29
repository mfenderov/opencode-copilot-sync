// Chat infrastructure: Chat Completions SSE event parsing.
import type { SseEvent, StreamSink } from './sse-reader.js';

type ChoiceDelta = Record<string, unknown>;

interface ReasoningDetail {
  text?: unknown;
}

function detailText(detail: unknown): string {
  if (detail && typeof detail === 'object' && typeof (detail as ReasoningDetail).text === 'string') {
    return (detail as ReasoningDetail).text as string;
  }
  return '';
}

function extractReasoningText(delta: ChoiceDelta | undefined): string {
  if (!delta) return '';
  for (const key of ['reasoning_content', 'thought', 'reasoning'] as const) {
    const direct = delta[key];
    if (typeof direct === 'string' && direct.length > 0) return direct;
  }
  const details = delta.reasoning_details;
  if (!Array.isArray(details)) return '';
  return details.map(detailText).join('');
}

function emitSplitContent(content: unknown, sink: StreamSink): void {
  if (!content) return;
  // Inline <think> tags can split across SSE chunks, hence the boundary-safe parser.
  const { text, thinking } = sink.feedThinkTags(content as string);
  if (thinking) {
    sink.emitThinking(thinking, sink.thinkingId);
  }
  if (text) {
    sink.emitText(text);
  }
}

interface DeltaToolCall {
  index?: unknown;
  id?: unknown;
  function?: { name?: unknown; arguments?: unknown };
}

function accumulateToolCall(sink: StreamSink, tc: DeltaToolCall, position: number): void {
  const rawIndex = tc.index;
  const idx = typeof rawIndex === 'number' ? rawIndex : position;
  const current = sink.queuedToolCall(idx) || { id: '', name: '', args: '' };
  if (typeof tc.id === 'string') current.id = tc.id;
  const fn = tc.function && typeof tc.function === 'object' ? tc.function : undefined;
  if (typeof fn?.name === 'string') current.name += fn.name;
  if (typeof fn?.arguments === 'string') current.args += fn.arguments;
  sink.queueToolCall({ ...current, index: idx });
}

function shouldFlushToolCalls(finishReason: unknown, sink: StreamSink): boolean {
  return finishReason === 'tool_calls' || (finishReason === 'stop' && sink.queuedToolCallCount() > 0);
}

interface ChoiceDeltaHolder {
  delta?: ChoiceDelta & { tool_calls?: DeltaToolCall[] };
  finish_reason?: unknown;
}

export function processChatCompletionsEvent(event: SseEvent, sink: StreamSink): boolean {
  const data: unknown = event.data;

  // Handle OpenAI Chat Completions API stream format (used by DeepSeek, Kimi, GLM, MiMo, Qwen)
  const choice: ChoiceDeltaHolder | undefined =
    data && typeof data === 'object' && Array.isArray((data as { choices?: unknown }).choices)
      ? (data as { choices: ChoiceDeltaHolder[] }).choices[0]
      : undefined;
  if (!choice) return false;

  const reasoning = extractReasoningText(choice.delta);
  if (reasoning) {
    sink.emitThinking(reasoning, sink.thinkingId);
  }

  emitSplitContent(choice.delta?.content, sink);

  if (choice.delta?.tool_calls) {
    choice.delta.tool_calls.forEach((tc: DeltaToolCall, i: number) => {
      accumulateToolCall(sink, tc, i);
    });
  }

  if (shouldFlushToolCalls(choice.finish_reason, sink)) {
    sink.flushToolCalls();
  }

  return choice.finish_reason === 'stop';
}
