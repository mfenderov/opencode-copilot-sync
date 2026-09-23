import * as vscode from 'vscode';
import { isFreeTierModel } from './fetcher.js';

export interface OpenCodeModelMeta {
  id: string;
  name: string;
  family: string;
  catalog?: 'go' | 'zen';
  isFree?: boolean;
  contextWindow: number;
  maxOutputTokens: number;
  vision: boolean;
  thinking?: boolean;
  supportsReasoningEffort?: string[];
  defaultReasoningEffort?: string;
  /** Upstream wire protocol, when known authoritatively (e.g. from models.dev). */
  apiType?: 'chat-completions' | 'messages' | 'responses';
}

export type WireToolDefinition = Record<string, unknown>;

/**
 * Determines whether a model speaks the OpenAI Responses API protocol.
 * Prefers authoritative `apiType` metadata (sourced from models.dev / the
 * live OpenCode catalog) when available, falling back to a name-based
 * heuristic only for models we have no metadata for yet.
 */
export function isResponsesModel(modelId: string, apiType?: string): boolean {
  if (apiType === 'responses') return true;
  if (apiType === 'chat-completions' || apiType === 'messages') return false;
  const lower = modelId.toLowerCase();
  return lower.includes('muse') || lower.includes('gpt-') || lower.includes('grok-');
}

/**
 * Determines whether a model belongs to OpenCode Zen catalog or Free tier,
 * which routes to https://opencode.ai/zen/v1 instead of the flat-rate Go gateway.
 */
export function isFreeOrZenModel(modelId: string, meta?: OpenCodeModelMeta): boolean {
  if (meta?.catalog === 'zen' || meta?.isFree) {
    return true;
  }
  if (meta?.catalog === 'go') {
    return false;
  }
  return isFreeTierModel(modelId);
}

/**
 * OpenCode's free tier and Zen gateway strictly verify that callers originate
 * from within the official OpenCode client by requiring core client tools
 * (`bash` and `read`) to be present in the request payload.
 */
export const OPENCODE_CLIENT_VERIFICATION_TOOLS_RESPONSES = [
  {
    type: 'function',
    name: 'bash',
    description: 'OpenCode client environment verification tool. Do not call this tool directly.',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
  },
  {
    type: 'function',
    name: 'read',
    description: 'OpenCode client environment verification tool. Do not call this tool directly.',
    parameters: {
      type: 'object',
      properties: { filePath: { type: 'string' } },
      required: ['filePath'],
    },
  },
];

export const OPENCODE_CLIENT_VERIFICATION_TOOLS_CHAT = [
  {
    type: 'function',
    function: {
      name: 'bash',
      description: 'OpenCode client environment verification tool. Do not call this tool directly.',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read',
      description: 'OpenCode client environment verification tool. Do not call this tool directly.',
      parameters: {
        type: 'object',
        properties: { filePath: { type: 'string' } },
        required: ['filePath'],
      },
    },
  },
];

export function injectOpenCodeVerificationTools(
  toolsPayload: WireToolDefinition[] | undefined,
  isResponses: boolean
): WireToolDefinition[] {
  const base = toolsPayload ?? [];
  if (isResponses) {
    const existing = new Set(base.map((t) => (typeof t.name === 'string' ? t.name : '')));
    const toAdd = OPENCODE_CLIENT_VERIFICATION_TOOLS_RESPONSES.filter((t) => !existing.has(t.name));
    return toAdd.length > 0 ? [...base, ...toAdd] : base;
  }
  const existing = new Set(
    base.map((t) => {
      const fn = t.function;
      if (typeof fn === 'object' && fn !== null && 'name' in fn && typeof fn.name === 'string') {
        return fn.name;
      }
      return '';
    })
  );
  const toAdd = OPENCODE_CLIENT_VERIFICATION_TOOLS_CHAT.filter((t) => !existing.has(t.function.name));
  return toAdd.length > 0 ? [...base, ...toAdd] : base;
}

function clampToolName(name: string): string {
  return name.length > 64 ? name.slice(0, 64) : name;
}

export function formatProviderTools(
  tools: readonly vscode.LanguageModelChatTool[] | undefined,
  isResponses: boolean,
  injectVerificationTools: boolean
): WireToolDefinition[] | undefined {
  let toolsPayload: WireToolDefinition[] | undefined;
  if (tools && tools.length > 0) {
    if (isResponses) {
      toolsPayload = tools.map((tool) => ({
        type: 'function',
        name: clampToolName(tool.name),
        description: tool.description,
        parameters: tool.inputSchema || { type: 'object', properties: {} },
      }));
    } else {
      toolsPayload = tools.map((tool) => ({
        type: 'function',
        function: {
          name: clampToolName(tool.name),
          description: tool.description,
          parameters: tool.inputSchema || { type: 'object', properties: {} },
        },
      }));
    }
  }

  return injectVerificationTools
    ? injectOpenCodeVerificationTools(toolsPayload, isResponses)
    : toolsPayload;
}

