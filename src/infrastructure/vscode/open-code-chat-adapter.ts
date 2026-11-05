import * as vscode from 'vscode';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createMistral } from '@ai-sdk/mistral';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModelV3, LanguageModelV3Prompt, LanguageModelV3StreamPart, LanguageModelV3FunctionTool, LanguageModelV3ToolResultPart, SharedV3ProviderOptions } from '@ai-sdk/provider';
import type { OpenCodeApiType, OpenCodeModel, OpenCodeProviderPackage } from '../../models/domain/model.js';
import { extensionUserAgent } from '../../extension-version.js';
import { resolveApiKey } from './secret-store.js';
import { fetchWithRetry } from '../http/fetch-policy.js';
import { withProxy } from '../http/proxy-routing.js';
import {
  createStreamTimeoutFetch,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  OPEN_CODE_HEADER_TIMEOUT_MS,
  StreamTimeoutError,
  type StreamTimeoutOptions,
} from '../http/stream-timeout-fetch.js';
import { ConversationIdentity } from './conversation-identity.js';
import { hostDataBytes, hostDataPart, textDataMime, toolResultOutput, type HostDataPart } from './sdk-content.js';
import { reportSDKError } from './sdk-errors.js';
import { sdkProviderOptions } from './sdk-reasoning.js';
import { nativeReplay, restoreNativeReplay, SDKReplayCollector, sdkToolInput } from './sdk-replay.js';

export type RegisteredModel = OpenCodeModel & vscode.LanguageModelChatInformation;
type AssistantContent = Extract<LanguageModelV3Prompt[number], { role: 'assistant' }>['content'];

export interface ChatStreamPolicy extends StreamTimeoutOptions {
  retryDelayMs(retryNumber: number): number;
}

const MAX_STREAM_RETRIES = 3;
const CONTINUATION_INSTRUCTION = 'The previous response was interrupted. Continue from where you left off without repeating completed content.';
const STREAM_INTERRUPTION_NOTICE = '\n\nOpenCode: The response was interrupted after repeated stream timeouts.';

const defaultChatStreamPolicy: ChatStreamPolicy = {
  headerTimeoutMs: OPEN_CODE_HEADER_TIMEOUT_MS,
  chunkTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  retryDelayMs(retryNumber) {
    const backoff = Math.min(2_000 * 2 ** (retryNumber - 1), 10_000);
    return backoff + Math.random() * Math.min(100, 10_000 - backoff);
  },
};
const thinkingPart = (vscode as typeof vscode & {
  LanguageModelThinkingPart?: new (value: string, id: string, metadata?: Record<string, unknown>) => vscode.LanguageModelResponsePart;
}).LanguageModelThinkingPart;

// Long-context models get a Context Size toggle so users can trade token
// usage against the full window. Restored from the pre-SDK provider: the
// threshold and tiers match what the model picker showed before v0.20.
const LONG_CONTEXT_THRESHOLD = 256000;

function effortLabel(effort: string): string {
  switch (effort) {
    case 'minimal': return 'Minimal';
    case 'low': return 'Low';
    case 'medium': return 'Medium';
    case 'high': return 'High';
    case 'xhigh': return 'Extra High';
    case 'max': return 'Max';
    default: return effort.charAt(0).toUpperCase() + effort.slice(1);
  }
}

function effortDescription(effort: string): string {
  switch (effort) {
    case 'minimal': return 'Minimal reasoning';
    case 'low': return 'Faster responses with light reasoning';
    case 'medium': return 'Balanced reasoning and speed';
    case 'high': return 'Deep reasoning';
    case 'xhigh': return 'Extra deep reasoning';
    case 'max': return 'Maximum reasoning depth';
    default: return `${effort} reasoning`;
  }
}

