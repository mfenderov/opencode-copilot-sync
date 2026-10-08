// Chat infrastructure: VS Code message to wire-format mapping.
import * as vscode from 'vscode';

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
  role: 'user' | 'assistant' | 'system';
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

function stringifyToolInput(input: unknown): string {
  return typeof input === 'string' ? input : JSON.stringify(input);
}

function formatToolCallPart(part: vscode.LanguageModelToolCallPart): FormattedToolCall {
  return {
    id: part.callId,
    type: 'function',
    function: {
      name: part.name,
      arguments: stringifyToolInput(part.input),
    },
  };
}

interface ResultPartValue {
  value?: unknown;
}

function partText(part: unknown): string {
  if (typeof part === 'string') return part;
  if (part && typeof part === 'object' && typeof (part as ResultPartValue).value === 'string') {
    return (part as ResultPartValue).value as string;
  }
  return JSON.stringify(part ?? '') ?? '';
}

function formatToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(partText).join('\n');
  }
  if (content !== undefined && content !== null) {
    return JSON.stringify(content) ?? '';
  }
  return '';
}

function isStaleThinkingPart(part: unknown): boolean {
  const ThinkingPart = (vscode as any).LanguageModelThinkingPart;
  return (
    (ThinkingPart && part instanceof ThinkingPart) ||
    (part as any)?.constructor?.name === 'LanguageModelThinkingPart' ||
    (part as any)?.type === 'thinking' ||
    (part as any)?.type === 'reasoning'
  );
}

/**
 * Maps a VS Code message role to the wire role. The proposed-API System role
 * is absent from the stable enum typings, so the comparison runs on the
 * numeric value: anything that is neither User nor Assistant is a system
 * instruction. It must stay 'system': sending it as 'assistant' fabricates a
 * prior assistant turn the model never made, which keeps reasoning models
 * narrating tool calls forever instead of concluding.
 *
 * `1` and `2` are LanguageModelChatMessageRole.User and .Assistant. Comparing
 * the enum members directly is a type error here: the stable typings exclude
 * the proposed System role, so the rule sees two values with no shared enum.
 */
function wireRole(role: vscode.LanguageModelChatMessageRole): string {
  const numericRole: number = role;
  if (numericRole === 1) return 'user';
  if (numericRole === 2) return 'assistant';
  return 'system';
}

export function formatProviderMessages(
  messages: readonly vscode.LanguageModelChatRequestMessage[]
): FormattedMessage[] {
  const formattedMessages: FormattedMessage[] = [];
  for (const msg of messages) {
    const role = wireRole(msg.role);
    let textContent = '';
    const toolCalls: FormattedToolCall[] = [];

    for (const part of msg.content) {
      if (isStaleThinkingPart(part)) {
        // Stale reasoning from prior turns MUST NEVER be replayed into textContent or input
        continue;
      }
      if (part instanceof vscode.LanguageModelTextPart) {
        textContent += part.value;
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        toolCalls.push(formatToolCallPart(part));
      } else if (part instanceof vscode.LanguageModelToolResultPart) {
        formattedMessages.push({
          role: 'tool',
          tool_call_id: part.callId,
          content: formatToolResultContent(part.content),
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

function appendAssistantInput(
  responsesInput: ResponsesInputItem[],
  msg: FormattedMessage
): void {
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
}

export function buildResponsesInput(formattedMessages: FormattedMessage[]): ResponsesInputItem[] {
  const responsesInput: ResponsesInputItem[] = [];
  for (const msg of formattedMessages) {
    if (msg.role === 'user' || msg.role === 'system') {
      responsesInput.push({ role: msg.role, content: msg.content ?? '' });
    } else if (msg.role === 'assistant') {
      appendAssistantInput(responsesInput, msg);
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
