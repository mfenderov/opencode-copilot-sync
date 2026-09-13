import * as vscode from 'vscode';
import { getStoredOpenCodeKey } from './auth.js';
import { filterAvailableGoModels } from './fetcher.js';

export interface OpenCodeModelMeta {
  id: string;
  name: string;
  family: string;
  contextWindow: number;
  maxOutputTokens: number;
  vision: boolean;
}

export const VERIFIED_OPENCODE_MODELS: OpenCodeModelMeta[] = [
  { id: 'minimax-m3', name: 'MiniMax M3 (OpenCode)', family: 'minimax-m3', contextWindow: 1048576, maxOutputTokens: 131072, vision: false },
  { id: 'minimax-m2.5', name: 'MiniMax M2.5 (OpenCode)', family: 'minimax-m2.5', contextWindow: 1048576, maxOutputTokens: 131072, vision: false },
  { id: 'kimi-k3', name: 'Kimi K3 (OpenCode)', family: 'kimi-k3', contextWindow: 1048576, maxOutputTokens: 65536, vision: true },
  { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code (OpenCode)', family: 'kimi-k2.7-code', contextWindow: 1048576, maxOutputTokens: 65536, vision: true },
  { id: 'kimi-k2.6', name: 'Kimi K2.6 (OpenCode)', family: 'kimi-k2.6', contextWindow: 1048576, maxOutputTokens: 65536, vision: true },
  { id: 'longcat-2.0', name: 'Longcat 2.0 (OpenCode)', family: 'longcat-2.0', contextWindow: 1048576, maxOutputTokens: 65536, vision: false },
  { id: 'glm-5.2', name: 'GLM 5.2 (OpenCode)', family: 'glm-5.2', contextWindow: 1048576, maxOutputTokens: 131072, vision: true },
  { id: 'glm-5.3-flash', name: 'GLM 5.3 Flash (OpenCode)', family: 'glm-5.3-flash', contextWindow: 1048576, maxOutputTokens: 131072, vision: true },
  { id: 'glm-5.3', name: 'GLM 5.3 (OpenCode)', family: 'glm-5.3', contextWindow: 1048576, maxOutputTokens: 131072, vision: true },
  { id: 'glm-5.1', name: 'GLM 5.1 (OpenCode)', family: 'glm-5.1', contextWindow: 1048576, maxOutputTokens: 131072, vision: true },
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro (OpenCode)', family: 'deepseek-v4-pro', contextWindow: 1048576, maxOutputTokens: 131072, vision: false },
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash (OpenCode)', family: 'deepseek-v4-flash', contextWindow: 1048576, maxOutputTokens: 131072, vision: false },
  { id: 'deepseek-flash', name: 'DeepSeek Flash (OpenCode)', family: 'deepseek-flash', contextWindow: 1048576, maxOutputTokens: 131072, vision: false },
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash (OpenCode)', family: 'deepseek-v4.1-flash', contextWindow: 1048576, maxOutputTokens: 131072, vision: false },
  { id: 'deepseek-v4-flash-vision-exp', name: 'DeepSeek V4 Flash Vision Exp (OpenCode)', family: 'deepseek-v4-flash-vision-exp', contextWindow: 1048576, maxOutputTokens: 131072, vision: true },
  { id: 'qwen3.7-max', name: 'Qwen3.7 Max (OpenCode)', family: 'qwen3.7-max', contextWindow: 1000000, maxOutputTokens: 131072, vision: true },
  { id: 'qwen3.8-max', name: 'Qwen3.8 Max (OpenCode)', family: 'qwen3.8-max', contextWindow: 1000000, maxOutputTokens: 131072, vision: true },
  { id: 'qwen3.8-flash', name: 'Qwen3.8 Flash (OpenCode)', family: 'qwen3.8-flash', contextWindow: 1000000, maxOutputTokens: 131072, vision: true },
  { id: 'qwen3.6-plus', name: 'Qwen3.6 Plus (OpenCode)', family: 'qwen3.6-plus', contextWindow: 1000000, maxOutputTokens: 131072, vision: true },
  { id: 'mimo-v2.5-pro', name: 'MiMo V2.5 Pro (OpenCode)', family: 'mimo-v2.5-pro', contextWindow: 1048576, maxOutputTokens: 65536, vision: false },
  { id: 'mimo-v2.5', name: 'MiMo V2.5 (OpenCode)', family: 'mimo-v2.5', contextWindow: 1048576, maxOutputTokens: 65536, vision: false },
  { id: 'hy4-preview', name: 'Hy4 Preview (OpenCode)', family: 'hy4-preview', contextWindow: 1048576, maxOutputTokens: 65536, vision: false },
  { id: 'hy3', name: 'Hy3 (OpenCode)', family: 'hy3', contextWindow: 1048576, maxOutputTokens: 65536, vision: false },
  { id: 'omen-alpha', name: 'Omen Alpha (OpenCode)', family: 'omen-alpha', contextWindow: 1048576, maxOutputTokens: 65536, vision: false },
];

export class OpenCodeChatProvider implements vscode.LanguageModelChatProvider {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this._onDidChange.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  refresh(): void {
    this._onDidChange.fire();
  }

  async provideLanguageModelChatInformation(
    _options: vscode.PrepareLanguageModelChatModelOptions,
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelChatInformation[]> {
    return VERIFIED_OPENCODE_MODELS.map((m) => ({
      id: m.id,
      name: m.name,
      family: m.family,
      version: '1.0.0',
      maxInputTokens: m.contextWindow - m.maxOutputTokens,
      maxOutputTokens: m.maxOutputTokens,
      capabilities: {
        imageInput: m.vision,
        toolCalling: true,
      },
    }));
  }

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): Promise<void> {
    const apiKey =
      (await this.context.secrets.get('opencode_api_key')) ||
      getStoredOpenCodeKey(this.context.globalStorageUri?.fsPath) ||
      getStoredOpenCodeKey();

    if (!apiKey) {
      throw new Error(
        'OpenCode API key not found. Please run "OpenCode: Set API Key" command to configure your key.'
      );
    }

    // Format messages for OpenAI Chat Completions API
    const formattedMessages: any[] = [];
    for (const msg of messages) {
      const role =
        msg.role === vscode.LanguageModelChatMessageRole.User
          ? 'user'
          : 'assistant';

      let textContent = '';
      const toolCalls: any[] = [];

      for (const part of msg.content) {
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
              .map((p: any) => p.value || JSON.stringify(p))
              .join('\n');
          } else {
            resultStr = JSON.stringify(part.content);
          }
          formattedMessages.push({
            role: 'tool',
            tool_call_id: part.callId,
            content: resultStr,
          });
        }
      }

      if (textContent || toolCalls.length > 0) {
        const entry: any = { role, content: textContent };
        if (toolCalls.length > 0) {
          entry.tool_calls = toolCalls;
        }
        formattedMessages.push(entry);
      }
    }

    // Format tool definitions
    let toolsPayload: any[] | undefined = undefined;
    if (options.tools && options.tools.length > 0) {
      toolsPayload = options.tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema || { type: 'object', properties: {} },
        },
      }));
    }

    const abortController = new AbortController();
    token.onCancellationRequested(() => abortController.abort());

    const url = 'https://opencode.ai/zen/go/v1/chat/completions';
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'x-opencode-session': 'vscode-copilot',
      },
      body: JSON.stringify({
        model: model.id,
        messages: formattedMessages,
        tools: toolsPayload,
        stream: true,
      }),
      signal: abortController.signal,
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`OpenCode API error (${res.status} ${res.statusText}): ${errText}`);
    }

    if (!res.body) {
      throw new Error('OpenCode API returned empty body');
    }

    // Parse streaming SSE response
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    // Track in-progress tool calls
    const pendingToolCalls = new Map<number, { id: string; name: string; args: string }>();

    try {
      while (true) {
        if (token.isCancellationRequested) break;
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(':')) continue;
          if (trimmed === 'data: [DONE]') continue;

          if (trimmed.startsWith('data: ')) {
            try {
              const data = JSON.parse(trimmed.slice(6));
              const choice = data.choices?.[0];
              if (!choice) continue;

              // Stream delta text content
              if (choice.delta?.content) {
                progress.report(new vscode.LanguageModelTextPart(choice.delta.content));
              }

              // Accumulate streaming tool calls
              if (choice.delta?.tool_calls) {
                for (const tc of choice.delta.tool_calls) {
                  const idx = tc.index ?? 0;
                  const current = pendingToolCalls.get(idx) || { id: '', name: '', args: '' };
                  if (tc.id) current.id = tc.id;
                  if (tc.function?.name) current.name += tc.function.name;
                  if (tc.function?.arguments) current.args += tc.function.arguments;
                  pendingToolCalls.set(idx, current);
                }
              }

              // If finish_reason indicates tool_calls, emit completed tool call parts
              if (choice.finish_reason === 'tool_calls' || (choice.finish_reason === 'stop' && pendingToolCalls.size > 0)) {
                for (const [, call] of pendingToolCalls) {
                  let parsedArgs: any = {};
                  try {
                    parsedArgs = JSON.parse(call.args);
                  } catch {
                    parsedArgs = { raw: call.args };
                  }
                  progress.report(new vscode.LanguageModelToolCallPart(call.id, call.name, parsedArgs));
                }
                pendingToolCalls.clear();
              }
            } catch {}
          }
        }
      }
    } finally {
      // Flush any remaining accumulated tool calls
      if (pendingToolCalls.size > 0) {
        for (const [, call] of pendingToolCalls) {
          let parsedArgs: any = {};
          try {
            parsedArgs = JSON.parse(call.args);
          } catch {
            parsedArgs = { raw: call.args };
          }
          progress.report(new vscode.LanguageModelToolCallPart(call.id, call.name, parsedArgs));
        }
        pendingToolCalls.clear();
      }
    }
  }

  provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken
  ): Thenable<number> {
    const raw = typeof text === 'string' ? text : JSON.stringify(text);
    return Promise.resolve(Math.ceil(raw.length / 4));
  }
}
