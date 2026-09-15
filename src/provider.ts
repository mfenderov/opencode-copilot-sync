import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { getStoredOpenCodeKey, getKeyFromExistingConfig } from './auth.js';

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
}

export const VERIFIED_OPENCODE_MODELS: OpenCodeModelMeta[] = [
  { id: 'minimax-m3', name: 'MiniMax M3 (OpenCode Go)', family: 'minimax-m3', catalog: 'go', contextWindow: 1048576, maxOutputTokens: 131072, vision: false, thinking: false },
  { id: 'minimax-m2.5', name: 'MiniMax M2.5 (OpenCode Go)', family: 'minimax-m2.5', catalog: 'go', contextWindow: 1048576, maxOutputTokens: 131072, vision: false, thinking: true },
  { id: 'kimi-k3', name: 'Kimi K3 (OpenCode Go)', family: 'kimi-k3', catalog: 'go', contextWindow: 1048576, maxOutputTokens: 65536, vision: true, thinking: true, supportsReasoningEffort: ['low', 'medium', 'high', 'max'] },
  { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code (OpenCode Go)', family: 'kimi-k2.7-code', catalog: 'go', contextWindow: 1048576, maxOutputTokens: 65536, vision: true, thinking: true, supportsReasoningEffort: ['low', 'medium', 'high', 'max'] },
  { id: 'kimi-k2.6', name: 'Kimi K2.6 (OpenCode Go)', family: 'kimi-k2.6', catalog: 'go', contextWindow: 1048576, maxOutputTokens: 65536, vision: true, thinking: true },
  { id: 'longcat-2.0', name: 'Longcat 2.0 (OpenCode Go)', family: 'longcat-2.0', catalog: 'go', contextWindow: 1048576, maxOutputTokens: 65536, vision: false, thinking: false },
  { id: 'glm-5.2', name: 'GLM 5.2 (OpenCode Go)', family: 'glm-5.2', catalog: 'go', contextWindow: 1048576, maxOutputTokens: 131072, vision: true, thinking: true, supportsReasoningEffort: ['high', 'max'] },
  { id: 'glm-5.3-flash', name: 'GLM 5.3 Flash (OpenCode Go)', family: 'glm-5.3-flash', catalog: 'go', contextWindow: 1048576, maxOutputTokens: 131072, vision: true, thinking: true, supportsReasoningEffort: ['low', 'high', 'max'] },
  { id: 'glm-5.3', name: 'GLM 5.3 (OpenCode Go)', family: 'glm-5.3', catalog: 'go', contextWindow: 1048576, maxOutputTokens: 131072, vision: true, thinking: true, supportsReasoningEffort: ['low', 'high', 'max'] },
  { id: 'glm-5.1', name: 'GLM 5.1 (OpenCode Go)', family: 'glm-5.1', catalog: 'go', contextWindow: 1048576, maxOutputTokens: 131072, vision: true, thinking: true },
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro (OpenCode Go)', family: 'deepseek-v4-pro', catalog: 'go', contextWindow: 1048576, maxOutputTokens: 131072, vision: false, thinking: true, supportsReasoningEffort: ['low', 'high', 'max'] },
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash (OpenCode Go)', family: 'deepseek-v4-flash', catalog: 'go', contextWindow: 1048576, maxOutputTokens: 131072, vision: false, thinking: true, supportsReasoningEffort: ['low', 'high', 'max'] },
  { id: 'deepseek-flash', name: 'DeepSeek Flash (OpenCode Go)', family: 'deepseek-flash', catalog: 'go', contextWindow: 1048576, maxOutputTokens: 131072, vision: false, thinking: true, supportsReasoningEffort: ['low', 'high', 'max'] },
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash (OpenCode Go)', family: 'deepseek-v4.1-flash', catalog: 'go', contextWindow: 1048576, maxOutputTokens: 131072, vision: false, thinking: true, supportsReasoningEffort: ['low', 'medium', 'high', 'max'] },
  { id: 'deepseek-v4-flash-vision-exp', name: 'DeepSeek V4 Flash Vision Exp (OpenCode Go)', family: 'deepseek-v4-flash-vision-exp', catalog: 'go', contextWindow: 1048576, maxOutputTokens: 131072, vision: true, thinking: true, supportsReasoningEffort: ['low', 'high', 'max'] },
  { id: 'qwen3.7-max', name: 'Qwen3.7 Max (OpenCode Go)', family: 'qwen3.7-max', catalog: 'go', contextWindow: 1000000, maxOutputTokens: 131072, vision: true, thinking: false },
  { id: 'qwen3.8-max', name: 'Qwen3.8 Max (OpenCode Go)', family: 'qwen3.8-max', catalog: 'go', contextWindow: 1000000, maxOutputTokens: 131072, vision: true, thinking: false },
  { id: 'qwen3.8-flash', name: 'Qwen3.8 Flash (OpenCode Go)', family: 'qwen3.8-flash', catalog: 'go', contextWindow: 1000000, maxOutputTokens: 131072, vision: true, thinking: false },
  { id: 'qwen3.6-plus', name: 'Qwen3.6 Plus (OpenCode Go)', family: 'qwen3.6-plus', catalog: 'go', contextWindow: 1000000, maxOutputTokens: 131072, vision: true, thinking: false },
  { id: 'mimo-v2.5-pro', name: 'MiMo V2.5 Pro (OpenCode Go)', family: 'mimo-v2.5-pro', catalog: 'go', contextWindow: 1048576, maxOutputTokens: 65536, vision: false, thinking: true, supportsReasoningEffort: ['low', 'medium', 'high'] },
  { id: 'mimo-v2.5', name: 'MiMo V2.5 (OpenCode Go)', family: 'mimo-v2.5', catalog: 'go', contextWindow: 1048576, maxOutputTokens: 65536, vision: false, thinking: true, supportsReasoningEffort: ['low', 'medium', 'high'] },
  { id: 'hy4-preview', name: 'Hy4 Preview (OpenCode Go)', family: 'hy4-preview', catalog: 'go', contextWindow: 1048576, maxOutputTokens: 65536, vision: false, thinking: true },
  { id: 'hy3', name: 'Hy3 (OpenCode Go)', family: 'hy3', catalog: 'go', contextWindow: 1048576, maxOutputTokens: 65536, vision: false, thinking: false },
  { id: 'omen-alpha', name: 'Omen Alpha (OpenCode Go)', family: 'omen-alpha', catalog: 'go', contextWindow: 1048576, maxOutputTokens: 65536, vision: false, thinking: true },
  // Verified OpenCode Free models (always available and visible)
  { id: 'big-pickle', name: 'Big Pickle (OpenCode Free)', family: 'big-pickle', catalog: 'zen', isFree: true, contextWindow: 1048576, maxOutputTokens: 65536, vision: false, thinking: false },
  { id: 'mimo-v2.5-free', name: 'MiMo V2.5 (OpenCode Free)', family: 'mimo-v2.5-free', catalog: 'zen', isFree: true, contextWindow: 1048576, maxOutputTokens: 65536, vision: false, thinking: true, supportsReasoningEffort: ['low', 'medium', 'high'] },
  { id: 'ling-3.0-flash-fin-free', name: 'Ling 3.0 Flash Fin (OpenCode Free)', family: 'ling-3.0-flash-fin-free', catalog: 'zen', isFree: true, contextWindow: 1048576, maxOutputTokens: 65536, vision: false, thinking: false },
  { id: 'nemotron-3-ultra-free', name: 'Nemotron 3 Ultra (OpenCode Free)', family: 'nemotron-3-ultra-free', catalog: 'zen', isFree: true, contextWindow: 1000000, maxOutputTokens: 128000, vision: false, thinking: true, supportsReasoningEffort: ['low', 'medium', 'high'] },
  { id: 'nemotron-3.5-lightning-free', name: 'Nemotron 3.5 Lightning (OpenCode Free)', family: 'nemotron-3.5-lightning-free', catalog: 'zen', isFree: true, contextWindow: 1000000, maxOutputTokens: 128000, vision: false, thinking: true, supportsReasoningEffort: ['low', 'medium', 'high'] },
  { id: 'deepseek-v4-flash-free', name: 'DeepSeek V4 Flash (OpenCode Free)', family: 'deepseek-v4-flash-free', catalog: 'zen', isFree: true, contextWindow: 1048576, maxOutputTokens: 131072, vision: false, thinking: true, supportsReasoningEffort: ['low', 'high', 'max'] },
  { id: 'muse-spark-1.3', name: 'Muse Spark 1.3 (OpenCode Zen)', family: 'muse-spark-1.3', catalog: 'zen', contextWindow: 1048576, maxOutputTokens: 65536, vision: true, thinking: true, supportsReasoningEffort: ['minimal', 'low', 'medium', 'high', 'xhigh'] },
  { id: 'muse-spark-1.3-contributor', name: 'Muse Spark 1.3 Contributor (OpenCode Go)', family: 'muse-spark-1.3-contributor', catalog: 'go', contextWindow: 1048576, maxOutputTokens: 65536, vision: true, thinking: true, supportsReasoningEffort: ['minimal', 'low', 'medium', 'high', 'xhigh'] },
  { id: 'muse-spark-1.3-contributor-free', name: 'Muse Spark 1.3 Contributor (OpenCode Free)', family: 'muse-spark-1.3-contributor-free', catalog: 'zen', isFree: true, contextWindow: 1048576, maxOutputTokens: 65536, vision: true, thinking: true, supportsReasoningEffort: ['minimal', 'low', 'medium', 'high', 'xhigh'] },
  { id: 'muse-spark-1.2-contributor-free', name: 'Muse Spark 1.2 Contributor (OpenCode Free)', family: 'muse-spark-1.2-contributor-free', catalog: 'zen', isFree: true, contextWindow: 1048576, maxOutputTokens: 65536, vision: true, thinking: true, supportsReasoningEffort: ['minimal', 'low', 'medium', 'high', 'xhigh'] },
];

export function isResponsesModel(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  return lower.includes('muse') || lower.includes('gpt-') || lower.includes('grok-');
}

export function normalizeReasoningEffort(
  effort: string | undefined,
  isResponses: boolean
): Record<string, any> {
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

  return isResponses ? { reasoning: { effort: mappedEffort } } : { reasoning_effort: mappedEffort };
}

export class OpenCodeChatProvider implements vscode.LanguageModelChatProvider {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this._onDidChange.event;
  private _models: OpenCodeModelMeta[] = [...VERIFIED_OPENCODE_MODELS];

  constructor(private readonly context: vscode.ExtensionContext) {
    try {
      if (this.context.globalStorageUri?.fsPath) {
        const cacheFile = path.join(this.context.globalStorageUri.fsPath, 'models_cache.json');
        if (fs.existsSync(cacheFile)) {
          const parsed = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
          if (Array.isArray(parsed) && parsed.length > 0) {
            this._models = parsed;
          }
        }
      }
    } catch {}
  }

  refresh(): void {
    this._onDidChange.fire();
  }

  updateModels(models: OpenCodeModelMeta[]): void {
    if (Array.isArray(models) && models.length > 0) {
      this._models = models;
      this.refresh();
      try {
        if (this.context.globalStorageUri?.fsPath) {
          const cacheDir = this.context.globalStorageUri.fsPath;
          if (!fs.existsSync(cacheDir)) {
            fs.mkdirSync(cacheDir, { recursive: true });
          }
          fs.writeFileSync(path.join(cacheDir, 'models_cache.json'), JSON.stringify(models), 'utf-8');
        }
      } catch {}
    }
  }

  async provideLanguageModelChatInformation(
    _options: vscode.PrepareLanguageModelChatModelOptions,
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelChatInformation[]> {
    return this._models.map((m) => {
      const supportsReasoning = m.thinking !== false;
      const properties: Record<string, any> = {};

      // Dynamic reasoning effort options based on actual model metadata
      const rawEfforts = m.supportsReasoningEffort;
      const validEfforts = supportsReasoning && Array.isArray(rawEfforts) && rawEfforts.length > 0
        ? rawEfforts.filter((e) => e !== 'none')
        : undefined;

      if (supportsReasoning && validEfforts && validEfforts.length > 0) {
        const enumItemLabels = validEfforts.map((e) => {
          if (e === 'minimal') return 'Minimal';
          if (e === 'low') return 'Low';
          if (e === 'medium') return 'Medium';
          if (e === 'high') return 'High';
          if (e === 'xhigh') return 'Extra High';
          if (e === 'max') return 'Max';
          return e.charAt(0).toUpperCase() + e.slice(1);
        });

        const enumDescriptions = validEfforts.map((e) => {
          if (e === 'minimal') return 'Minimal reasoning';
          if (e === 'low') return 'Faster responses with light reasoning';
          if (e === 'medium') return 'Balanced reasoning and speed';
          if (e === 'high') return 'Deep reasoning';
          if (e === 'xhigh') return 'Extra deep reasoning';
          if (e === 'max') return 'Maximum reasoning depth';
          return `${e} reasoning`;
        });

        properties.reasoningEffort = {
          type: 'string',
          title: 'Thinking Effort',
          enum: validEfforts,
          enumItemLabels,
          enumDescriptions,
          default: validEfforts.includes('medium') ? 'medium' : validEfforts[0],
          group: 'navigation',
        };
      }

      if (m.contextWindow > 256000) {
        properties.contextTier = {
          type: 'string',
          title: 'Context Size',
          enum: ['default', 'long_context'],
          enumItemLabels: ['Standard (128K)', 'Extended (1M)'],
          enumDescriptions: [
            'Standard context window for faster generation and lower token usage',
            'Full extended context window for large codebase analysis',
          ],
          default: 'default',
          group: 'tokens',
        };
      }

      const configurationSchema = Object.keys(properties).length > 0 ? { properties } : undefined;

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
        supportsReasoningEffort: validEfforts,
        supportedReasoningEfforts: validEfforts,
        defaultReasoningEffort: validEfforts ? (validEfforts.includes('medium') ? 'medium' : validEfforts[0]) : undefined,
        configurationSchema,
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

    const lowerId = model.id.toLowerCase();
    const isResponses = isResponsesModel(model.id);

    // Format tool definitions appropriately for the target endpoint protocol
    let toolsPayload: any[] | undefined = undefined;
    if (options.tools && options.tools.length > 0) {
      if (isResponses) {
        // OpenAI Responses API (Muse, GPT, Grok) requires flat tool schema:
        // { type: "function", name: "...", description: "...", parameters: { ... } }
        toolsPayload = options.tools.map((t) => ({
          type: 'function',
          name: t.name.length > 64 ? t.name.slice(0, 64) : t.name,
          description: t.description,
          parameters: t.inputSchema || { type: 'object', properties: {} },
        }));
      } else {
        // OpenAI Chat Completions API requires nested function schema:
        // { type: "function", function: { name: "...", description: "...", parameters: { ... } } }
        toolsPayload = options.tools.map((t) => ({
          type: 'function',
          function: {
            name: t.name,
            description: t.description,
            parameters: t.inputSchema || { type: 'object', properties: {} },
          },
        }));
      }
    }

    let responsesInput: any[] = [];
    if (isResponses) {
      for (const msg of formattedMessages) {
        if (msg.role === 'user') {
          responsesInput.push({ role: 'user', content: msg.content });
        } else if (msg.role === 'assistant') {
          if (msg.content) {
            responsesInput.push({ role: 'assistant', content: [{ type: 'output_text', text: msg.content }] });
          }
          if (msg.tool_calls) {
            for (const tc of msg.tool_calls) {
              responsesInput.push({
                type: 'function_call',
                id: tc.id?.startsWith('fc_') ? tc.id : `fc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                call_id: tc.id,
                name: tc.function?.name || '',
                arguments: tc.function?.arguments || '',
              });
            }
          }
        } else if (msg.role === 'tool') {
          responsesInput.push({
            type: 'function_call_output',
            call_id: msg.tool_call_id,
            output: msg.content,
          });
        }
      }
    }

    const abortController = new AbortController();
    token.onCancellationRequested(() => abortController.abort());

    // Free models and Zen-exclusive models route to zen/v1, flat-rate Go models route to zen/go/v1
    const meta = this._models.find((m) => m.id === model.id);
    const isFreeOrZen =
      meta?.catalog === 'zen' ||
      meta?.isFree === true ||
      model.id.includes('free') ||
      model.id.includes('contributor') ||
      model.id.includes('community') ||
      model.id === 'big-pickle' ||
      (model as any).isFree === true;

    const baseUrl = isFreeOrZen
      ? 'https://opencode.ai/zen/v1'
      : 'https://opencode.ai/zen/go/v1';
    const url = isResponses ? `${baseUrl}/responses` : `${baseUrl}/chat/completions`;

    const reasoningEffort =
      (options as any)?.modelConfiguration?.reasoningEffort ||
      (options as any)?.configuration?.reasoningEffort ||
      (options as any)?.reasoningEffort;

    const reasoningPayload = normalizeReasoningEffort(reasoningEffort, isResponses);

    const requestBody: any = isResponses
      ? {
          model: model.id,
          input: responsesInput.length > 0 ? responsesInput : formattedMessages,
          tools: toolsPayload,
          stream: true,
          ...reasoningPayload,
        }
      : {
          model: model.id,
          messages: formattedMessages,
          tools: toolsPayload,
          stream: true,
          ...reasoningPayload,
        };

    const sessionId = `ses_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'User-Agent': 'opencode/1.18.30',
          'x-opencode-session': sessionId,
        },
        body: JSON.stringify(requestBody),
        signal: abortController.signal,
      });
    } catch (err: any) {
      if (token.isCancellationRequested || abortController.signal.aborted) {
        return;
      }
      throw err;
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      let userDetail = errText;
      try {
        const parsed = JSON.parse(errText);
        if (parsed.error?.message) {
          userDetail = parsed.error.message;
        }
      } catch {}

      // 1. Auth errors: throw NoPermissions to let VS Code trigger re-auth prompts if configured
      if (res.status === 401 || res.status === 403) {
        const LMError = (vscode as any).LanguageModelError;
        if (LMError?.NoPermissions) {
          throw LMError.NoPermissions('OpenCode authentication failed: Invalid or expired API key.');
        }
        throw new Error('OpenCode authentication failed: Invalid or expired API key.');
      }

      // 2. Model not found: throw NotFound
      if (res.status === 404) {
        const LMError = (vscode as any).LanguageModelError;
        if (LMError?.NotFound) {
          throw LMError.NotFound(`OpenCode model '${model.id}' was not found in the remote catalog.`);
        }
        throw new Error(`OpenCode model '${model.id}' was not found in the remote catalog.`);
      }

      // 3. Upstream Server Errors (500, 502 Bad Gateway, 503, 504) or rate limits
      // Instead of throwing an Error (which causes Copilot's runtime to retry 5 times for 32.4 seconds),
      // stream an informative Markdown alert card to the user and resolve cleanly (return void).
      const alertNotice = [
        `> ⚠️ **OpenCode Model Alert (${res.status} ${res.statusText || 'Service Error'})**`,
        `>`,
        `> Unable to reach **${model.name}** (\`${model.id}\`): upstream server error.`,
        `>`,
        `> **Upstream detail:** \`${userDetail.slice(0, 300) || 'Internal server error'}\``,
        `>`,
        `> **Suggestions:**`,
        `> - If using an experimental/free tier model, try switching to active models like \`mimo-v2.5-free\` or \`big-pickle\`.`,
        `> - For maximum reliability, use flat-rate OpenCode Go models (e.g. \`deepseek-v4-pro\`, \`qwen3.7-max\`, \`kimi-k3\`).`,
        `> - Retry your request in a few moments if this is a temporary provider outage.`,
      ].join('\n');

      progress.report(new vscode.LanguageModelTextPart(alertNotice));
      return; // Clean resolution bypasses Copilot's 5-retry 32-second loop!
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
    let inThinkTag = false;

    try {
      while (true) {
        if (token.isCancellationRequested) break;
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        let isDone = false;
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(':')) continue;
          if (trimmed === 'data: [DONE]') {
            isDone = true;
            break;
          }

          if (trimmed.startsWith('data: ')) {
            try {
              const data = JSON.parse(trimmed.slice(6));

              // 1. Handle OpenAI Responses API stream format (used by Muse, GPT, Grok)
              if (data.type === 'response.completed') {
                isDone = true;
                break;
              }

              if (data.type === 'response.output_text.delta') {
                const delta = typeof data.delta === 'string' ? data.delta : data.delta?.text || data.delta?.value || '';
                if (delta) {
                  progress.report(new vscode.LanguageModelTextPart(delta));
                }
                continue;
              }

              if (data.type === 'response.output_item.added' && data.item?.type === 'function_call') {
                const idx = typeof data.output_index === 'number' ? data.output_index : 0;
                pendingToolCalls.set(idx, {
                  id: data.item.call_id || data.item.id || `call_${Date.now()}`,
                  name: data.item.name || '',
                  args: data.item.arguments || '',
                });
                continue;
              }

              if (data.type === 'response.function_call_arguments.delta') {
                const idx = typeof data.output_index === 'number' ? data.output_index : 0;
                const current = pendingToolCalls.get(idx) || { id: '', name: '', args: '' };
                const delta = typeof data.delta === 'string' ? data.delta : data.delta?.arguments || '';
                current.args += delta;
                pendingToolCalls.set(idx, current);
                continue;
              }

              if (data.type === 'response.output_item.done' && data.item?.type === 'function_call') {
                const idx = typeof data.output_index === 'number' ? data.output_index : 0;
                const call = pendingToolCalls.get(idx);
                if (call) {
                  let parsedArgs: any = {};
                  try {
                    parsedArgs = JSON.parse(call.args);
                  } catch {
                    parsedArgs = { raw: call.args };
                  }
                  progress.report(new vscode.LanguageModelToolCallPart(call.id, call.name, parsedArgs));
                  pendingToolCalls.delete(idx);
                }
                continue;
              }

              // 2. Handle OpenAI Chat Completions API stream format (used by DeepSeek, Kimi, GLM, MiMo, Qwen)
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

              if (rawReasoning && rawReasoning.length > 0) {
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
                if (inThinkTag) {
                  const closeIdx = content.indexOf('</think>');
                  if (closeIdx !== -1) {
                    const thinkText = content.slice(0, closeIdx);
                    content = content.slice(closeIdx + 8);
                    inThinkTag = false;
                    if (thinkText) {
                      didEmitThinking = true;
                      const ThinkingPart = (vscode as any).LanguageModelThinkingPart;
                      if (ThinkingPart) {
                        progress.report(new ThinkingPart(thinkText, thinkingId));
                      } else {
                        progress.report(new vscode.LanguageModelTextPart(thinkText));
                      }
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
                    if (thinkText) {
                      didEmitThinking = true;
                      const ThinkingPart = (vscode as any).LanguageModelThinkingPart;
                      if (ThinkingPart) {
                        progress.report(new ThinkingPart(thinkText, thinkingId));
                      } else {
                        progress.report(new vscode.LanguageModelTextPart(thinkText));
                      }
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

              if (choice.finish_reason === 'stop') {
                isDone = true;
                break;
              }
            } catch {}
          }
        }
        if (isDone) break;
      }
    } catch (streamErr: any) {
      if (token.isCancellationRequested) {
        return;
      }
      progress.report(
        new vscode.LanguageModelTextPart(
          `\n\n*(Response stream interrupted: ${streamErr?.message || 'Connection closed by upstream OpenCode service'})*`
        )
      );
      return;
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
