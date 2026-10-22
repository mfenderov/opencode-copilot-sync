import * as vscode from 'vscode';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import type { LanguageModelV3, LanguageModelV3Prompt, LanguageModelV3StreamPart, LanguageModelV3FunctionTool, LanguageModelV3ToolResultPart } from '@ai-sdk/provider';
import type { CustomEndpointModel } from '../../models/domain/model.js';
import { extensionUserAgent } from '../../extension-version.js';
import { resolveApiKey } from './secret-store.js';
import { withProxy } from '../http/proxy-routing.js';
import { ConversationIdentity } from './conversation-identity.js';

export type RegisteredModel = CustomEndpointModel & vscode.LanguageModelChatInformation;
type AssistantContent = Extract<LanguageModelV3Prompt[number], { role: 'assistant' }>['content'];
const thinkingPart = (vscode as typeof vscode & {
  LanguageModelThinkingPart?: new (value: string, id: string) => vscode.LanguageModelResponsePart;
}).LanguageModelThinkingPart;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Leave headroom below OpenCode's 250-value and 15,000-character gateway limits.
const MAX_TOOL_ENUM_VALUES = 200;
const MAX_TOOL_ENUM_CHARS = 12000;
const SCHEMA_DATA_KEYS = new Set(['const', 'default', 'example', 'examples', 'description', 'title', '$comment']);
const NAMED_SCHEMA_MAP_KEYS = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']);

function exceedsEnumLimits(values: readonly unknown[]): boolean {
  if (values.length > MAX_TOOL_ENUM_VALUES) return true;
  let totalChars = 0;
  for (const value of values) {
    totalChars += String(value).length;
    if (totalChars > MAX_TOOL_ENUM_CHARS) return true;
  }
  return false;
}

function sanitizeToolSchema(
  schema: unknown,
  toolName: string
): LanguageModelV3FunctionTool['inputSchema'] {
  const droppedEnums: { path: string; count: number }[] = [];
  const inProgress = new Set<unknown>();

  function visit(node: unknown, path: string): unknown {
    if (Array.isArray(node)) {
      if (inProgress.has(node)) return node;
      inProgress.add(node);
      const sanitized = node.map((item, index) => visit(item, `${path}[${index}]`));
      inProgress.delete(node);
      return sanitized;
    }
    if (!record(node) || inProgress.has(node)) return node;
    inProgress.add(node);

    const sanitized: Record<string, unknown> = {};
    let droppedValues: readonly unknown[] | undefined;
    for (const [key, value] of Object.entries(node)) {
      if (key === 'enum') {
        if (Array.isArray(value) && exceedsEnumLimits(value)) {
          droppedEnums.push({ path, count: value.length });
          droppedValues = value;
        } else {
          sanitized[key] = value;
        }
        continue;
      }
      if (SCHEMA_DATA_KEYS.has(key)) {
        sanitized[key] = value;
        continue;
      }

      const childPath = `${path}.${key}`;
      if (NAMED_SCHEMA_MAP_KEYS.has(key) && record(value)) {
        if (inProgress.has(value)) {
          sanitized[key] = value;
          continue;
        }
        inProgress.add(value);
        const schemaMap: Record<string, unknown> = {};
        for (const [name, child] of Object.entries(value)) {
          schemaMap[name] = visit(child, `${childPath}.${name}`);
        }
        inProgress.delete(value);
        sanitized[key] = schemaMap;
      } else {
        sanitized[key] = visit(value, childPath);
      }
    }

    if (
      droppedValues &&
      !('type' in sanitized) &&
      !('$ref' in sanitized) &&
      droppedValues.length > 0 &&
      droppedValues.every((value) => typeof value === 'string')
    ) {
      sanitized.type = 'string';
    }

    inProgress.delete(node);
    return sanitized;
  }

  const sanitized = visit(schema, 'root');
  for (const dropped of droppedEnums) {
    console.warn(
      `[OpenCode] schema relaxed: dropped oversized enum on ${toolName}.${dropped.path} (${dropped.count} values)`
    );
  }
  return sanitized as LanguageModelV3FunctionTool['inputSchema'];
}

