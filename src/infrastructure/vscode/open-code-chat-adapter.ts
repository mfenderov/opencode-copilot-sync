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

interface SchemaSanitizeState {
  inProgress: Set<unknown>;
  droppedEnums: { path: string; count: number }[];
}

function sanitizeSchemaArray(node: unknown[], path: string, state: SchemaSanitizeState): unknown[] {
  if (state.inProgress.has(node)) return node;
  state.inProgress.add(node);
  try {
    return node.map((item, index) => sanitizeSchemaNode(item, `${path}[${index}]`, state));
  } finally {
    state.inProgress.delete(node);
  }
}

function sanitizeNamedSchemaMap(
  value: Record<string, unknown>,
  path: string,
  state: SchemaSanitizeState
): Record<string, unknown> {
  if (state.inProgress.has(value)) return value;
  state.inProgress.add(value);
  try {
    const sanitized: Record<string, unknown> = {};
    for (const [name, child] of Object.entries(value)) {
      sanitized[name] = sanitizeSchemaNode(child, `${path}.${name}`, state);
    }
    return sanitized;
  } finally {
    state.inProgress.delete(value);
  }
}

function sanitizeSchemaEntry(
  key: string,
  value: unknown,
  path: string,
  state: SchemaSanitizeState
): { value?: unknown; droppedValues?: readonly unknown[] } {
  if (key === 'enum' && Array.isArray(value) && exceedsEnumLimits(value)) {
    state.droppedEnums.push({ path, count: value.length });
    return { droppedValues: value };
  }
  if (key === 'enum' || SCHEMA_DATA_KEYS.has(key)) return { value };

  const childPath = `${path}.${key}`;
  const sanitized = NAMED_SCHEMA_MAP_KEYS.has(key) && record(value)
    ? sanitizeNamedSchemaMap(value, childPath, state)
    : sanitizeSchemaNode(value, childPath, state);
  return { value: sanitized };
}

function restoreStringEnumType(schema: Record<string, unknown>, values: readonly unknown[] | undefined): void {
  if (
    values &&
    !('type' in schema) &&
    !('$ref' in schema) &&
    values.length > 0 &&
    values.every((value) => typeof value === 'string')
  ) {
    schema.type = 'string';
  }
}

function sanitizeSchemaObject(
  node: Record<string, unknown>,
  path: string,
  state: SchemaSanitizeState
): Record<string, unknown> {
  if (state.inProgress.has(node)) return node;
  state.inProgress.add(node);
  try {
    const sanitized: Record<string, unknown> = {};
    let droppedValues: readonly unknown[] | undefined;
    for (const [key, value] of Object.entries(node)) {
      const entry = sanitizeSchemaEntry(key, value, path, state);
      if (entry.droppedValues) droppedValues = entry.droppedValues;
      else sanitized[key] = entry.value;
    }
    restoreStringEnumType(sanitized, droppedValues);
    return sanitized;
  } finally {
    state.inProgress.delete(node);
  }
}

function sanitizeSchemaNode(node: unknown, path: string, state: SchemaSanitizeState): unknown {
  if (Array.isArray(node)) return sanitizeSchemaArray(node, path, state);
  if (!record(node)) return node;
  return sanitizeSchemaObject(node, path, state);
}

