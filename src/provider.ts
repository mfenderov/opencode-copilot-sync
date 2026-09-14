import * as vscode from 'vscode';
import { getStoredOpenCodeKey, getKeyFromExistingConfig } from './auth.js';
import { filterAvailableGoModels } from './fetcher.js';

export interface OpenCodeModelMeta {
  id: string;
  name: string;
  family: string;
  contextWindow: number;
  maxOutputTokens: number;
  vision: boolean;
  thinking?: boolean;
}

export const VERIFIED_OPENCODE_MODELS: OpenCodeModelMeta[] = [
  { id: 'minimax-m3', name: 'MiniMax M3 (OpenCode)', family: 'minimax-m3', contextWindow: 1048576, maxOutputTokens: 131072, vision: false, thinking: false },
  { id: 'minimax-m2.5', name: 'MiniMax M2.5 (OpenCode)', family: 'minimax-m2.5', contextWindow: 1048576, maxOutputTokens: 131072, vision: false, thinking: false },
  { id: 'kimi-k3', name: 'Kimi K3 (OpenCode)', family: 'kimi-k3', contextWindow: 1048576, maxOutputTokens: 65536, vision: true, thinking: true },
  { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code (OpenCode)', family: 'kimi-k2.7-code', contextWindow: 1048576, maxOutputTokens: 65536, vision: true, thinking: true },
  { id: 'kimi-k2.6', name: 'Kimi K2.6 (OpenCode)', family: 'kimi-k2.6', contextWindow: 1048576, maxOutputTokens: 65536, vision: true, thinking: true },
  { id: 'longcat-2.0', name: 'Longcat 2.0 (OpenCode)', family: 'longcat-2.0', contextWindow: 1048576, maxOutputTokens: 65536, vision: false, thinking: false },
  { id: 'glm-5.2', name: 'GLM 5.2 (OpenCode)', family: 'glm-5.2', contextWindow: 1048576, maxOutputTokens: 131072, vision: true, thinking: true },
  { id: 'glm-5.3-flash', name: 'GLM 5.3 Flash (OpenCode)', family: 'glm-5.3-flash', contextWindow: 1048576, maxOutputTokens: 131072, vision: true, thinking: true },
  { id: 'glm-5.3', name: 'GLM 5.3 (OpenCode)', family: 'glm-5.3', contextWindow: 1048576, maxOutputTokens: 131072, vision: true, thinking: true },
  { id: 'glm-5.1', name: 'GLM 5.1 (OpenCode)', family: 'glm-5.1', contextWindow: 1048576, maxOutputTokens: 131072, vision: true, thinking: true },
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro (OpenCode)', family: 'deepseek-v4-pro', contextWindow: 1048576, maxOutputTokens: 131072, vision: false, thinking: true },
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash (OpenCode)', family: 'deepseek-v4-flash', contextWindow: 1048576, maxOutputTokens: 131072, vision: false, thinking: true },
  { id: 'deepseek-flash', name: 'DeepSeek Flash (OpenCode)', family: 'deepseek-flash', contextWindow: 1048576, maxOutputTokens: 131072, vision: false, thinking: true },
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash (OpenCode)', family: 'deepseek-v4.1-flash', contextWindow: 1048576, maxOutputTokens: 131072, vision: false, thinking: true },
  { id: 'deepseek-v4-flash-vision-exp', name: 'DeepSeek V4 Flash Vision Exp (OpenCode)', family: 'deepseek-v4-flash-vision-exp', contextWindow: 1048576, maxOutputTokens: 131072, vision: true, thinking: true },
  { id: 'qwen3.7-max', name: 'Qwen3.7 Max (OpenCode)', family: 'qwen3.7-max', contextWindow: 1000000, maxOutputTokens: 131072, vision: true, thinking: false },
  { id: 'qwen3.8-max', name: 'Qwen3.8 Max (OpenCode)', family: 'qwen3.8-max', contextWindow: 1000000, maxOutputTokens: 131072, vision: true, thinking: false },
  { id: 'qwen3.8-flash', name: 'Qwen3.8 Flash (OpenCode)', family: 'qwen3.8-flash', contextWindow: 1000000, maxOutputTokens: 131072, vision: true, thinking: false },
  { id: 'qwen3.6-plus', name: 'Qwen3.6 Plus (OpenCode)', family: 'qwen3.6-plus', contextWindow: 1000000, maxOutputTokens: 131072, vision: true, thinking: false },
  { id: 'mimo-v2.5-pro', name: 'MiMo V2.5 Pro (OpenCode)', family: 'mimo-v2.5-pro', contextWindow: 1048576, maxOutputTokens: 65536, vision: false, thinking: true },
  { id: 'mimo-v2.5', name: 'MiMo V2.5 (OpenCode)', family: 'mimo-v2.5', contextWindow: 1048576, maxOutputTokens: 65536, vision: false, thinking: true },
  { id: 'hy4-preview', name: 'Hy4 Preview (OpenCode)', family: 'hy4-preview', contextWindow: 1048576, maxOutputTokens: 65536, vision: false, thinking: true },
  { id: 'hy3', name: 'Hy3 (OpenCode)', family: 'hy3', contextWindow: 1048576, maxOutputTokens: 65536, vision: false, thinking: false },
  { id: 'omen-alpha', name: 'Omen Alpha (OpenCode)', family: 'omen-alpha', contextWindow: 1048576, maxOutputTokens: 65536, vision: false, thinking: true },
  // Verified OpenCode Free models (always available and visible)
  { id: 'big-pickle', name: 'Big Pickle (Free)', family: 'big-pickle', contextWindow: 1048576, maxOutputTokens: 65536, vision: false, thinking: false },
  { id: 'mimo-v2.5-free', name: 'MiMo V2.5 (Free)', family: 'mimo-v2.5-free', contextWindow: 1048576, maxOutputTokens: 65536, vision: false, thinking: true },
  { id: 'ling-3.0-flash-fin-free', name: 'Ling 3.0 Flash Fin (Free)', family: 'ling-3.0-flash-fin-free', contextWindow: 1048576, maxOutputTokens: 65536, vision: false, thinking: false },
  { id: 'nemotron-3-ultra-free', name: 'Nemotron 3 Ultra (Free)', family: 'nemotron-3-ultra-free', contextWindow: 1000000, maxOutputTokens: 128000, vision: false, thinking: true },
  { id: 'nemotron-3.5-lightning-free', name: 'Nemotron 3.5 Lightning (Free)', family: 'nemotron-3.5-lightning-free', contextWindow: 1000000, maxOutputTokens: 128000, vision: false, thinking: true },
  { id: 'deepseek-v4-flash-free', name: 'DeepSeek V4 Flash (Free)', family: 'deepseek-v4-flash-free', contextWindow: 1048576, maxOutputTokens: 131072, vision: false, thinking: true },
  { id: 'muse-spark-1.3-contributor-free', name: 'Muse Spark 1.3 Contributor (Free)', family: 'muse-spark-1.3-contributor-free', contextWindow: 1048576, maxOutputTokens: 65536, vision: false, thinking: false },
  { id: 'muse-spark-1.2-contributor-free', name: 'Muse Spark 1.2 Contributor (Free)', family: 'muse-spark-1.2-contributor-free', contextWindow: 1048576, maxOutputTokens: 65536, vision: false, thinking: false },
];

export class OpenCodeChatProvider implements vscode.LanguageModelChatProvider {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this._onDidChange.event;
  private _models: OpenCodeModelMeta[] = [...VERIFIED_OPENCODE_MODELS];

  constructor(private readonly context: vscode.ExtensionContext) {}

  refresh(): void {
    this._onDidChange.fire();
  }

  updateModels(models: OpenCodeModelMeta[]): void {
    if (Array.isArray(models) && models.length > 0) {
      this._models = models;
      this.refresh();
    }
  }

  async provideLanguageModelChatInformation(
    _options: vscode.PrepareLanguageModelChatModelOptions,
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelChatInformation[]> {
    return this._models.map((m) => {
      const supportsReasoning = m.thinking !== false;
      const reasoningSchema = supportsReasoning
        ? {
            properties: {
              reasoningEffort: {
                type: 'string',
                title: 'Thinking Effort',
                enum: ['low', 'medium', 'high'],
                enumItemLabels: ['Low', 'Medium', 'High'],
                enumDescriptions: [
                  'Faster responses with less reasoning',
                  'Balanced reasoning and speed',
                  'Maximum reasoning depth',
                ],
                default: 'medium',
              },
            },
          }
        : undefined;

      return {
        id: m.id,
        name: m.name,
        family: m.family,
        version: '1.0.0',
        maxInputTokens: m.contextWindow - m.maxOutputTokens,
        maxOutputTokens: m.maxOutputTokens,
        capabilities: {
          imageInput: m.vision,
          vision: m.vision,
          toolCalling: true,
          thinking: supportsReasoning,
        },
        supportsReasoningEffort: supportsReasoning ? ['low', 'medium', 'high'] : undefined,
        supportedReasoningEfforts: supportsReasoning ? ['low', 'medium', 'high'] : undefined,
        defaultReasoningEffort: supportsReasoning ? 'medium' : undefined,
        configurationSchema: reasoningSchema,
        isBYOK: true,
      } as any;
    });
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
      getStoredOpenCodeKey() ||
      getKeyFromExistingConfig(this.context.globalStorageUri?.fsPath) ||
      getKeyFromExistingConfig();

    if (!apiKey) {
      throw new Error(
        'OpenCode API key not found. Please run "OpenCode: Set API Key" command to configure your key.'
      );
    }

    // Persist discovered key into SecretStorage for fast subsequent lookups
    this.context.secrets.get('opencode_api_key').then((stored) => {
      if (!stored && apiKey) {
        this.context.secrets.store('opencode_api_key', apiKey).then(undefined, () => {});
      }
    });

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

    // Free models and Zen-exclusive models route to zen/v1, flat-rate Go models route to zen/go/v1
    const isFreeOrZen =
      model.id.includes('free') ||
      model.id.includes('contributor') ||
      model.id.includes('community') ||
      model.id === 'big-pickle' ||
      (model as any).isFree === true;
    const url = isFreeOrZen
      ? 'https://opencode.ai/zen/v1/chat/completions'
      : 'https://opencode.ai/zen/go/v1/chat/completions';

    const reasoningEffort =
      (options as any)?.modelConfiguration?.reasoningEffort ||
      (options as any)?.configuration?.reasoningEffort;

    const requestBody: any = {
      model: model.id,
      messages: formattedMessages,
      tools: toolsPayload,
      stream: true,
    };
    if (reasoningEffort) {
      requestBody.reasoning_effort = reasoningEffort;
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'x-opencode-session': 'vscode-copilot',
      },
      body: JSON.stringify(requestBody),
      signal: abortController.signal,
    });

    if (!res.ok) {
      const errText = await res.text();
      let errorMsg = `OpenCode API error (${res.status} ${res.statusText}): ${errText}`;
      try {
        const parsed = JSON.parse(errText);
        if (parsed.error?.message) {
          errorMsg = `OpenCode [${model.name}]: ${parsed.error.message}`;
        }
      } catch {}
      throw new Error(errorMsg);
    }

    if (!res.body) {
      throw new Error('OpenCode API returned empty body');
    }

    // Parse streaming SSE response
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    // Track in-progress tool calls and reasoning stream
    const pendingToolCalls = new Map<number, { id: string; name: string; args: string }>();
    const thinkingId = `thinking-${Date.now()}`;
    let didEmitThinking = false;
    let finalizedThinking = false;
    let inThinkTag = false;

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

              // 1. Stream reasoning / thinking content from explicit reasoning fields
              const rawReasoning =
                choice.delta?.reasoning_content ||
                choice.delta?.thought ||
                choice.delta?.reasoning ||
                (Array.isArray(choice.delta?.reasoning_details)
                  ? choice.delta.reasoning_details.map((d: any) => d.text || '').join('')
                  : undefined);

              if (rawReasoning) {
                didEmitThinking = true;
                const ThinkingPart = (vscode as any).LanguageModelThinkingPart;
                if (ThinkingPart) {
                  progress.report(new ThinkingPart(rawReasoning, thinkingId));
                } else {
                  progress.report(new vscode.LanguageModelTextPart(rawReasoning));
                }
              }

              // 2. Stream delta text content and handle inline <think> tags
              let content = choice.delta?.content;
              if (content) {
                // If reasoning was previously emitted via reasoning_content and regular content starts,
                // finalize thinking so VS Code calculates the duration timer and closes the thinking block
                if (didEmitThinking && !finalizedThinking && !inThinkTag) {
                  finalizedThinking = true;
                  const ThinkingPart = (vscode as any).LanguageModelThinkingPart;
                  if (ThinkingPart) {
                    progress.report(new ThinkingPart('', thinkingId, { vscode_reasoning_done: true }));
                  }
                }

                if (inThinkTag) {
                  const closeIdx = content.indexOf('</think>');
                  if (closeIdx !== -1) {
                    const thinkText = content.slice(0, closeIdx);
                    content = content.slice(closeIdx + 8);
                    inThinkTag = false;
                    finalizedThinking = true;
                    if (thinkText) {
                      didEmitThinking = true;
                      const ThinkingPart = (vscode as any).LanguageModelThinkingPart;
                      if (ThinkingPart) {
                        progress.report(new ThinkingPart(thinkText, thinkingId));
                      } else {
                        progress.report(new vscode.LanguageModelTextPart(thinkText));
                      }
                    }
                    const ThinkingPart = (vscode as any).LanguageModelThinkingPart;
                    if (ThinkingPart) {
                      progress.report(new ThinkingPart('', thinkingId, { vscode_reasoning_done: true }));
                    }
                  } else {
                    didEmitThinking = true;
                    const ThinkingPart = (vscode as any).LanguageModelThinkingPart;
                    if (ThinkingPart) {
                      progress.report(new ThinkingPart(content, thinkingId));
                    } else {
                      progress.report(new vscode.LanguageModelTextPart(content));
                    }
                    content = '';
                  }
                } else if (content.includes('<think>')) {
                  const openIdx = content.indexOf('<think>');
                  const before = content.slice(0, openIdx);
                  if (before) {
                    progress.report(new vscode.LanguageModelTextPart(before));
                  }
                  const after = content.slice(openIdx + 7);
                  inThinkTag = true;
                  const closeIdx = after.indexOf('</think>');
                  if (closeIdx !== -1) {
                    const thinkText = after.slice(0, closeIdx);
                    content = after.slice(closeIdx + 8);
                    inThinkTag = false;
                    finalizedThinking = true;
                    if (thinkText) {
                      didEmitThinking = true;
                      const ThinkingPart = (vscode as any).LanguageModelThinkingPart;
                      if (ThinkingPart) {
                        progress.report(new ThinkingPart(thinkText, thinkingId));
                      } else {
                        progress.report(new vscode.LanguageModelTextPart(thinkText));
                      }
                    }
                    const ThinkingPart = (vscode as any).LanguageModelThinkingPart;
                    if (ThinkingPart) {
                      progress.report(new ThinkingPart('', thinkingId, { vscode_reasoning_done: true }));
                    }
                  } else {
                    didEmitThinking = true;
                    const ThinkingPart = (vscode as any).LanguageModelThinkingPart;
                    if (ThinkingPart) {
                      progress.report(new ThinkingPart(after, thinkingId));
                    } else {
                      progress.report(new vscode.LanguageModelTextPart(after));
                    }
                    content = '';
                  }
                }

                if (content) {
                  progress.report(new vscode.LanguageModelTextPart(content));
                }
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
      // Finalize thinking state if not already finalized
      if (didEmitThinking && !finalizedThinking) {
        finalizedThinking = true;
        const ThinkingPart = (vscode as any).LanguageModelThinkingPart;
        if (ThinkingPart) {
          progress.report(new ThinkingPart('', thinkingId, { vscode_reasoning_done: true }));
        }
      }

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
