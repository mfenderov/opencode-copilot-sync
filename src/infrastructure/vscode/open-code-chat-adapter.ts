import * as vscode from 'vscode';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import type { LanguageModelV3, LanguageModelV3Prompt, LanguageModelV3StreamPart, LanguageModelV3FunctionTool, LanguageModelV3ToolResultPart } from '@ai-sdk/provider';
import type { CustomEndpointModel } from '../../models/domain/model.js';
import { extensionUserAgent } from '../../extension-version.js';
import { resolveApiKey } from './secret-store.js';
import { withProxy } from '../http/proxy-routing.js';
import {
  createStreamTimeoutFetch,
  OPEN_CODE_CHUNK_TIMEOUT_MS,
  OPEN_CODE_HEADER_TIMEOUT_MS,
  StreamTimeoutError,
  type StreamTimeoutOptions,
} from '../http/stream-timeout-fetch.js';
import { ConversationIdentity } from './conversation-identity.js';

export type RegisteredModel = CustomEndpointModel & vscode.LanguageModelChatInformation;
type AssistantContent = Extract<LanguageModelV3Prompt[number], { role: 'assistant' }>['content'];

export interface ChatStreamPolicy extends StreamTimeoutOptions {
  retryDelayMs(retryNumber: number): number;
}

const MAX_STREAM_RETRIES = 3;
const CONTINUATION_INSTRUCTION = 'The previous response was interrupted. Continue from where you left off without repeating completed content.';
const STREAM_INTERRUPTION_NOTICE = '\n\nOpenCode: The response was interrupted after repeated stream timeouts.';

const defaultChatStreamPolicy: ChatStreamPolicy = {
  headerTimeoutMs: OPEN_CODE_HEADER_TIMEOUT_MS,
  chunkTimeoutMs: OPEN_CODE_CHUNK_TIMEOUT_MS,
  retryDelayMs(retryNumber) {
    const backoff = Math.min(2_000 * 2 ** (retryNumber - 1), 10_000);
    return backoff + Math.random() * Math.min(100, 10_000 - backoff);
  },
};
const thinkingPart = (vscode as typeof vscode & {
  LanguageModelThinkingPart?: new (value: string, id: string) => vscode.LanguageModelResponsePart;
}).LanguageModelThinkingPart;
const CHARS_PER_TOKEN_BY_FAMILY: readonly (readonly [RegExp, number])[] = [
  [/^(gpt-|o1|o3|o4)/i, 4],
  [/^claude/i, 3.7],
  [/^(muse|gemini)/i, 4],
  [/^(grok|deepseek|qwen|llama|mi(mo|x)|kimi|glm)/i, 3.4],
];