function toolResult(part: vscode.LanguageModelToolResultPart, names: Map<string, string>): LanguageModelV3ToolResultPart {
  const toolName = names.get(part.callId);
  if (!toolName) throw new Error(`No tool call found for result ${part.callId}`);
  const text = part.content.map((content: unknown) => {
    if (content instanceof vscode.LanguageModelTextPart) return content.value;
    if (content instanceof vscode.LanguageModelDataPart) return new TextDecoder().decode(content.data);
    throw new Error('Unsupported tool result content');
  }).join('\n');
  return { type: 'tool-result', toolCallId: part.callId, toolName, output: { type: 'text', value: text } };
}

function contentPart(part: unknown, names: Map<string, string>): AssistantContent[number] | undefined {
  if (part instanceof vscode.LanguageModelTextPart) return { type: 'text', text: part.value };
  if (part instanceof vscode.LanguageModelToolCallPart) {
    names.set(part.callId, part.name);
    return { type: 'tool-call', toolCallId: part.callId, toolName: part.name, input: part.input };
  }
  if (thinkingPart && part instanceof thinkingPart) return undefined;
  if (part instanceof vscode.LanguageModelDataPart) {
    if (part.mimeType.startsWith('image/')) return { type: 'file', data: part.data, mediaType: part.mimeType };
    throw new Error(`Unsupported message data: ${part.mimeType}`);
  }
  throw new Error('Unsupported language model message part');
}

export function toSDKPrompt(messages: readonly vscode.LanguageModelChatRequestMessage[]): LanguageModelV3Prompt {
  const prompt: LanguageModelV3Prompt = [];
  const names = new Map<string, string>();
  for (const message of messages) {
    const role: number = message.role;
    let content: AssistantContent = [];
    const flush = () => {
      if (!content.length) return;
      if (role === 2) {
        prompt.push({ role: 'assistant', content });
      } else if (role === 1) {
        const userContent = content.filter((part) => part.type === 'text' || part.type === 'file');
        if (userContent.length !== content.length) throw new Error('Tool calls must be in assistant messages');
        prompt.push({ role: 'user', content: userContent });
      } else {
        prompt.push({ role: 'system', content: content.map((part) => part.type === 'text' ? part.text : '').join('') });
      }
      content = [];
    };
    for (const part of message.content) {
      if (part instanceof vscode.LanguageModelToolResultPart) {
        flush();
        prompt.push({ role: 'tool', content: [toolResult(part, names)] });
      } else {
        const mapped = contentPart(part, names);
        if (mapped) content.push(mapped);
      }
    }
    flush();
  }
  return prompt;
}

function reportPart(part: LanguageModelV3StreamPart, progress: vscode.Progress<vscode.LanguageModelResponsePart>): void {
  switch (part.type) {
    case 'text-delta':
      progress.report(new vscode.LanguageModelTextPart(part.delta));
      break;
    case 'reasoning-delta':
      if (thinkingPart) progress.report(new thinkingPart(part.delta, part.id));
      break;
    case 'tool-call': {
      const input: unknown = JSON.parse(part.input);
      if (!record(input)) throw new Error(`Invalid tool arguments for ${part.toolName}`);
      progress.report(new vscode.LanguageModelToolCallPart(part.toolCallId, part.toolName, input));
      break;
    }
    case 'finish':
      progress.report(vscode.LanguageModelDataPart.json({
        prompt_tokens: part.usage.inputTokens.total,
        completion_tokens: part.usage.outputTokens.total,
        completion_tokens_details: { reasoning_tokens: part.usage.outputTokens.reasoning },
      }, 'usage'));
      break;
    case 'error':
      throw part.error instanceof Error ? part.error : new Error(String(part.error));
  }
}