export function isSyntheticVerificationTool(
  toolName: string,
  callerTools: readonly vscode.LanguageModelChatTool[] | undefined
): boolean {
  if (toolName !== 'bash' && toolName !== 'read') {
    return false;
  }
  if (!callerTools || callerTools.length === 0) {
    return true;
  }
  return !callerTools.some((tool) => clampToolName(tool.name) === toolName);
}

const VALID_REASONING_EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh']);

export function normalizeReasoningEffort(
  effort: string | undefined,
  isResponses: boolean
): Record<string, unknown> {
  if (!effort) return {};
  const lower = String(effort).toLowerCase().trim();
  if (lower === 'none' || lower === 'off') {
    return {};
  }
  // Standard OpenAI API across both Responses and Chat Completions protocols
  // strictly defines: 'low' | 'medium' | 'high' (and 'minimal'/'xhigh' on select providers).
  // Non-standard 'max' causes HTTP 400 Bad Request on upstream providers (e.g. Muse, MiMo).
  // Map 'max' to 'high' for guaranteed compatibility while maximizing reasoning depth.
  const mappedEffort = lower === 'max' ? 'high' : lower;

  // Defense in depth: never forward a value the upstream API doesn't recognize.
  // An unrecognized effort (garbage config, future VS Code UI values, etc.)
  // reliably causes a 400 Bad Request upstream — omitting the param is safer
  // than guessing, and lets the model fall back to its own default.
  if (!VALID_REASONING_EFFORTS.has(mappedEffort)) {
    return {};
  }

  return isResponses ? { reasoning: { effort: mappedEffort } } : { reasoning_effort: mappedEffort };
}

export function getReasoningEffort(options: vscode.ProvideLanguageModelChatResponseOptions): string | undefined {
  return (
    (options as any)?.modelConfiguration?.reasoningEffort ||
    (options as any)?.modelConfiguration?.thinkingLevel ||
    (options as any)?.configuration?.reasoningEffort ||
    (options as any)?.configuration?.thinkingLevel ||
    (options as any)?.reasoningEffort ||
    (options as any)?.thinkingLevel
  );
}

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

