export type { OpenCodeModelMeta } from './models/domain/model.js';
export type { ModelTokenLimits } from './models/domain/token-budget.js';
export { resolveModelTokenLimits } from './models/domain/token-budget.js';
export {
  buildResponsesInput,
  formatProviderMessages,
  sanitizeResponsesInput,
} from './chat/infrastructure/message-mapper.js';
export type {
  FormattedMessage,
  FormattedToolCall,
  ResponsesInputFunctionCall,
  ResponsesInputFunctionCallOutput,
  ResponsesInputItem,
  ResponsesInputMessage,
} from './chat/infrastructure/message-mapper.js';
export {
  formatProviderTools,
  injectOpenCodeVerificationTools,
  isSyntheticVerificationTool,
  OPENCODE_CLIENT_VERIFICATION_TOOLS_CHAT,
  OPENCODE_CLIENT_VERIFICATION_TOOLS_RESPONSES,
} from './chat/infrastructure/tool-mapper.js';
export type { WireToolDefinition } from './chat/infrastructure/tool-mapper.js';
export {
  createOpenCodeRequestHeaders,
  createProviderRequest,
  isFreeOrZenModel,
  isResponsesModel,
} from './chat/infrastructure/request-factory.js';
export type {
  ProviderRequest,
  ProviderRequestInput,
} from './chat/infrastructure/request-factory.js';
export {
  getReasoningEffort,
  isStaleReasoningInput,
  normalizeReasoningEffort,
} from './chat/infrastructure/reasoning-controls.js';

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