function sanitizeToolSchema(
  schema: unknown,
  toolName: string
): LanguageModelV3FunctionTool['inputSchema'] {
  const state: SchemaSanitizeState = { droppedEnums: [], inProgress: new Set() };
  const sanitized = sanitizeSchemaNode(schema, 'root', state);
  for (const dropped of state.droppedEnums) {
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

function toolCallContentPart(
  part: vscode.LanguageModelToolCallPart,
  names: Map<string, string>
): AssistantContent[number] {
  names.set(part.callId, part.name);
  return { type: 'tool-call', toolCallId: part.callId, toolName: part.name, input: part.input };
}

function dataContentPart(part: vscode.LanguageModelDataPart): AssistantContent[number] {
  if (part.mimeType.startsWith('image/')) return { type: 'file', data: part.data, mediaType: part.mimeType };
  throw new Error(`Unsupported message data: ${part.mimeType}`);
}

function contentPart(part: unknown, names: Map<string, string>): AssistantContent[number] | undefined {
  if (part instanceof vscode.LanguageModelTextPart) return { type: 'text', text: part.value };
  if (part instanceof vscode.LanguageModelToolCallPart) return toolCallContentPart(part, names);
  if (thinkingPart && part instanceof thinkingPart) return undefined;
  if (part instanceof vscode.LanguageModelDataPart) return dataContentPart(part);
  throw new Error('Unsupported language model message part');
}

function responseOutputText(item: unknown): string[] {
  if (!record(item) || item.type !== 'message' || !Array.isArray(item.content)) return [];
  return item.content.flatMap((part) =>
    record(part) && part.type === 'output_text' && typeof part.text === 'string' ? [part.text] : []
  );
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
  const text = rawValue.response.output.flatMap(responseOutputText);
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

const CHAT_REASONING_KEYS = ['reasoning_content', 'thought', 'reasoning'] as const;

function reasoningText(delta: Record<string, unknown>): string[] {
  const direct = CHAT_REASONING_KEYS.flatMap((key) => {
    const value = delta[key];
    return typeof value === 'string' && value.length > 0 ? [value] : [];
  });
  const details = Array.isArray(delta.reasoning_details) ? delta.reasoning_details.flatMap((detail) =>
    record(detail) && typeof detail.text === 'string' && detail.text.length > 0 ? [detail.text] : []
  ) : [];
  return [...direct, ...details];
}

function chatReasoningDelta(
  rawValue: unknown
): { id: string; delta: string } | undefined {
  // Chat-completions gateways expose reasoning only in raw chunks; the SDK parser drops these fields.
  if (!record(rawValue) || !Array.isArray(rawValue.choices)) return undefined;
  const deltas = rawValue.choices.flatMap((choice) =>
    record(choice) && record(choice.delta) ? reasoningText(choice.delta) : []
  );
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
  onToolCall?(part: ToolCallStreamPart): void;
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

type StreamPartKind = 'text' | 'reasoning' | 'tool-call' | 'finish' | 'raw';
interface StreamDiagnosticPart {
  finishReason?: { unified: string; raw?: unknown };
  rawValue?: unknown;
}

function noteFinish(diagnostics: StreamDiagnostics, part?: StreamDiagnosticPart): void {
  diagnostics.finishSeen = true;
  diagnostics.finishUnified = part?.finishReason?.unified;
  diagnostics.finishRaw = typeof part?.finishReason?.raw === 'string' ? part.finishReason.raw : undefined;
}

function noteRawChunk(diagnostics: StreamDiagnostics, part?: StreamDiagnosticPart): void {
  diagnostics.rawChunks += 1;
  const rawValue = part?.rawValue;
  const rawType = record(rawValue) && typeof rawValue.type === 'string' ? rawValue.type : undefined;
  if (rawType) diagnostics.lastRawType = rawType;
}

function noteStreamPart(
  diagnostics: StreamDiagnostics | undefined,
  kind: StreamPartKind,
  part?: StreamDiagnosticPart
): void {
  if (!diagnostics) return;
  const now = Date.now();
  diagnostics.firstPartAt ??= now;
  diagnostics.lastPartAt = now;
  if (kind === 'text') diagnostics.textDeltas += 1;
  else if (kind === 'reasoning') diagnostics.reasoningDeltas += 1;
  else if (kind === 'tool-call') diagnostics.toolCalls += 1;
  else if (kind === 'finish') noteFinish(diagnostics, part);
  else noteRawChunk(diagnostics, part);
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
  parts: readonly ToolCallStreamPart[],
  progress: vscode.Progress<vscode.LanguageModelResponsePart>
): void {
  for (const part of parts) reportToolCall(part, progress);
}

type ToolCallStreamPart = Extract<LanguageModelV3StreamPart, { type: 'tool-call' }>;
type FinishStreamPart = Extract<LanguageModelV3StreamPart, { type: 'finish' }>;

function reportToolCall(part: ToolCallStreamPart, progress: vscode.Progress<vscode.LanguageModelResponsePart>): void {
  const input: unknown = JSON.parse(part.input);
  if (!record(input)) throw new Error(`Invalid tool arguments for ${part.toolName}`);
  progress.report(new vscode.LanguageModelToolCallPart(part.toolCallId, part.toolName, input));
}

function reportRawPart(
  part: Extract<LanguageModelV3StreamPart, { type: 'raw' }>,
  progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  state: StreamReportState
): void {
  noteStreamPart(state.diagnostics, 'raw', part);
  const reasoning = legacyReasoningDelta(part.rawValue) ?? chatReasoningDelta(part.rawValue);
  if (reasoning) reportThinkingDelta(reasoning.delta, reasoning.id, progress);
  const fallback = completedResponseText(part.rawValue);
  if (!state.textEmitted && fallback) {
    state.textEmitted = true;
    progress.report(new vscode.LanguageModelTextPart(fallback));
  }
}

const FINISH_NOTICES: Record<string, string> = {
  length: '\n\nOpenCode: Response may be incomplete because the model reached its output token limit.',
  'content-filter': "\n\nOpenCode: The response was stopped by the model provider's content filter.",
  error: '\n\nOpenCode: The model provider reported an error while finishing the response.',
};

function finishNotice(part: FinishStreamPart): string | undefined {
  if (part.finishReason.unified === 'other') {
    const detail = part.finishReason.raw === undefined
      ? 'the stream ended without a completion event'
      : 'the provider returned an unrecognized completion reason';
    return `\n\nOpenCode: Response may be incomplete because ${detail}.`;
  }
  return FINISH_NOTICES[part.finishReason.unified];
}

function reportFinishPart(part: FinishStreamPart, progress: vscode.Progress<vscode.LanguageModelResponsePart>): void {
  const notice = finishNotice(part);
  if (notice) progress.report(new vscode.LanguageModelTextPart(notice));
  progress.report(vscode.LanguageModelDataPart.json({
    prompt_tokens: part.usage.inputTokens.total,
    completion_tokens: part.usage.outputTokens.total,
    completion_tokens_details: { reasoning_tokens: part.usage.outputTokens.reasoning },
  }, 'usage'));
}

type ContentStreamPart = Exclude<LanguageModelV3StreamPart, { type: 'finish' | 'error' }>;

function reportContentPart(
  part: ContentStreamPart,
  progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  state: StreamReportState
): void {
  if (part.type === 'text-delta') {
    if (part.delta) state.textEmitted = true;
    noteStreamPart(state.diagnostics, 'text');
    progress.report(new vscode.LanguageModelTextPart(part.delta));
  } else if (part.type === 'reasoning-delta') {
    noteStreamPart(state.diagnostics, 'reasoning');
    reportThinkingDelta(part.delta, part.id, progress);
  } else if (part.type === 'tool-call') {
    noteStreamPart(state.diagnostics, 'tool-call');
    if (state.onToolCall) state.onToolCall(part);
    else reportToolCall(part, progress);
  } else if (part.type === 'raw') {
    reportRawPart(part, progress, state);
  }
}

function reportPart(
  part: LanguageModelV3StreamPart,
  progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  state: StreamReportState
): void {
  if (part.type === 'finish') {
    noteStreamPart(state.diagnostics, 'finish', part);
    reportFinishPart(part, progress);
  } else if (part.type === 'error') {
    if (state.diagnostics) summarizeStream(state.diagnostics, 'errored');
    throw part.error instanceof Error ? part.error : new Error(String(part.error));
  } else {
    reportContentPart(part, progress, state);
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

interface PreparedChatRequest {
  tools?: LanguageModelV3FunctionTool[];
  effort: unknown;
  prompt: LanguageModelV3Prompt;
}

function prepareChatRequest(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  options: vscode.ProvideLanguageModelChatResponseOptions
): PreparedChatRequest {
  const tools = options.tools?.map((tool) => ({
    type: 'function' as const,
    name: tool.name,
    description: tool.description,
    inputSchema: sanitizeToolSchema(tool.inputSchema ?? { type: 'object', properties: {} }, tool.name),
  }));
  const configuration = (options as { modelConfiguration?: Record<string, unknown> }).modelConfiguration;
  const effort: unknown = configuration?.reasoningEffort ?? options.modelOptions?.reasoningEffort;
  return { tools, effort, prompt: structuredClone(toSDKPrompt(messages)) };
}

interface StreamAttemptRequest {
  model: CustomEndpointModel;
  apiKey: string;
  sessionId: string;
  options: vscode.ProvideLanguageModelChatResponseOptions;
  progress: vscode.Progress<vscode.LanguageModelResponsePart>;
  diagnosticsLog?: (message: string) => void;
  streamPolicy: StreamTimeoutOptions;
  prepared: PreparedChatRequest;
  controller: AbortController;
  lastAttempt: boolean;
}

interface StreamAttemptState {
  attemptText: string;
  finished: boolean;
  report: StreamReportState;
  toolCalls: ToolCallStreamPart[];
}

function createStreamAttemptState(request: StreamAttemptRequest): StreamAttemptState {
  const { model, sessionId, diagnosticsLog, prepared } = request;
  const toolCalls: ToolCallStreamPart[] = [];
  return {
    attemptText: '',
    finished: false,
    toolCalls,
    report: {
      textEmitted: false,
      onToolCall: (part) => toolCalls.push(part),
      diagnostics: createStreamDiagnostics(diagnosticsLog, {
        modelId: model.id,
        apiType: model.apiType,
        sessionId,
        maxOutputTokens: model.maxOutputTokens,
        toolCount: prepared.tools?.length ?? 0,
      }),
    },
  };
}

function isTerminalPart(part: LanguageModelV3StreamPart): boolean {
  return part.type === 'finish' || (part.type === 'raw' && isRawCompletion(part.rawValue) &&
    !(record(part.rawValue) && part.rawValue.type === 'response.incomplete'));
}

async function requestStream(request: StreamAttemptRequest): Promise<AsyncIterable<LanguageModelV3StreamPart>> {
  const { model, apiKey, sessionId, options, streamPolicy, prepared, controller } = request;
  const requestReasoning = typeof prepared.effort === 'string' ? { reasoningEffort: prepared.effort } : {};
  const timedModel = protocolModel(model, apiKey, streamPolicy);
  const { stream } = await timedModel.doStream({
    prompt: prepared.prompt,
    tools: prepared.tools,
    toolChoice: { type: options.toolMode === vscode.LanguageModelChatToolMode.Required ? 'required' : 'auto' },
    maxOutputTokens: model.maxOutputTokens,
    headers: { 'x-opencode-session': sessionId, 'User-Agent': extensionUserAgent() },
    abortSignal: controller.signal,
    includeRawChunks: model.apiType !== 'messages',
    providerOptions: {
      openai: {
        store: false,
        strictJsonSchema: false,
        forceReasoning: model.thinking,
        systemMessageMode: 'system',
        ...requestReasoning,
        ...(model.apiType === 'responses' && model.thinking ? { reasoningSummary: 'auto' } : {}),
      },
      anthropic: typeof prepared.effort === 'string' ? { effort: prepared.effort } : {},
    },
  });
  return stream;
}

function reportAttemptPart(
  part: LanguageModelV3StreamPart,
  progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  state: StreamAttemptState
): boolean {
  if (part.type === 'text-delta' && part.delta) state.attemptText += part.delta;
  if (part.type === 'raw') reportPart(part, progress, state.report);
  if (isTerminalPart(part)) {
    state.finished = true;
    if (part.type === 'finish') reportPart(part, progress, state.report);
    else if (state.report.diagnostics) state.report.diagnostics.finishSeen = true;
    return true;
  }
  if (part.type !== 'raw') reportPart(part, progress, state.report);
  return false;
}

async function readStreamAttempt(
  request: StreamAttemptRequest,
  state: StreamAttemptState
): Promise<void> {
  const stream = await requestStream(request);
  for await (const part of stream) {
    if (reportAttemptPart(part, request.progress, state)) break;
  }
}

function handleStreamTimeout(
  request: StreamAttemptRequest,
  state: StreamAttemptState
): string | undefined {
  if (state.report.diagnostics) {
    summarizeStream(state.report.diagnostics, state.finished ? 'completed' : 'aborted');
  }
  if (state.toolCalls.length) {
    reportToolCalls(state.toolCalls, request.progress);
    return undefined;
  }
  if (state.finished) return undefined;
  if (request.lastAttempt) {
    request.progress.report(new vscode.LanguageModelTextPart(STREAM_INTERRUPTION_NOTICE));
    return undefined;
  }
  return state.attemptText;
}

async function streamAttempt(request: StreamAttemptRequest): Promise<string | undefined> {
  const state = createStreamAttemptState(request);
  try {
    await readStreamAttempt(request, state);
    reportToolCalls(state.toolCalls, request.progress);
    if (state.report.diagnostics) summarizeStream(state.report.diagnostics, 'completed');
  } catch (error) {
    if (!isStreamTimeout(error)) {
      if (state.report.diagnostics) summarizeStream(state.report.diagnostics, state.finished ? 'completed' : 'errored');
      throw error;
    }
    return handleStreamTimeout(request, state);
  }
  return undefined;
}

async function runChatStream(
  model: CustomEndpointModel,
  apiKey: string,
  sessionId: string,
  options: vscode.ProvideLanguageModelChatResponseOptions,
  progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  token: vscode.CancellationToken,
  streamPolicy: ChatStreamPolicy,
  diagnosticsLog: ((message: string) => void) | undefined,
  prepared: PreparedChatRequest,
  setActiveController: (controller: AbortController | undefined) => void
): Promise<void> {
  for (let attempt = 0; attempt <= MAX_STREAM_RETRIES; attempt += 1) {
    const controller = new AbortController();
    setActiveController(controller);
    let continuation: string | undefined;
    try {
      continuation = await streamAttempt({
        model, apiKey, sessionId, options, progress, diagnosticsLog, streamPolicy, prepared, controller,
        lastAttempt: attempt === MAX_STREAM_RETRIES,
      });
    } finally {
      setActiveController(undefined);
    }
    if (continuation === undefined) return;
    if (await waitForRetry(Math.max(0, streamPolicy.retryDelayMs(attempt + 1)), token)) return;
    if (continuation) {
      prepared.prompt.push({ role: 'assistant', content: [{ type: 'text', text: continuation }] });
      prepared.prompt.push({ role: 'user', content: [{ type: 'text', text: CONTINUATION_INSTRUCTION }] });
    }
  }
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
    let activeController: AbortController | undefined;
    const subscription = token.onCancellationRequested(() => { activeController?.abort(); });
    try {
      const prepared = prepareChatRequest(messages, options);
      await runChatStream(
        model,
        apiKey,
        sessionId,
        options,
        progress,
        token,
        this.streamPolicy,
        this.log,
        prepared,
        (controller) => { activeController = controller; }
      );
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