function protocolModel(model: CustomEndpointModel, apiKey: string): LanguageModelV3 {
  const baseURL = model.url.replace(/\/(chat\/completions|responses|messages)\/?$/, '');
  const sdkFetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return fetch(input, await withProxy(url, { ...init }));
  };
  if (model.apiType === 'messages') return createAnthropic({ baseURL, authToken: apiKey, fetch: sdkFetch })(model.id);
  const openai = createOpenAI({ baseURL, apiKey, fetch: sdkFetch });
  return model.apiType === 'responses' ? openai.responses(model.id) : openai.chat(model.id);
}

export class OpenCodeChatAdapter implements vscode.LanguageModelChatProvider<RegisteredModel> {
  private models: RegisteredModel[] = [];
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this.changed.event;

  private readonly identities: ConversationIdentity;

  constructor(private readonly context: Pick<vscode.ExtensionContext, 'secrets'> & Partial<Pick<vscode.ExtensionContext, 'globalState'>>) {
    this.identities = new ConversationIdentity(context.globalState);
  }

  updateModels(models: CustomEndpointModel[]): void {
    this.models = models.map((model) => ({
      ...model, family: model.family ?? model.id, version: '1.0',
      capabilities: { toolCalling: model.toolCalling, imageInput: model.vision, thinking: model.thinking },
      configurationSchema: model.supportsReasoningEffort?.length ? {
        type: 'object', properties: {
          reasoningEffort: { type: 'string', title: 'Thinking Effort', enum: model.supportsReasoningEffort },
        },
      } : undefined,
    }));
    this.changed.fire();
  }

  provideLanguageModelChatInformation(): RegisteredModel[] {
    return this.models;
  }

  async provideLanguageModelChatResponse(
    selected: RegisteredModel,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): Promise<void> {
    const model = this.models.find((entry) => entry.id === selected.id);
    if (!model) throw new Error(`Model ${selected.id} is no longer in the synced catalog`);
    if (token.isCancellationRequested) return;
    const sessionId = await this.identities.resolve(messages, options.modelOptions?._conversationId);
    const apiKey = await resolveApiKey(this.context.secrets, false);
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Cancellation can change during the awaits above.
    if (token.isCancellationRequested) return;
    if (!apiKey) throw new Error('Configure the OpenCode API key before sending a request.');
    const controller = new AbortController();
    const subscription = token.onCancellationRequested(() => { controller.abort(); });
    try {
      const tools: LanguageModelV3FunctionTool[] | undefined = options.tools?.map((tool) => ({
        type: 'function', name: tool.name, description: tool.description,
        inputSchema: sanitizeToolSchema(
          tool.inputSchema ?? { type: 'object', properties: {} },
          tool.name
        ),
      }));
      const configuration = (options as { modelConfiguration?: Record<string, unknown> }).modelConfiguration;
      const effort: unknown = configuration?.reasoningEffort ?? options.modelOptions?.reasoningEffort;
      const { stream } = await protocolModel(model, apiKey).doStream({
        prompt: toSDKPrompt(messages), tools,
        toolChoice: { type: options.toolMode === vscode.LanguageModelChatToolMode.Required ? 'required' : 'auto' },
        maxOutputTokens: model.maxOutputTokens,
        headers: { 'x-opencode-session': sessionId, 'User-Agent': extensionUserAgent() },
        abortSignal: controller.signal,
        providerOptions: {
          openai: {
            store: false, strictJsonSchema: false, forceReasoning: model.thinking, systemMessageMode: 'system',
            ...(typeof effort === 'string' ? { reasoningEffort: effort } : {}),
          },
          anthropic: typeof effort === 'string' ? { effort } : {},
        },
      });
      for await (const part of stream) {
        if (controller.signal.aborted) return;
        reportPart(part, progress);
      }
    } finally {
      subscription.dispose();
    }
  }

  provideTokenCount(
    _model: RegisteredModel,
    input: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken
  ): Promise<number> {
    const text = typeof input === 'string' ? input : JSON.stringify(input);
    return Promise.resolve(Math.ceil(text.length / 4));
  }

  dispose(): void { this.changed.dispose(); }
}
