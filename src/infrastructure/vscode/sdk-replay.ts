import { Buffer } from 'node:buffer';
import { isDeepStrictEqual } from 'node:util';
import { isJSONObject } from '@ai-sdk/provider';
import type {
  LanguageModelV3Prompt,
  LanguageModelV3StreamPart,
  SharedV3ProviderOptions,
} from '@ai-sdk/provider';
import type { OpenCodeModel } from '../../models/domain/model.js';
import { hostDataBytes } from './sdk-content.js';

type AssistantContent = Extract<LanguageModelV3Prompt[number], { role: 'assistant' }>['content'];
type TextBlock = Extract<AssistantContent[number], { type: 'text' | 'reasoning' }>;
type ToolCall = Extract<AssistantContent[number], { type: 'tool-call' }>;
type ToolCallStreamPart = Extract<LanguageModelV3StreamPart, { type: 'tool-call' }>;
type TextStreamPart = Extract<LanguageModelV3StreamPart, {
  type: 'text-start' | 'text-delta' | 'text-end' | 'reasoning-start' | 'reasoning-delta' | 'reasoning-end';
}>;

function recordObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function isTextStreamPart(part: LanguageModelV3StreamPart): part is TextStreamPart {
  return part.type === 'text-start' || part.type === 'text-delta' || part.type === 'text-end' ||
    part.type === 'reasoning-start' || part.type === 'reasoning-delta' || part.type === 'reasoning-end';
}

export function sdkToolInput(part: ToolCallStreamPart): Record<string, unknown> {
  let input: unknown;
  try {
    input = JSON.parse(part.input);
  } catch {
    throw new Error(`Invalid tool arguments for ${part.toolName}.`);
  }
  const recordInput = recordObject(input);
  if (!recordInput) throw new Error(`Invalid tool arguments for ${part.toolName}.`);
  return recordInput;
}

function mergeOptions(
  current: SharedV3ProviderOptions | undefined,
  incoming: SharedV3ProviderOptions | undefined
): SharedV3ProviderOptions | undefined {
  if (!incoming) return current;
  const result = { ...current };
  for (const [provider, value] of Object.entries(incoming)) {
    result[provider] = { ...result[provider], ...value };
  }
  return result;
}

export class SDKReplayCollector {
  private readonly content: AssistantContent = [];
  private readonly blocks = new Map<string, TextBlock>();

  observe(part: LanguageModelV3StreamPart): void {
    if (isTextStreamPart(part)) {
      this.observeText(part);
    } else if (part.type === 'tool-call') {
      this.content.push({
        type: 'tool-call', toolCallId: part.toolCallId, toolName: part.toolName,
        input: sdkToolInput(part), providerOptions: part.providerMetadata,
      });
    } else if (part.type === 'file') {
      this.content.push({
        type: 'file', mediaType: part.mediaType,
        data: typeof part.data === 'string' ? part.data : Buffer.from(part.data).toString('base64'),
        providerOptions: part.providerMetadata,
      });
    }
  }

  private observeText(part: TextStreamPart): void {
    const type = part.type.startsWith('reasoning-') ? 'reasoning' : 'text';
    const key = `${type}:${part.id}`;
    const block = this.textBlock(key, type);
    if ('delta' in part) block.text += part.delta;
    block.providerOptions = mergeOptions(block.providerOptions, part.providerMetadata);
  }

  private textBlock(key: string, type: 'text' | 'reasoning'): TextBlock {
    const existing = this.blocks.get(key);
    if (existing) return existing;
    const block: TextBlock = type === 'text' ? { type: 'text', text: '' } : { type: 'reasoning', text: '' };
    this.blocks.set(key, block);
    this.content.push(block);
    return block;
  }

  snapshot(): AssistantContent {
    return this.content;
  }
}

function validProviderOptions(value: unknown): value is SharedV3ProviderOptions {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    Object.values(value).every((item) => !!item && typeof item === 'object' && !Array.isArray(item) && isJSONObject(item));
}

function providerOptions(value: unknown): SharedV3ProviderOptions | undefined {
  if (value === undefined) return undefined;
  if (!validProviderOptions(value)) {
    throw new Error('Invalid native tool replay metadata.');
  }
  return value;
}

interface StoredText {
  text: string;
  providerOptions: SharedV3ProviderOptions | undefined;
}

function storedText(part: Record<string, unknown>): StoredText | undefined {
  if (part.type !== 'text' && part.type !== 'reasoning') return undefined;
  return typeof part.text === 'string'
    ? { text: part.text, providerOptions: providerOptions(part.providerOptions) }
    : undefined;
}

