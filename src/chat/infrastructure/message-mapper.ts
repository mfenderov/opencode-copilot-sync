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