function charsPerToken(modelId: string): number {
  return CHARS_PER_TOKEN_BY_FAMILY.find(([pattern]) => pattern.test(modelId))?.[1] ?? 3.6;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStreamTimeout(error: unknown): boolean {
  const visited = new Set<unknown>();
  while (record(error) && !visited.has(error)) {
    if (error instanceof StreamTimeoutError) return true;
    visited.add(error);
    error = error.cause;
  }
  return error instanceof StreamTimeoutError;
}

function isRawCompletion(rawValue: unknown): boolean {
  if (!record(rawValue)) return false;
  if (rawValue.type === 'response.completed' || rawValue.type === 'response.incomplete') return true;
  return Array.isArray(rawValue.choices) && rawValue.choices.some((choice) =>
    record(choice) && choice.finish_reason !== null && choice.finish_reason !== undefined
  );
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

function completedResponseText(rawValue: unknown): string | undefined {
  if (
    !record(rawValue) ||
    (rawValue.type !== 'response.completed' && rawValue.type !== 'response.incomplete') ||
    !record(rawValue.response) ||
    !Array.isArray(rawValue.response.output)
  ) {
    return undefined;
  }

  const text: string[] = [];
  for (const item of rawValue.response.output) {
    if (!record(item) || item.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (record(part) && part.type === 'output_text' && typeof part.text === 'string') {
        text.push(part.text);
      }
    }
  }
  return text.length > 0 ? text.join('') : undefined;
}

function legacyReasoningDelta(rawValue: unknown): { id: string; delta: string } | undefined {
  if (
    !record(rawValue) ||
    rawValue.type !== 'response.reasoning_text.delta' ||
    typeof rawValue.item_id !== 'string' ||
    typeof rawValue.delta !== 'string' ||
    rawValue.delta.length === 0
  ) {
    return undefined;
  }
  return { id: rawValue.item_id, delta: rawValue.delta };
}

function chatReasoningDelta(rawValue: unknown): { id: string; delta: string } | undefined {
  // OpenAI-compatible gateways (DeepSeek, Kimi, GLM, MiMo) stream reasoning
  // inside Chat Completions deltas as reasoning_content / thought /
  // reasoning / reasoning_details[].text. The AI SDK chat parser only
  // forwards content/tool_calls/annotations, so these arrive solely via raw
  // chunks and must be mapped here to keep thinking visible.
  if (!record(rawValue) || !Array.isArray(rawValue.choices)) return undefined;
  const deltas: string[] = [];
  for (const choice of rawValue.choices) {
    if (!record(choice) || !record(choice.delta)) continue;
    const delta: Record<string, unknown> = choice.delta;
    for (const key of ['reasoning_content', 'thought', 'reasoning'] as const) {
      const direct = delta[key];
      if (typeof direct === 'string' && direct.length > 0) deltas.push(direct);
    }
    if (Array.isArray(delta.reasoning_details)) {
      for (const detail of delta.reasoning_details) {
        if (record(detail) && typeof detail.text === 'string' && detail.text.length > 0) {
          deltas.push(detail.text);
        }
      }
    }
  }
  if (deltas.length === 0) return undefined;
  const id = typeof rawValue.id === 'string' ? rawValue.id : 'chat-reasoning';
  return { id, delta: deltas.join('') };
}

function reportThinkingDelta(
  delta: string,
  id: string,
  progress: vscode.Progress<vscode.LanguageModelResponsePart>
): void {
  if (thinkingPart) progress.report(new thinkingPart(delta, id));
  else if (delta) progress.report(new vscode.LanguageModelTextPart(delta));
}

interface StreamDiagnostics {
  log: (message: string) => void;
  startAt: number;
  firstPartAt: number | undefined;
  lastPartAt: number | undefined;
  textDeltas: number;
  reasoningDeltas: number;
  toolCalls: number;
  finishSeen: boolean;
  finishUnified: string | undefined;
  finishRaw: string | undefined;
  lastRawType: string | undefined;
  rawChunks: number;
}

interface StreamReportState {
  textEmitted: boolean;
  diagnostics?: StreamDiagnostics;
  onToolCall?(part: Extract<LanguageModelV3StreamPart, { type: 'tool-call' }>): void;
}

function createStreamDiagnostics(
  log: ((message: string) => void) | undefined,
  request: { modelId: string; apiType: string; sessionId: string; maxOutputTokens?: number; toolCount: number }
): StreamDiagnostics | undefined {
  // Per-request stream summaries for troubleshooting early terminations.
  // Only runs when the host wires a log sink (opencode.streamDiagnostics);
  // message text, reasoning content, tool arguments, and credentials are never logged.
  if (!log) return undefined;
  log(
    `[Stream] request model=${request.modelId} protocol=${request.apiType} ` +
    `session=${request.sessionId} maxOutputTokens=${request.maxOutputTokens ?? 'unknown'} ` +
    `tools=${request.toolCount}`
  );
  return {
    log,
    startAt: Date.now(),
    firstPartAt: undefined,
    lastPartAt: undefined,
    textDeltas: 0,
    reasoningDeltas: 0,
    toolCalls: 0,
    finishSeen: false,
    finishUnified: undefined,
    finishRaw: undefined,
    lastRawType: undefined,
    rawChunks: 0,
  };
}

function noteStreamPart(
  diagnostics: StreamDiagnostics | undefined,
  kind: 'text' | 'reasoning' | 'tool-call' | 'finish' | 'raw',
  part?: { finishReason?: { unified: string; raw?: unknown }; rawValue?: unknown }
): void {
  if (!diagnostics) return;
  const now = Date.now();
  diagnostics.firstPartAt ??= now;
  diagnostics.lastPartAt = now;
  switch (kind) {
    case 'text': diagnostics.textDeltas += 1; break;
    case 'reasoning': diagnostics.reasoningDeltas += 1; break;
    case 'tool-call': diagnostics.toolCalls += 1; break;
    case 'finish':
      diagnostics.finishSeen = true;
      diagnostics.finishUnified = part?.finishReason?.unified;
      diagnostics.finishRaw = typeof part?.finishReason?.raw === 'string' ? part.finishReason.raw : undefined;
      break;
    case 'raw': {
      diagnostics.rawChunks += 1;
      const rawValue = part?.rawValue;
      const rawType = record(rawValue) && typeof rawValue.type === 'string' ? rawValue.type : undefined;
      if (rawType) diagnostics.lastRawType = rawType;
      break;
    }
  }
}

function summarizeStream(
  diagnostics: StreamDiagnostics,
  outcome: 'completed' | 'aborted' | 'errored'
): void {
  const elapsedMs = Date.now() - diagnostics.startAt;
  const firstPartMs = diagnostics.firstPartAt === undefined ? 'none' : `${diagnostics.firstPartAt - diagnostics.startAt}ms`;
  const lastGapMs = diagnostics.lastPartAt === undefined ? 'none' : `${Date.now() - diagnostics.lastPartAt}ms`;
  diagnostics.log(
    `[Stream] ${outcome} elapsedMs=${elapsedMs} firstPart=${firstPartMs} lastPartGap=${lastGapMs} ` +
    `text=${diagnostics.textDeltas} reasoning=${diagnostics.reasoningDeltas} toolCalls=${diagnostics.toolCalls} ` +
    `rawChunks=${diagnostics.rawChunks} lastRawType=${diagnostics.lastRawType ?? 'none'} ` +
    `finishSeen=${diagnostics.finishSeen} finish=${diagnostics.finishUnified ?? 'none'}` +
    (diagnostics.finishRaw ? ` rawFinish=${diagnostics.finishRaw}` : '')
  );
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

function waitForRetry(delayMs: number, token: vscode.CancellationToken): Promise<boolean> {
  if (token.isCancellationRequested) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      subscription.dispose();
      resolve(false);
    }, delayMs);
    const subscription = token.onCancellationRequested(() => {
      clearTimeout(timeout);
      subscription.dispose();
      resolve(true);
    });
  });
}