function toTextContent(
  kind: 'text' | 'reasoning',
  file: StoredText
): Extract<AssistantContent[number], { type: 'text' | 'reasoning' }> {
  return { type: kind, text: file.text, providerOptions: file.providerOptions };
}

function textReplayPart(
  part: Record<string, unknown>,
  options: SharedV3ProviderOptions | undefined
): AssistantContent[number] | undefined {
  const stored = storedText(part);
  return stored && stored.providerOptions === options
    ? toTextContent(part.type as 'text' | 'reasoning', stored)
    : undefined;
}

function toolReplayPart(
  part: Record<string, unknown>,
  options: SharedV3ProviderOptions | undefined
): AssistantContent[number] | undefined {
  if (part.type === 'tool-call' && typeof part.toolCallId === 'string' &&
    typeof part.toolName === 'string' && recordObject(part.input)) {
    return { type: 'tool-call', toolCallId: part.toolCallId, toolName: part.toolName, input: part.input, providerOptions: options };
  }
  return undefined;
}

interface StoredFile {
  mediaType: string;
  data: string;
  providerOptions: SharedV3ProviderOptions | undefined;
}

function fileReplyPart(part: Record<string, unknown>): StoredFile | undefined {
  if (part.type !== 'file') return undefined;
  const mediaType = typeof part.mediaType === 'string' ? part.mediaType : undefined;
  const data = typeof part.data === 'string' ? part.data : undefined;
  return mediaType && data
    ? { mediaType, data, providerOptions: providerOptions(part.providerOptions) }
    : undefined;
}

function toFileContent(file: StoredFile): Extract<AssistantContent[number], { type: 'file' }> {
  return { type: 'file', mediaType: file.mediaType, data: file.data, providerOptions: file.providerOptions };
}

function fileReplayPart(
  part: Record<string, unknown>,
  options: SharedV3ProviderOptions | undefined
): AssistantContent[number] | undefined {
  const file = fileReplyPart(part);
  return file && file.providerOptions === options ? toFileContent(file) : undefined;
}

function replayContent(value: unknown): AssistantContent {
  if (!Array.isArray(value)) throw new Error('Invalid native tool replay content.');
  return value.map((part: unknown): AssistantContent[number] => {
    const recordPart = recordObject(part);
    if (!recordPart) throw new Error('Invalid native tool replay content.');
    const options = providerOptions(recordPart.providerOptions);
    return textReplayPart(recordPart, options) ?? toolReplayPart(recordPart, options) ??
      fileReplayPart(recordPart, options) ?? (() => { throw new Error('Invalid native tool replay content.'); })();
  });
}

function replayForModel(
  replay: Record<string, unknown>,
  model: Pick<OpenCodeModel, 'id' | 'providerPackage'>
): AssistantContent | undefined {
  return replay.modelId === model.id && replay.providerPackage === model.providerPackage
    ? replayContent(replay.content)
    : undefined;
}

function replayMetadata(part: unknown): Record<string, unknown> | undefined {
  const metadata = recordObject(recordObject(part)?.metadata);
  const replay = metadata && recordObject(metadata.opencodeNativeReplay);
  return replay ?? undefined;
}

export function nativeReplay(
  parts: readonly unknown[],
  model: Pick<OpenCodeModel, 'id' | 'providerPackage'> | undefined
): AssistantContent | undefined {
  if (!model) return undefined;
  for (const part of parts) {
    const replay = replayMetadata(part);
    if (replay) {
      const restored = replayForModel(replay, model);
      if (restored) return restored;
    }
  }
  return undefined;
}

function toolCalls(content: AssistantContent): ToolCall[] {
  return content.filter((part): part is ToolCall => part.type === 'tool-call');
}

function fileData(content: AssistantContent): { mediaType: string; data: string }[] {
  return content.flatMap((part) => {
    if (part.type !== 'file' || part.data instanceof URL) return [];
    const bytes = typeof part.data === 'string' ? hostDataBytes(part.data) : part.data;
    return [{ mediaType: part.mediaType, data: Buffer.from(bytes).toString('base64') }];
  });
}

export function restoreNativeReplay(current: AssistantContent, saved: AssistantContent): AssistantContent {
  const visible = (content: AssistantContent) => content
    .filter((part) => part.type === 'text').map((part) => part.text).join('');
  const calls = (content: AssistantContent) => toolCalls(content)
    .map((part) => ({ id: part.toolCallId, name: part.toolName, input: part.input }));
  if (visible(current) !== visible(saved) || !isDeepStrictEqual(calls(current), calls(saved)) ||
    !isDeepStrictEqual(fileData(current), fileData(saved))) {
    throw new Error('Cannot replay native tool calls after their assistant message was changed.');
  }
  return saved;
}
