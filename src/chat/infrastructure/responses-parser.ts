// Chat infrastructure: Responses API SSE event parsing.
import type { StreamSink } from './sse-reader.js';

type ResponsesData = Record<string, any>;

function extractDeltaText(data: ResponsesData): string {
  const delta: unknown = data.delta;
  if (typeof delta === 'string') return delta;
  if (delta && typeof delta === 'object') {
    const record = delta as Record<string, unknown>;
    if (typeof record.text === 'string') return record.text;
    if (typeof record.value === 'string') return record.value;
  }
  return '';
}

function queueIndex(item: ResponsesData, fallback: number): number {
  const raw = item.output_index;
  return typeof raw === 'number' ? raw : fallback;
}

function callIdentity(item: ResponsesData, fallbackId: string): { id: string; name: string } {
  return {
    id: item.call_id || item.id || fallbackId,
    name: item.name || '',
  };
}

function asArgsString(args: unknown): string {
  return typeof args === 'string' ? args : JSON.stringify(args);
}

function queueFunctionCallOutput(
  sink: StreamSink,
  item: ResponsesData,
  args: string
): void {
  const idx = queueIndex(item, sink.queuedToolCallCount());
  const { id, name } = callIdentity(item, `call_${Date.now()}`);
  const existing = sink.queuedToolCall(idx) || { id, name, args: '' };
  if (args) {
    existing.args = args;
  }
  sink.queueToolCall({ ...existing, index: idx });
}

function handleResponseCompleted(data: ResponsesData, sink: StreamSink): boolean {
  sink.reasoningActive = false;
  sink.reportUsage(data);
  if (!Array.isArray(data.response?.output)) return true;
  for (const item of data.response.output) {
    if (item?.type !== 'function_call') continue;
    queueFunctionCallOutput(sink, item, item.arguments ? asArgsString(item.arguments) : '');
  }
  return true;
}

function handleOutputTextDelta(data: ResponsesData, sink: StreamSink): boolean {
  const delta = extractDeltaText(data);
  if (delta) {
    sink.emitText(delta);
  }
  return false;
}

function handleOutputItemAdded(data: ResponsesData, sink: StreamSink): boolean {
  if (data.item?.type === 'reasoning') {
    sink.reasoningActive = true;
    if (data.item.id) {
      sink.thinkingId = data.item.id;
    }
    sink.emitThinking(data.item.text || '', sink.thinkingId);
    return false;
  }
  if (data.item?.type === 'function_call') {
    const { id, name } = callIdentity(data.item, `call_${Date.now()}`);
    sink.queueToolCall({
      index: queueIndex(data, 0),
      id,
      name,
      args: data.item.arguments || '',
    });
    return false;
  }
  return false;
}

function handleReasoningTextDelta(data: ResponsesData, sink: StreamSink): boolean {
  const delta = extractDeltaText(data);
  if (delta && delta.length > 0) {
    sink.reasoningDeltasEmitted = true;
    sink.emitThinking(delta, sink.thinkingId);
  }
  return false;
}

function handleFunctionCallArgumentsDelta(data: ResponsesData, sink: StreamSink): boolean {
  const idx = queueIndex(data, 0);
  const current = sink.queuedToolCall(idx) || { id: '', name: '', args: '' };
  const delta = typeof data.delta === 'string' ? data.delta : data.delta?.arguments || '';
  current.args += delta;
  sink.queueToolCall({ ...current, index: idx });
  return false;
}

function tryParseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function mergeCompleteFragment(accumulated: string, fragment: string): string {
  // A complete-JSON fragment means the accumulated text was an incomplete
  // prefix: the fragment supersedes it.
  if (tryParseJsonObject(fragment)) {
    return fragment;
  }
  return accumulated + fragment;
}

function mergeObjectFragment(accumulated: string, fragment: object): string {
  const parsedAccumulated = tryParseJsonObject(accumulated);
  if (!parsedAccumulated) {
    return JSON.stringify(fragment);
  }
  return JSON.stringify({ ...parsedAccumulated, ...(fragment as Record<string, unknown>) });
}

function mergeArgumentFragments(accumulated: string, fragment: unknown): string {
  if (accumulated.trim().length === 0 || fragment === undefined || fragment === null) {
    return fragment === undefined || fragment === null ? accumulated : asArgsString(fragment);
  }
  if (typeof fragment === 'string') {
    return mergeCompleteFragment(accumulated, fragment);
  }
  if (typeof fragment !== 'object' || Array.isArray(fragment)) {
    return accumulated;
  }
  return mergeObjectFragment(accumulated, fragment);
}

function completeFunctionCall(
  sink: StreamSink,
  data: ResponsesData,
  call: { id: string; name: string; args: string }
): void {
  const idx = queueIndex(data, 0);
  if (data.item.name && !call.name) call.name = data.item.name;
  if (data.item.call_id && !call.id) call.id = data.item.call_id;
  call.args = mergeArgumentFragments(call.args, data.item.arguments);
  sink.emitToolCall(call.id, call.name, call.args);
  sink.forgetQueuedToolCall(idx);
}

function handleOutputItemDone(data: ResponsesData, sink: StreamSink): boolean {
  if (data.item?.type === 'reasoning') {
    sink.reasoningActive = false;
    if (!sink.reasoningDeltasEmitted && typeof data.item.text === 'string' && data.item.text.length > 0) {
      sink.emitThinking(data.item.text, sink.thinkingId);
    }
    return false;
  }
  if (data.item?.type !== 'function_call') {
    return false;
  }
  const call = sink.queuedToolCall(queueIndex(data, 0)) || {
    ...callIdentity(data.item, `call_${Date.now()}`),
    args: '',
  };
  completeFunctionCall(sink, data, call);
  return false;
}

const RESPONSES_HANDLERS: Record<string, (data: ResponsesData, sink: StreamSink) => boolean> = {
  'response.completed': handleResponseCompleted,
  'response.output_text.delta': handleOutputTextDelta,
  'response.output_item.added': handleOutputItemAdded,
  'response.reasoning_text.delta': handleReasoningTextDelta,
  'response.function_call_arguments.delta': handleFunctionCallArgumentsDelta,
  'response.output_item.done': handleOutputItemDone,
};

interface ResponsesEvent {
  type: string;
  data: unknown;
}

export function processResponsesEvent(event: ResponsesEvent, sink: StreamSink): boolean {
  if (typeof event.data !== 'object' || event.data === null) return false;
  const data = event.data as ResponsesData;
  const handler = typeof data.type === 'string' ? RESPONSES_HANDLERS[data.type] : undefined;
  if (!handler) return false;
  return handler(data, sink);
}