function reportToolCalls(
  parts: readonly Extract<LanguageModelV3StreamPart, { type: 'tool-call' }>[],
  progress: vscode.Progress<vscode.LanguageModelResponsePart>
): void {
  for (const part of parts) {
    const input: unknown = JSON.parse(part.input);
    if (!record(input)) throw new Error(`Invalid tool arguments for ${part.toolName}`);
    progress.report(new vscode.LanguageModelToolCallPart(part.toolCallId, part.toolName, input));
  }
}

function reportPart(
  part: LanguageModelV3StreamPart,
  progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  state: StreamReportState
): void {
  switch (part.type) {
    case 'text-delta':
      if (part.delta) state.textEmitted = true;
      noteStreamPart(state.diagnostics, 'text');
      progress.report(new vscode.LanguageModelTextPart(part.delta));
      break;
    case 'reasoning-delta':
      noteStreamPart(state.diagnostics, 'reasoning');
      reportThinkingDelta(part.delta, part.id, progress);
      break;
    case 'tool-call': {
      noteStreamPart(state.diagnostics, 'tool-call');
      if (state.onToolCall) {
        state.onToolCall(part);
        break;
      }
      const input: unknown = JSON.parse(part.input);
      if (!record(input)) throw new Error(`Invalid tool arguments for ${part.toolName}`);
      progress.report(new vscode.LanguageModelToolCallPart(part.toolCallId, part.toolName, input));
      break;
    }
    case 'raw': {
      noteStreamPart(state.diagnostics, 'raw', part);
      const reasoning = legacyReasoningDelta(part.rawValue) ?? chatReasoningDelta(part.rawValue);
      if (reasoning) reportThinkingDelta(reasoning.delta, reasoning.id, progress);
      const fallback = completedResponseText(part.rawValue);
      if (!state.textEmitted && fallback) {
        state.textEmitted = true;
        progress.report(new vscode.LanguageModelTextPart(fallback));
      }
      break;
    }
    case 'finish':
      noteStreamPart(state.diagnostics, 'finish', part);
      if (part.finishReason.unified === 'length') {
        progress.report(new vscode.LanguageModelTextPart(
          '\n\nOpenCode: Response may be incomplete because the model reached its output token limit.'
        ));
      } else if (part.finishReason.unified === 'content-filter') {
        progress.report(new vscode.LanguageModelTextPart(
          "\n\nOpenCode: The response was stopped by the model provider's content filter."
        ));
      } else if (part.finishReason.unified === 'other') {
        const detail = part.finishReason.raw === undefined
          ? 'the stream ended without a completion event'
          : 'the provider returned an unrecognized completion reason';
        progress.report(new vscode.LanguageModelTextPart(
          `\n\nOpenCode: Response may be incomplete because ${detail}.`
        ));
      } else if (part.finishReason.unified === 'error') {
        progress.report(new vscode.LanguageModelTextPart(
          '\n\nOpenCode: The model provider reported an error while finishing the response.'
        ));
      }
      progress.report(vscode.LanguageModelDataPart.json({
        prompt_tokens: part.usage.inputTokens.total,
        completion_tokens: part.usage.outputTokens.total,
        completion_tokens_details: { reasoning_tokens: part.usage.outputTokens.reasoning },
      }, 'usage'));
      break;
    case 'error':
      if (state.diagnostics) summarizeStream(state.diagnostics, 'errored');
      throw part.error instanceof Error ? part.error : new Error(String(part.error));
  }
}

