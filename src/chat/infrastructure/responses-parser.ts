// Chat infrastructure: Responses API SSE event parsing.
import type { SseEvent, StreamSink } from './sse-reader.js';

export function processResponsesEvent(event: SseEvent, sink: StreamSink): boolean {
  const data: any = event.data;

  // Handle OpenAI Responses API stream format (used by Muse, GPT, Grok)
  if (data.type === 'response.completed') {
    sink.reasoningActive = false;
    sink.reportUsage(data);
    if (Array.isArray(data.response?.output)) {
      for (const item of data.response.output) {
        if (item?.type === 'function_call') {
          const callId = item.call_id || item.id || `call_${Date.now()}`;
          const idx = typeof item.output_index === 'number' ? item.output_index : sink.queuedToolCallCount();
          const existing = sink.queuedToolCall(idx) || { id: callId, name: item.name || '', args: '' };
          if (item.arguments) {
            existing.args = typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments);
          }
          sink.queueToolCall({ ...existing, index: idx });
        }
      }
    }
    return true;
  }

  if (data.type === 'response.output_text.delta') {
    const delta = typeof data.delta === 'string' ? data.delta : data.delta?.text || data.delta?.value || '';
    if (delta) {
      sink.emitText(delta);
    }
    return false;
  }

  if (data.type === 'response.output_item.added') {
    if (data.item?.type === 'reasoning') {
      sink.reasoningActive = true;
      if (data.item.id) {
        sink.thinkingId = data.item.id;
      }
      sink.emitThinking(data.item.text || '', sink.thinkingId);
      return false;
    }
    if (data.item?.type === 'function_call') {
      const idx = typeof data.output_index === 'number' ? data.output_index : 0;
      sink.queueToolCall({
        index: idx,
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
      sink.reasoningDeltasEmitted = true;
      sink.emitThinking(delta, sink.thinkingId);
    }
    return false;
  }

  if (data.type === 'response.function_call_arguments.delta') {
    const idx = typeof data.output_index === 'number' ? data.output_index : 0;
    const current = sink.queuedToolCall(idx) || { id: '', name: '', args: '' };
    const delta = typeof data.delta === 'string' ? data.delta : data.delta?.arguments || '';
    current.args += delta;
    sink.queueToolCall({ ...current, index: idx });
    return false;
  }

  if (data.type === 'response.output_item.done') {
    if (data.item?.type === 'reasoning') {
      sink.reasoningActive = false;
      if (!sink.reasoningDeltasEmitted && typeof data.item.text === 'string' && data.item.text.length > 0) {
        sink.emitThinking(data.item.text, sink.thinkingId);
      }
      return false;
    }
    if (data.item?.type === 'function_call') {
      const idx = typeof data.output_index === 'number' ? data.output_index : 0;
      const call = sink.queuedToolCall(idx) || {
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

      sink.emitToolCall(call.id, call.name, call.args);
      sink.forgetQueuedToolCall(idx);
      return false;
    }
  }

  return false;
}
