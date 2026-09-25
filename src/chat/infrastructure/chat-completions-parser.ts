// Chat infrastructure: Chat Completions SSE event parsing.
import type { SseEvent, StreamSink } from './sse-reader.js';

export function processChatCompletionsEvent(event: SseEvent, sink: StreamSink): boolean {
  const data: any = event.data;

  // Handle OpenAI Chat Completions API stream format (used by DeepSeek, Kimi, GLM, MiMo, Qwen)
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
    sink.emitThinking(rawReasoning, sink.thinkingId);
  }

  // 2. Stream delta text content, splitting out inline <think> tags
  // via a chunk-boundary-safe parser (tags can be split across SSE chunks).
  const content = choice.delta?.content;
  if (content) {
    const { text, thinking } = sink.feedThinkTags(content);
    if (thinking) {
      sink.emitThinking(thinking, sink.thinkingId);
    }
    if (text) {
      sink.emitText(text);
    }
  }

  // Accumulate streaming tool calls
  if (choice.delta?.tool_calls) {
    choice.delta.tool_calls.forEach((tc: any, i: number) => {
      const idx = tc.index ?? i;
      const current = sink.queuedToolCall(idx) || { id: '', name: '', args: '' };
      if (tc.id) current.id = tc.id;
      if (tc.function?.name) current.name += tc.function.name;
      if (tc.function?.arguments) current.args += tc.function.arguments;
      sink.queueToolCall({ ...current, index: idx });
    });
  }

  // If finish_reason indicates tool_calls, emit completed tool call parts
  if (choice.finish_reason === 'tool_calls' || (choice.finish_reason === 'stop' && sink.queuedToolCallCount() > 0)) {
    sink.flushToolCalls();
  }

  if (choice.finish_reason === 'stop') {
    return true;
  }
  return false;
}