function modelConfigurationSchema(model: OpenCodeModel): Record<string, unknown> | undefined {
  const properties: Record<string, unknown> = {};
  const efforts = model.supportsReasoningEffort?.filter((effort) => effort !== 'none');
  if (efforts?.length) {
    properties.reasoningEffort = {
      type: 'string',
      title: 'Thinking Effort',
      enum: efforts,
      enumItemLabels: efforts.map(effortLabel),
      enumDescriptions: efforts.map(effortDescription),
      default: efforts.includes('medium') ? 'medium' : efforts[0],
      group: 'navigation',
    };
  }
  if (model.contextWindow > LONG_CONTEXT_THRESHOLD) {
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
  return Object.keys(properties).length > 0 ? { type: 'object', properties } : undefined;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function configuredStreamIdleTimeoutMs(): number {
  const override = process.env.OPENCODE_STREAM_IDLE_TIMEOUT_MS;
  const seconds: unknown = override
    ? Number(override) / 1000
    : vscode.workspace.getConfiguration('opencode').get<unknown>(
      'streamIdleTimeoutSeconds',
      DEFAULT_STREAM_IDLE_TIMEOUT_MS / 1000
    );
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
    throw new Error('OpenCode stream inactivity timeout must be a positive number.');
  }
  return seconds * 1000;
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
  return { type: 'tool-result', toolCallId: part.callId, toolName, output: toolResultOutput(part.content) };
}

function toolCallContentPart(
  part: vscode.LanguageModelToolCallPart,
  names: Map<string, string>
): AssistantContent[number] {
  names.set(part.callId, part.name);
  return { type: 'tool-call', toolCallId: part.callId, toolName: part.name, input: part.input };
}

function dataContentPart(part: HostDataPart): AssistantContent[number] | undefined {
  const mimeType = part.mimeType.split(';', 1)[0].trim().toLowerCase();
  if (mimeType === 'usage' || mimeType === 'cache_control') return undefined;
  const data = hostDataBytes(part.data);
  return textDataMime(mimeType)
    ? { type: 'text', text: new TextDecoder('utf-8', { fatal: true }).decode(data) }
    : { type: 'file', data, mediaType: mimeType };
}

function contentPart(part: unknown, names: Map<string, string>): AssistantContent[number] | undefined {
  if (part instanceof vscode.LanguageModelTextPart) return { type: 'text', text: part.value };
  if (part instanceof vscode.LanguageModelToolCallPart) return toolCallContentPart(part, names);
  if (thinkingPart && part instanceof thinkingPart) return undefined;
  const data = hostDataPart(part);
  if (data) return dataContentPart(data);
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

interface PromptMessageState {
  role: number;
  content: AssistantContent;
  savedReplay: AssistantContent | undefined;
}

const userRole: number = vscode.LanguageModelChatMessageRole.User;
const assistantRole: number = vscode.LanguageModelChatMessageRole.Assistant;

function pushAssistant(prompt: LanguageModelV3Prompt, state: PromptMessageState): AssistantContent {
  const replay = state.savedReplay && state.content.some((part) => part.type === 'tool-call')
    ? restoreNativeReplay(state.content, state.savedReplay)
    : state.content;
  prompt.push({ role: 'assistant', content: replay });
  return [];
}

function pushUser(prompt: LanguageModelV3Prompt, content: AssistantContent): AssistantContent {
  if (!content.length) return content;
  const userContent = content.filter((part) => part.type === 'text' || part.type === 'file');
  if (userContent.length !== content.length) throw new Error('Tool calls must be in assistant messages');
  prompt.push({ role: 'user', content: userContent });
  return [];
}

function pushSystem(prompt: LanguageModelV3Prompt, content: AssistantContent): AssistantContent {
  if (!content.length) return content;
  prompt.push({ role: 'system', content: content.map((part) => part.type === 'text' ? part.text : '').join('') });
  return [];
}

type ToolMessageContent = Extract<LanguageModelV3Prompt[number], { role: 'tool' }>['content'];

function pushToolResults(prompt: LanguageModelV3Prompt, content: AssistantContent): AssistantContent {
  const toolOnly = content.every((part) => part.type === 'tool-result');
  if (!toolOnly || !content.length) return content;
  const results = [...content] as ToolMessageContent;
  const target = prompt.length > 0 ? prompt[prompt.length - 1] : undefined;
  if (target?.role === 'tool') target.content.push(...results);
  else prompt.push({ role: 'tool', content: results });
  return [];
}

function flushMessage(prompt: LanguageModelV3Prompt, state: PromptMessageState): AssistantContent {
  if (!state.content.length) return state.content;
  if (state.role === assistantRole) return pushAssistant(prompt, state);
  if (state.role === userRole) return pushUser(prompt, state.content);
  return pushSystem(prompt, state.content);
}

function appendToolResult(
  prompt: LanguageModelV3Prompt,
  names: Map<string, string>,
  part: vscode.LanguageModelToolResultPart,
  state: PromptMessageState
): AssistantContent {
  const result = toolResult(part, names);
  const previous = prompt.length > 0 ? prompt[prompt.length - 1] : undefined;
  if (state.role === userRole && state.content.length === 0 && previous?.role === 'tool') {
    previous.content.push(result);
    return state.content;
  }
  return pushToolResults(prompt, [...state.content, result]);
}

export function toSDKPrompt(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  model?: Pick<OpenCodeModel, 'id' | 'providerPackage'>
): LanguageModelV3Prompt {
  const prompt: LanguageModelV3Prompt = [];
  const names = new Map<string, string>();
  for (const message of messages) {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-conversion -- VS Code roles arrive as enum members; normalize for prompt assembly.
    const role = Number(message.role);
    const state: PromptMessageState = {
      role,
      content: [],
      savedReplay: role === assistantRole ? nativeReplay(message.content, model) : undefined,
    };
    for (const part of message.content) {
      if (part instanceof vscode.LanguageModelToolResultPart) {
        state.content = appendToolResult(prompt, names, part, state);
      } else {
        const mapped = contentPart(part, names);
        if (mapped) state.content.push(mapped);
      }
    }
    state.content = flushMessage(prompt, state);
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
  progress.report(new vscode.LanguageModelToolCallPart(part.toolCallId, part.toolName, sdkToolInput(part)));
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
  } else if (part.type === 'file') {
    progress.report(new vscode.LanguageModelDataPart(hostDataBytes(part.data), part.mediaType));
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

interface OpenAIEvent {
  finish: boolean;
  done: boolean;
  usageOnly: boolean;
  usagePresent: boolean;
}

const EMPTY_OPENAI_EVENT: OpenAIEvent = { finish: false, done: false, usageOnly: false, usagePresent: false };

function eventData(frame: string): string {
  return frame.split(/\r\n|\r|\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^ /, ''))
    .join('\n');
}

function eventObject(data: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(data);
    return record(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function chatCompletionEvent(value: Record<string, unknown>): OpenAIEvent {
  const choices = Array.isArray(value.choices) ? value.choices : [];
  return {
    finish: choices.some((choice) =>
      record(choice) && choice.finish_reason !== null && choice.finish_reason !== undefined
    ),
    done: false,
    usageOnly: choices.length === 0 && record(value.usage),
    usagePresent: record(value.usage),
  };
}

function openAIEvent(frame: string, apiType: OpenCodeModel['apiType']): OpenAIEvent {
  const data = eventData(frame);
  if (apiType === 'chat-completions' && data === '[DONE]') return { ...EMPTY_OPENAI_EVENT, done: true };
  const value = eventObject(data);
  if (!value) return EMPTY_OPENAI_EVENT;
  if (apiType !== 'responses') return chatCompletionEvent(value);
  const finish = value.type === 'response.completed' || value.type === 'response.incomplete';
  return { ...EMPTY_OPENAI_EVENT, finish };
}

interface CompletionState {
  terminalSeen: boolean;
  terminalTimer?: ReturnType<typeof setTimeout>;
  terminated: boolean;
  controller?: TransformStreamDefaultController<Uint8Array>;
}

function stopOnProtocolTerminal(controller: TransformStreamDefaultController<Uint8Array>, state: CompletionState): void {
  state.terminated = true;
  clearTimeout(state.terminalTimer);
  controller.terminate();
}

function flushEventBytes(text: string, currentTextEnd: number, controller: TransformStreamDefaultController<Uint8Array>): void {
  if (currentTextEnd > 0) controller.enqueue(new TextEncoder().encode(text.slice(0, currentTextEnd)));
}

function completesOnEvent(event: OpenAIEvent, apiType: OpenCodeModel['apiType'], terminalSeen: boolean): boolean {
  return (terminalSeen && (event.usageOnly || event.done)) || event.done ||
    (event.finish && (apiType !== 'chat-completions' || event.usagePresent));
}

function handleCompletionEvent(
  event: OpenAIEvent,
  apiType: OpenCodeModel['apiType'],
  text: string,
  currentTextEnd: number,
  controller: TransformStreamDefaultController<Uint8Array>,
  state: CompletionState,
  terminalGraceMs: number
): boolean {
  if (completesOnEvent(event, apiType, state.terminalSeen)) {
    flushEventBytes(text, currentTextEnd, controller);
    stopOnProtocolTerminal(controller, state);
    return true;
  }
  if (event.finish && !state.terminalSeen) {
    state.terminalSeen = true;
    state.terminalTimer = setTimeout(() => {
      if (state.terminated) return;
      state.terminated = true;
      state.controller?.terminate();
    }, Math.max(0, terminalGraceMs));
  }
  return false;
}

// Close OpenAI SSE input at protocol completion so SDK transforms flush without waiting for HTTP EOF.
function createProtocolCompletionFetch(
  baseFetch: typeof fetch,
  apiType: OpenCodeModel['apiType'],
  terminalGraceMs: number
): typeof fetch {
  if (apiType === 'messages') return baseFetch;
  return async (input, init) => {
    const response = await baseFetch(input, init);
    if (!response.body) return response;

    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    const state: CompletionState = { terminalSeen: false, terminated: false };
    let incompleteFrame = '';
    const body = (response.body as ReadableStream<Uint8Array>).pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        start(controller) {
          state.controller = controller;
        },
        transform(chunk, controller) {
          const text = decoder.decode(chunk, { stream: true });
          const previousIncompleteLength = incompleteFrame.length;
          const bufferedText = incompleteFrame + text;
          const separatorPattern = /\r\n\r\n|\n\n|\r\r/g;
          let frameStart = 0;
          for (const separator of bufferedText.matchAll(separatorPattern)) {
            const frameEnd = separator.index;
            const nextFrameStart = frameEnd + separator[0].length;
            const event = openAIEvent(bufferedText.slice(frameStart, frameEnd), apiType);
            const currentTextEnd = Math.max(0, nextFrameStart - previousIncompleteLength);
            if (handleCompletionEvent(event, apiType, text, currentTextEnd, controller, state, terminalGraceMs)) return;
            frameStart = nextFrameStart;
          }

          incompleteFrame = bufferedText.slice(frameStart);
          if (text) controller.enqueue(encoder.encode(text));
        },
        flush(controller) {
          clearTimeout(state.terminalTimer);
          const remainder = decoder.decode();
          if (remainder) controller.enqueue(encoder.encode(remainder));
        },
      })
    );
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

interface ProviderFetch { proxyFetch: typeof fetch; sdkFetch: typeof fetch }

interface ProviderRequest {
  baseURL: string;
  modelId: string;
  sdkFetch: typeof fetch;
  apiKey: string;
}

function providerFetches(
  model: OpenCodeModel,
  streamPolicy: StreamTimeoutOptions
): ProviderFetch {
  const proxyFetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (input instanceof Request) return fetch(input, await withProxy(url, { ...init }));
    return fetchWithRetry(url, { ...init }, {
      retries: 1,
      baseDelayMs: 300,
      maxDelayMs: 1000,
      rateLimitRetries: 10,
      rateLimitImmediateAttempts: 3,
      rateLimitDelayMs: 1000,
      rateLimitMaxWaitMs: 3000,
    });
  };
  const timeoutFetch = createStreamTimeoutFetch(proxyFetch, streamPolicy);
  return { proxyFetch, sdkFetch: createProtocolCompletionFetch(timeoutFetch, model.apiType, 100) };
}

export const PROVIDER_PROTOCOLS: Record<OpenCodeProviderPackage, OpenCodeApiType> = {
  '@ai-sdk/openai-compatible': 'chat-completions',
  '@ai-sdk/openai': 'responses',
  '@ai-sdk/anthropic': 'messages',
  '@ai-sdk/google': 'google',
  '@ai-sdk/mistral': 'chat-completions',
};

interface ProviderSpec {
  protocols: Partial<Record<OpenCodeApiType, 'chat' | 'responses' | 'messages' | 'native'>>;
  reasoning: (effort: string | undefined, model: OpenCodeModel) => SharedV3ProviderOptions;
  create: (request: ProviderRequest, apiType: OpenCodeApiType) => LanguageModelV3;
}

const PROVIDER_SPECS: Record<OpenCodeProviderPackage, ProviderSpec> = {
  '@ai-sdk/openai-compatible': {
    protocols: { 'chat-completions': 'chat' },
    reasoning: (effort) => ({ opencode: { strictJsonSchema: false, ...(effort ? { reasoningEffort: effort } : {}) } }),
    create: ({ baseURL, modelId, sdkFetch, apiKey }) =>
      createOpenAICompatible({ name: 'opencode', baseURL, apiKey, fetch: sdkFetch, includeUsage: true })(modelId),
  },
  '@ai-sdk/openai': {
    protocols: { 'responses': 'responses', 'chat-completions': 'chat' },
    reasoning: (effort, model) => ({ openai: {
      store: false,
      strictJsonSchema: false,
      forceReasoning: model.thinking,
      systemMessageMode: 'system',
      ...(effort ? { reasoningEffort: effort } : {}),
      ...(model.apiType === 'responses' && model.thinking ? { reasoningSummary: 'auto' } : {}),
    } }),
    create: ({ baseURL, modelId, sdkFetch, apiKey }, apiType) => {
      const openai = createOpenAI({ baseURL, apiKey, fetch: sdkFetch });
      return apiType === 'chat-completions' ? openai.chat(modelId) : openai.responses(modelId);
    },
  },
  '@ai-sdk/anthropic': {
    protocols: { 'messages': 'messages' },
    reasoning: (effort) => ({ anthropic: effort ? { effort } : {} }),
    create: ({ baseURL, modelId, sdkFetch, apiKey }) =>
      createAnthropic({ baseURL, authToken: apiKey, fetch: sdkFetch })(modelId),
  },
  '@ai-sdk/google': {
    protocols: { 'google': 'native' },
    reasoning: (effort) => ({ google: effort ? { thinkingConfig: { thinkingLevel: effort, includeThoughts: true } } : {} }),
    create: ({ baseURL, modelId, sdkFetch, apiKey }) =>
      createGoogleGenerativeAI({
        baseURL, apiKey, fetch: sdkFetch,
        headers: { Authorization: `Bearer ${apiKey}`, 'x-goog-api-key': undefined },
      })(modelId),
  },
  '@ai-sdk/mistral': {
    protocols: { 'chat-completions': 'chat' },
    reasoning: (effort) => ({ mistral: effort ? { reasoningEffort: effort } : {} }),
    create: ({ baseURL, modelId, sdkFetch, apiKey }) =>
      createMistral({ baseURL, apiKey, fetch: sdkFetch })(modelId),
  },
};

export function providerSpec(packageName: string): ProviderSpec {
  if (!Object.hasOwn(PROVIDER_SPECS, packageName)) throw new Error(`Unsupported provider ${packageName}.`);
  return PROVIDER_SPECS[packageName as OpenCodeProviderPackage];
}

function providerModel(model: OpenCodeModel, request: ProviderRequest): LanguageModelV3 | undefined {
  const spec = providerSpec(model.providerPackage);
  if (spec.protocols[model.apiType] === undefined) return undefined;
  return spec.create(request, model.apiType);
}

function protocolModel(model: OpenCodeModel, apiKey: string, streamPolicy: StreamTimeoutOptions): LanguageModelV3 {
  const { sdkFetch } = providerFetches(model, streamPolicy);
  const languageModel = providerModel(model, { baseURL: model.url, modelId: model.id, sdkFetch, apiKey });
  if (!languageModel) {
    throw new Error(`Unsupported provider ${model.providerPackage} for protocol ${model.apiType}.`);
  }
  return languageModel;
}

interface PreparedTools { tools?: LanguageModelV3FunctionTool[] }

interface PreparedEffort { effort: unknown }

interface PreparedPrompt { prompt: LanguageModelV3Prompt }

interface PreparedChatRequest extends PreparedTools, PreparedEffort, PreparedPrompt {}

function preparedTools(options: vscode.ProvideLanguageModelChatResponseOptions): PreparedTools {
  const tools = options.tools?.map((tool) => ({
    type: 'function' as const,
    name: tool.name,
    description: tool.description,
    inputSchema: sanitizeToolSchema(tool.inputSchema ?? { type: 'object', properties: {} }, tool.name),
  }));
  return { tools };
}

interface EffortSource { value?: unknown }

function documentedEffort(options: vscode.ProvideLanguageModelChatResponseOptions): EffortSource {
  return { value: options.modelOptions?.reasoningEffort ?? options.modelOptions?.thinkingLevel };
}

function configuredEffort(
  legacy: { modelConfiguration?: Record<string, unknown>; configuration?: Record<string, unknown> }
): EffortSource {
  return { value: legacy.modelConfiguration?.reasoningEffort ?? legacy.modelConfiguration?.thinkingLevel ??
    legacy.configuration?.reasoningEffort ?? legacy.configuration?.thinkingLevel };
}

function rootEffort(legacy: { reasoningEffort?: unknown; thinkingLevel?: unknown }): EffortSource {
  return { value: legacy.reasoningEffort ?? legacy.thinkingLevel };
}

function firstEffort(...sources: EffortSource[]): unknown {
  for (const source of sources) {
    if (source.value !== undefined) return source.value;
  }
  return undefined;
}

interface EffortSources {
  documented?: unknown;
  modelConfig?: unknown;
  configuration?: unknown;
  root?: unknown;
}

function legacyEffort(options: vscode.ProvideLanguageModelChatResponseOptions): EffortSources {
  const legacy = options as {
    modelConfiguration?: Record<string, unknown>;
    configuration?: Record<string, unknown>;
    reasoningEffort?: unknown;
    thinkingLevel?: unknown;
  };
  return {
    documented: documentedEffort(options).value,
    modelConfig: undefined,
    configuration: configuredEffort(legacy).value ?? rootEffort(legacy).value,
    root: undefined,
  };
}

function preparedEffort(options: vscode.ProvideLanguageModelChatResponseOptions): PreparedEffort {
  const sources = legacyEffort(options);
  const effort = firstEffort(
    { value: sources.documented },
    { value: sources.configuration },
    { value: sources.root }
  );
  return { effort };
}

function preparedPrompt(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  model: OpenCodeModel
): PreparedPrompt {
  return { prompt: structuredClone(toSDKPrompt(messages, model)) };
}

interface PreparedModel { readonly model: OpenCodeModel }

function preparedModel(model: OpenCodeModel): PreparedModel {
  return { model };
}

function prepareChatRequest(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  options: vscode.ProvideLanguageModelChatResponseOptions,
  model: OpenCodeModel
): PreparedChatRequest {
  return {
    ...preparedTools(options),
    ...preparedEffort(options),
    ...preparedPrompt(messages, model),
    ...preparedModel(model),
  };
}

interface StreamAttemptRequest {
  model: OpenCodeModel;
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
  safeToolFinish: boolean;
  replay?: SDKReplayCollector;
  report: StreamReportState;
  toolCalls: ToolCallStreamPart[];
}

function createStreamAttemptState(request: StreamAttemptRequest): StreamAttemptState {
  const { model, sessionId, diagnosticsLog, prepared } = request;
  const toolCalls: ToolCallStreamPart[] = [];
  return {
    attemptText: '',
    finished: false,
    safeToolFinish: false,
    replay: model.apiType === 'google' || model.apiType === 'messages' ? new SDKReplayCollector() : undefined,
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
  return part.type === 'finish';
}

async function requestStream(request: StreamAttemptRequest): Promise<AsyncIterable<LanguageModelV3StreamPart>> {
  const { model, apiKey, sessionId, options, streamPolicy, prepared, controller } = request;
  const timedModel = protocolModel(model, apiKey, streamPolicy);
  const { stream } = await timedModel.doStream({
    prompt: prepared.prompt,
    tools: prepared.tools,
    toolChoice: { type: options.toolMode === vscode.LanguageModelChatToolMode.Required ? 'required' : 'auto' },
    maxOutputTokens: model.maxOutputTokens,
    headers: { 'x-opencode-session': sessionId, 'User-Agent': extensionUserAgent() },
    abortSignal: controller.signal,
    includeRawChunks: model.apiType !== 'messages' && model.apiType !== 'google',
    providerOptions: sdkProviderOptions(model, prepared.effort),
  });
  return stream;
}

function finishTerminal(
  part: Extract<LanguageModelV3StreamPart, { type: 'finish' }>,
  progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  state: StreamAttemptState
): void {
  state.safeToolFinish = part.finishReason.unified === 'stop' || part.finishReason.unified === 'tool-calls';
  reportPart(part, progress, state.report);
}

function reportAttemptPart(
  part: LanguageModelV3StreamPart,
  progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  state: StreamAttemptState
): boolean {
  state.replay?.observe(part);
  if (part.type === 'text-delta' && part.delta) state.attemptText += part.delta;
  if (part.type === 'raw') reportPart(part, progress, state.report);
  if (isTerminalPart(part)) {
    state.finished = true;
    if (part.type === 'finish') finishTerminal(part, progress, state);
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

function completedNativeTools(request: StreamAttemptRequest, state: StreamAttemptState): void {
  if (!state.toolCalls.length) return;
  const native = request.model.apiType === 'google' || request.model.apiType === 'messages';
  if (native && !state.safeToolFinish) {
    request.progress.report(new vscode.LanguageModelTextPart(
      '\n\nOpenCode: The response was incomplete; tool calls were not executed.'
    ));
    return;
  }
  if (native) {
    if (!thinkingPart || !state.replay) {
      throw new Error('This VS Code host cannot preserve native tool replay metadata.');
    }
    request.progress.report(new thinkingPart('', `opencode-native-replay-${randomUUID()}`, {
      opencodeNativeReplay: {
        modelId: request.model.id,
        providerPackage: request.model.providerPackage,
        content: state.replay.snapshot(),
      },
    }));
  }
  reportToolCalls(state.toolCalls, request.progress);
}

function handleStreamTimeout(
  request: StreamAttemptRequest,
  state: StreamAttemptState
): string | undefined {
  if (state.report.diagnostics) {
    summarizeStream(state.report.diagnostics, state.finished ? 'completed' : 'aborted');
  }
  if (state.toolCalls.length) {
    completedNativeTools(request, state);
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
    completedNativeTools(request, state);
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
  model: OpenCodeModel,
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
  private readonly useConfiguredTimeout: boolean;

  constructor(
    private readonly context: Pick<vscode.ExtensionContext, 'secrets'> & Partial<Pick<vscode.ExtensionContext, 'globalState'>>,
    private readonly log?: (message: string) => void,
    streamPolicy: Partial<ChatStreamPolicy> = {}
  ) {
    this.identities = new ConversationIdentity(context.globalState);
    this.streamPolicy = { ...defaultChatStreamPolicy, ...streamPolicy };
    this.useConfiguredTimeout = streamPolicy.chunkTimeoutMs === undefined;
  }

  updateModels(models: OpenCodeModel[]): void {
    this.models = models.map((model) => ({
      ...model, family: model.family ?? model.id, version: '1.0',
      capabilities: { toolCalling: model.toolCalling, imageInput: model.vision, thinking: model.thinking },
      configurationSchema: modelConfigurationSchema(model),
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
      const prepared = prepareChatRequest(messages, options, model);
      const streamPolicy = this.useConfiguredTimeout
        ? { ...this.streamPolicy, chunkTimeoutMs: configuredStreamIdleTimeoutMs() }
        : this.streamPolicy;
      await runChatStream(
        model,
        apiKey,
        sessionId,
        options,
        progress,
        token,
        streamPolicy,
        this.log,
        prepared,
        (controller) => { activeController = controller; }
      );
    } catch (error) {
      if (!reportSDKError(error, model.id, progress)) throw error;
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
    return Promise.resolve(Math.max(1, Math.ceil(Buffer.byteLength(text, 'utf8') / 4)));
  }

  dispose(): void { this.changed.dispose(); }
}