export interface FormattedToolCall {
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

export interface FormattedMessage {
  role: string;
  content?: string;
  tool_calls?: FormattedToolCall[];
  tool_call_id?: string;
}

export interface ResponsesInputMessage {
  role: 'user' | 'assistant';
  content: string | { type: string; text?: string; [key: string]: unknown }[];
}

export interface ResponsesInputFunctionCall {
  type: 'function_call';
  id: string;
  call_id: string;
  name: string;
  arguments: string;
}

export interface ResponsesInputFunctionCallOutput {
  type: 'function_call_output';
  call_id: string;
  output: string;
}

export type ResponsesInputItem =
  | ResponsesInputMessage
  | ResponsesInputFunctionCall
  | ResponsesInputFunctionCallOutput
  | Record<string, unknown>;

export function formatProviderMessages(
  messages: readonly vscode.LanguageModelChatRequestMessage[]
): FormattedMessage[] {
  const formattedMessages: FormattedMessage[] = [];
  for (const msg of messages) {
    const role =
      msg.role === vscode.LanguageModelChatMessageRole.User
        ? 'user'
        : 'assistant';

    let textContent = '';
    const toolCalls: FormattedToolCall[] = [];

    for (const part of msg.content) {
      const ThinkingPart = (vscode as any).LanguageModelThinkingPart;
      const isThinkingPart =
        (ThinkingPart && part instanceof ThinkingPart) ||
        (part as any)?.constructor?.name === 'LanguageModelThinkingPart' ||
        (part as any)?.type === 'thinking' ||
        (part as any)?.type === 'reasoning';
      if (isThinkingPart) {
        // Stale reasoning from prior turns MUST NEVER be replayed into textContent or input
        continue;
      }
      if (part instanceof vscode.LanguageModelTextPart) {
        textContent += part.value;
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        toolCalls.push({
          id: part.callId,
          type: 'function',
          function: {
            name: part.name,
            arguments:
              typeof part.input === 'string'
                ? part.input
                : JSON.stringify(part.input),
          },
        });
      } else if (part instanceof vscode.LanguageModelToolResultPart) {
        let resultStr = '';
        if (typeof part.content === 'string') {
          resultStr = part.content;
        } else if (Array.isArray(part.content)) {
          resultStr = part.content
            .map((p: any) => {
              if (typeof p === 'string') return p;
              if (p && typeof p.value === 'string') return p.value;
              return JSON.stringify(p ?? '') ?? '';
            })
            .join('\n');
        } else if (part.content !== undefined && part.content !== null) {
          resultStr = JSON.stringify(part.content) ?? '';
        } else {
          resultStr = '';
        }
        formattedMessages.push({
          role: 'tool',
          tool_call_id: part.callId,
          content: resultStr,
        });
      }
    }

    if (textContent || toolCalls.length > 0) {
      const entry: FormattedMessage = { role, content: textContent };
      if (toolCalls.length > 0) {
        entry.tool_calls = toolCalls;
      }
      formattedMessages.push(entry);
    }
  }

  return formattedMessages;
}

export function isStaleReasoningInput(item: unknown): boolean {
  if (typeof item !== 'object' || item === null) return false;
  const rec = item as Record<string, unknown>;
  if (
    rec.type === 'reasoning' ||
    rec.type === 'thought' ||
    rec.type === 'thinking' ||
    typeof rec.encrypted_content === 'string'
  ) {
    return true;
  }
  if (Array.isArray(rec.content)) {
    return rec.content.some((part: unknown) => {
      if (typeof part !== 'object' || part === null) return false;
      const p = part as Record<string, unknown>;
      return (
        p.type === 'reasoning' ||
        p.type === 'thought' ||
        p.type === 'thinking' ||
        typeof p.encrypted_content === 'string'
      );
    });
  }
  return false;
}

export function sanitizeResponsesInput(input: unknown[]): ResponsesInputItem[] {
  const result: ResponsesInputItem[] = [];
  for (const item of input) {
    if (typeof item !== 'object' || item === null) continue;
    const rec = item as Record<string, unknown>;
    // If top-level reasoning item or encrypted_content, drop completely
    if (
      rec.type === 'reasoning' ||
      rec.type === 'thought' ||
      rec.type === 'thinking' ||
      typeof rec.encrypted_content === 'string'
    ) {
      continue;
    }
    // If message contains content array with reasoning parts, filter out the reasoning parts
    if (Array.isArray(rec.content)) {
      const contentArr = rec.content as unknown[];
      const filteredParts = contentArr.filter((part: unknown) => {
        if (typeof part !== 'object' || part === null) return true;
        const p = part as Record<string, unknown>;
        return (
          p.type !== 'reasoning' &&
          p.type !== 'thought' &&
          p.type !== 'thinking' &&
          typeof p.encrypted_content !== 'string'
        );
      });
      if (filteredParts.length === 0 && !rec.tool_calls) {
        continue;
      }
      result.push({ ...rec, content: filteredParts });
      continue;
    }
    result.push(item as ResponsesInputItem);
  }
  return result;
}

export function buildResponsesInput(formattedMessages: FormattedMessage[]): ResponsesInputItem[] {
  const responsesInput: ResponsesInputItem[] = [];
  for (const msg of formattedMessages) {
    if (msg.role === 'user') {
      responsesInput.push({ role: 'user', content: msg.content ?? '' });
    } else if (msg.role === 'assistant') {
      if (msg.content) {
        responsesInput.push({
          role: 'assistant',
          content: [{ type: 'output_text', text: msg.content }],
        });
      }
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          const rawId = tc.id ?? '';
          const callId = rawId.length > 0 ? rawId : `call_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
          responsesInput.push({
            type: 'function_call',
            id: callId,
            call_id: callId,
            name: tc.function?.name ?? '',
            arguments: tc.function?.arguments ?? '',
          });
        }
      }
    } else if (msg.role === 'tool') {
      responsesInput.push({
        type: 'function_call_output',
        call_id: msg.tool_call_id ?? '',
        output: msg.content ?? '',
      });
    }
  }
  return sanitizeResponsesInput(responsesInput);
}

export interface ProviderRequestInput {
  modelId: string;
  isResponses: boolean;
  isFreeOrZen: boolean;
  formattedMessages: FormattedMessage[];
  toolsPayload: WireToolDefinition[] | undefined;
  responsesInput: unknown[];
  reasoningEffort: string | undefined;
}

export interface ProviderRequest {
  url: string;
  body: Record<string, unknown>;
}

export function createProviderRequest(input: ProviderRequestInput): ProviderRequest {
  const baseUrl = input.isFreeOrZen
    ? 'https://opencode.ai/zen/v1'
    : 'https://opencode.ai/zen/go/v1';
  const url = input.isResponses ? `${baseUrl}/responses` : `${baseUrl}/chat/completions`;
  const reasoningPayload = normalizeReasoningEffort(input.reasoningEffort, input.isResponses);

  const sanitizedInput = sanitizeResponsesInput(input.responsesInput);
  const body: Record<string, unknown> = input.isResponses
    ? {
        model: input.modelId,
        input: sanitizedInput.length > 0
          ? sanitizedInput
          : input.formattedMessages.filter((message) => !isStaleReasoningInput(message)),
        tools: input.toolsPayload,
        stream: true,
        ...reasoningPayload,
      }
    : {
        model: input.modelId,
        messages: input.formattedMessages,
        tools: input.toolsPayload,
        stream: true,
        ...reasoningPayload,
      };

  return { url, body };
}

export function createOpenCodeRequestHeaders(
  apiKey: string,
  sessionId: string,
  requestId: string
): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'User-Agent': 'opencode/1.18.31',
    'x-opencode-client': 'cli',
    'x-opencode-session': sessionId,
    'x-opencode-request': requestId,
  };
}
