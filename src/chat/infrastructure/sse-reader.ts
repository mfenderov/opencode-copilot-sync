// Chat infrastructure: SSE framing and stream sink contract.
/**
 * Chunk-boundary-safe parser for inline `<think>...</think>` tags that some
 * Chat Completions models emit within regular content deltas. SSE deltas can
 * split the tag literal itself across chunk boundaries (e.g. `<thi` + `nk>`),
 * so this buffers any trailing partial tag match instead of naively scanning
 * each chunk in isolation.
 */
export class ThinkTagStreamParser {
  private buffer = '';
  private inThink = false;

  private static readonly OPEN = '<think>';
  private static readonly CLOSE = '</think>';

  /** Returns the longest suffix of `s` that is a strict, non-empty prefix of `tag`. */
  private static trailingPartialMatch(s: string, tag: string): string {
    const maxLen = Math.min(s.length, tag.length - 1);
    for (let len = maxLen; len > 0; len--) {
      if (s.slice(s.length - len) === tag.slice(0, len)) {
        return s.slice(s.length - len);
      }
    }
    return '';
  }

  feed(chunk: string): { text: string; thinking: string } {
    this.buffer += chunk;
    let text = '';
    let thinking = '';

    for (;;) {
      if (this.inThink) {
        const closeIdx = this.buffer.indexOf(ThinkTagStreamParser.CLOSE);
        if (closeIdx === -1) {
          const pending = ThinkTagStreamParser.trailingPartialMatch(this.buffer, ThinkTagStreamParser.CLOSE);
          thinking += this.buffer.slice(0, this.buffer.length - pending.length);
          this.buffer = pending;
          break;
        }
        thinking += this.buffer.slice(0, closeIdx);
        this.buffer = this.buffer.slice(closeIdx + ThinkTagStreamParser.CLOSE.length);
        this.inThink = false;
      } else {
        const openIdx = this.buffer.indexOf(ThinkTagStreamParser.OPEN);
        if (openIdx === -1) {
          const pending = ThinkTagStreamParser.trailingPartialMatch(this.buffer, ThinkTagStreamParser.OPEN);
          text += this.buffer.slice(0, this.buffer.length - pending.length);
          this.buffer = pending;
          break;
        }
        text += this.buffer.slice(0, openIdx);
        this.buffer = this.buffer.slice(openIdx + ThinkTagStreamParser.OPEN.length);
        this.inThink = true;
      }
    }

    return { text, thinking };
  }

  /** Flush any buffered content at stream end. A dangling partial tag prefix
   * that never completed was never a real tag, so it's emitted as plain text
   * (or thinking text, if we were mid-think-block when the stream ended). */
  flush(): { text: string; thinking: string } {
    const remaining = this.buffer;
    this.buffer = '';
    return this.inThink ? { text: '', thinking: remaining } : { text: remaining, thinking: '' };
  }
}

export interface SseEvent {
  type: string;
  data: unknown;
}

export type ParsedSseLine =
  | { kind: 'skip' }
  | { kind: 'done' }
  | { kind: 'event'; event: SseEvent };

function readEventType(data: unknown): string {
  if (data !== null && typeof data === 'object' && 'type' in data && typeof data.type === 'string') {
    return data.type;
  }
  return '';
}

export function parseSseLine(line: string): ParsedSseLine {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed.startsWith(':')) return { kind: 'skip' };
  if (trimmed === 'data: [DONE]') return { kind: 'done' };
  if (!trimmed.startsWith('data: ')) return { kind: 'skip' };
  try {
    const data: unknown = JSON.parse(trimmed.slice(6));
    return { kind: 'event', event: { type: readEventType(data), data } };
  } catch {
    return { kind: 'skip' };
  }
}

export interface QueuedToolCall {
  index: number;
  id: string;
  name: string;
  args: string;
}

/**
 * Reporting seam between the protocol parsers and the stream orchestration.
 * The parsers stay free of VS Code and transport details; the orchestration
 * implements this interface over its progress reporter and per-stream state.
 */
export interface StreamSink {
  emitText(text: string): void;
  emitThinking(text: string, id: string): void;
  emitToolCall(id: string, name: string, args: string): void;
  queueToolCall(call: QueuedToolCall): void;
  queuedToolCall(index: number): QueuedToolCall | undefined;
  forgetQueuedToolCall(index: number): void;
  queuedToolCallCount(): number;
  flushToolCalls(): void;
  reportUsage(event: unknown): void;
  complete(): void;
  thinkingId: string;
  reasoningActive: boolean;
  reasoningDeltasEmitted: boolean;
  feedThinkTags(chunk: string): { text: string; thinking: string };
  flushThinkTags(): { text: string; thinking: string };
}