function protocolModel(model: CustomEndpointModel, apiKey: string, streamPolicy: StreamTimeoutOptions): LanguageModelV3 {
  const baseURL = model.url.replace(/\/(chat\/completions|responses|messages)\/?$/, '');
  const proxyFetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return fetch(input, await withProxy(url, { ...init }));
  };
  const sdkFetch = createStreamTimeoutFetch(proxyFetch, streamPolicy);
  if (model.apiType === 'messages') return createAnthropic({ baseURL, authToken: apiKey, fetch: sdkFetch })(model.id);
  const openai = createOpenAI({ baseURL, apiKey, fetch: sdkFetch });
  return model.apiType === 'responses' ? openai.responses(model.id) : openai.chat(model.id);
}

export class OpenCodeChatAdapter implements vscode.LanguageModelChatProvider<RegisteredModel> {
  private models: RegisteredModel[] = [];
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this.changed.event;

  private readonly identities: ConversationIdentity;
  private readonly streamPolicy: ChatStreamPolicy;

  constructor(
    private readonly context: Pick<vscode.ExtensionContext, 'secrets'> & Partial<Pick<vscode.ExtensionContext, 'globalState'>>,
    private readonly log?: (message: string) => void,
    streamPolicy: Partial<ChatStreamPolicy> = {}
  ) {
    this.identities = new ConversationIdentity(context.globalState);
    this.streamPolicy = { ...defaultChatStreamPolicy, ...streamPolicy };
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
    const subscription = token.onCancellationRequested(() => { activeController?.abort(); });
    let activeController: AbortController | undefined;
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
      const requestReasoning = typeof effort === 'string' ? { reasoningEffort: effort } : {};
      const initialPrompt = toSDKPrompt(messages);
      const prompt = structuredClone(initialPrompt);

      for (let attempt = 0; attempt <= MAX_STREAM_RETRIES; attempt += 1) {
        const controller = new AbortController();
        activeController = controller;
        const timedModel = protocolModel(model, apiKey, this.streamPolicy);
        let finished = false;
        let attemptText = '';
        const toolCalls: Extract<LanguageModelV3StreamPart, { type: 'tool-call' }>[] = [];
        const reportState: StreamReportState = {
          textEmitted: false,
          onToolCall: (part) => toolCalls.push(part),
          diagnostics: createStreamDiagnostics(this.log, {
            modelId: model.id,
            apiType: model.apiType,
            sessionId,
            maxOutputTokens: model.maxOutputTokens,
            toolCount: tools?.length ?? 0,
          }),
        };
        try {
          const { stream } = await timedModel.doStream({
            prompt, tools,
            toolChoice: { type: options.toolMode === vscode.LanguageModelChatToolMode.Required ? 'required' : 'auto' },
            maxOutputTokens: model.maxOutputTokens,
            headers: { 'x-opencode-session': sessionId, 'User-Agent': extensionUserAgent() },
            abortSignal: controller.signal,
            includeRawChunks: model.apiType !== 'messages',
            providerOptions: {
              openai: {
                store: false, strictJsonSchema: false, forceReasoning: model.thinking, systemMessageMode: 'system',
                ...requestReasoning,
                ...(model.apiType === 'responses' && model.thinking ? { reasoningSummary: 'auto' } : {}),
              },
              anthropic: typeof effort === 'string' ? { effort } : {},
            },
          });
          for await (const part of stream) {
            const terminal = part.type === 'finish' || (part.type === 'raw' && isRawCompletion(part.rawValue) &&
              !(record(part.rawValue) && part.rawValue.type === 'response.incomplete'));
            if (part.type === 'text-delta' && part.delta) {
              attemptText += part.delta;
            }
            if (part.type === 'raw') reportPart(part, progress, reportState);
            if (terminal) {
              finished = true;
              if (part.type === 'finish') reportPart(part, progress, reportState);
              else if (reportState.diagnostics) reportState.diagnostics.finishSeen = true;
              break;
            }
            if (part.type !== 'raw') reportPart(part, progress, reportState);
          }
          if (toolCalls.length) {
            reportToolCalls(toolCalls, progress);
            if (reportState.diagnostics) summarizeStream(reportState.diagnostics, 'completed');
            return;
          }
          if (reportState.diagnostics) summarizeStream(reportState.diagnostics, 'completed');
          return;
        } catch (error) {
          const timedOut = isStreamTimeout(error);
          if (reportState.diagnostics) summarizeStream(reportState.diagnostics, finished ? 'completed' : timedOut ? 'aborted' : 'errored');
          if (!timedOut) throw error;
          if (finished) {
            if (toolCalls.length) reportToolCalls(toolCalls, progress);
            return;
          }
          if (toolCalls.length) {
            reportToolCalls(toolCalls, progress);
            return;
          }
          if (attempt === MAX_STREAM_RETRIES) {
            progress.report(new vscode.LanguageModelTextPart(STREAM_INTERRUPTION_NOTICE));
            return;
          }
          const delayMs = Math.max(0, this.streamPolicy.retryDelayMs(attempt + 1));
          if (await waitForRetry(delayMs, token)) return;
          if (attemptText) {
            prompt.push({ role: 'assistant', content: [{ type: 'text', text: attemptText }] });
            prompt.push({ role: 'user', content: [{ type: 'text', text: CONTINUATION_INSTRUCTION }] });
          }
        } finally {
          if (activeController === controller) activeController = undefined;
        }
      }
    } finally {
      subscription.dispose();
    }
  }

  provideTokenCount(
    model: RegisteredModel,
    input: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken
  ): Promise<number> {
    const text = typeof input === 'string' ? input : JSON.stringify(input);
    return Promise.resolve(Math.max(1, Math.ceil(text.length / charsPerToken(model.id))));
  }

  dispose(): void { this.changed.dispose(); }
}
