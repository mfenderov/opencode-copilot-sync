// Models infrastructure: model metadata enrichment.
import { isFreeTierModel, type ModelDevMetadata } from './models-dev-client.js';
import { resolveModelTokenLimits } from '../domain/token-budget.js';
import type { CustomEndpointModel } from '../domain/model.js';

export interface EnrichOptions {
  isGo?: boolean;
  isFree?: boolean;
  suffix?: string;
  modelsDevData?: ModelDevMetadata;
}

interface ModelCapabilities {
  contextWindow: number;
  maxOutputTokens: number;
  vision: boolean | ((id: string) => boolean);
  thinking: boolean | ((id: string) => boolean);
}

// Fallback capabilities used only when models.dev metadata is unavailable.
// Each family declares its known limits; vision/thinking may be a predicate
// over the model id for sub-variants (e.g. kimi omni, gemini thinking).
const FAMILY_CAPABILITIES: (readonly [RegExp, ModelCapabilities])[] = [
  [/deepseek/i, { contextWindow: 1048576, maxOutputTokens: 131072, vision: (id) => id.toLowerCase().includes('vision'), thinking: true }],
  [/glm/i, { contextWindow: 1048576, maxOutputTokens: 131072, vision: true, thinking: true }],
  [/kimi/i, { contextWindow: 1048576, maxOutputTokens: 65536, vision: true, thinking: true }],
  [/qwen/i, { contextWindow: 1000000, maxOutputTokens: 131072, vision: true, thinking: false }],
  [/minimax/i, { contextWindow: 1048576, maxOutputTokens: 131072, vision: false, thinking: false }],
  [/claude/i, { contextWindow: 1000000, maxOutputTokens: 128000, vision: true, thinking: (id) => !id.toLowerCase().includes('haiku') }],
  [/gpt/i, { contextWindow: 1000000, maxOutputTokens: 128000, vision: true, thinking: true }],
  [/gemini/i, { contextWindow: 1000000, maxOutputTokens: 65536, vision: true, thinking: (id) => id.toLowerCase().includes('thinking') }],
  [/grok/i, { contextWindow: 1000000, maxOutputTokens: 65536, vision: true, thinking: true }],
  [/mimo/i, { contextWindow: 1048576, maxOutputTokens: 65536, vision: (id) => id.toLowerCase().includes('omni'), thinking: true }],
  [/nemotron/i, { contextWindow: 1000000, maxOutputTokens: 128000, vision: false, thinking: true }],
  [/muse/i, { contextWindow: 1000000, maxOutputTokens: 65536, vision: false, thinking: true }],
  [/longcat/i, { contextWindow: 1048576, maxOutputTokens: 65536, vision: false, thinking: false }],
  [/(omen|hy4)/i, { contextWindow: 1048576, maxOutputTokens: 65536, vision: false, thinking: true }],
];

const SMALL_GPT_CONTEXT = 128000;
const SMALL_GPT_OUTPUT = 16384;

function resolveCapability<T>(value: T | ((id: string) => T), modelId: string): T {
  return typeof value === 'function' ? (value as (id: string) => T)(modelId) : value;
}

function fallbackCapabilities(modelId: string): { contextWindow: number; maxOutputTokens: number; vision: boolean; thinking: boolean } {
  const lower = modelId.toLowerCase();
  // Small GPT variants (mini/nano) carry a fraction of the full context.
  if (/gpt/i.test(modelId) && (lower.includes('mini') || lower.includes('nano'))) {
    return { contextWindow: SMALL_GPT_CONTEXT, maxOutputTokens: SMALL_GPT_OUTPUT, vision: true, thinking: true };
  }
  // Small Claude Haiku trades context for speed.
  if (/claude/i.test(modelId) && lower.includes('haiku')) {
    return { contextWindow: 200000, maxOutputTokens: 64000, vision: true, thinking: false };
  }
  for (const [pattern, caps] of FAMILY_CAPABILITIES) {
    if (pattern.test(modelId)) {
      return {
        contextWindow: caps.contextWindow,
        maxOutputTokens: caps.maxOutputTokens,
        vision: resolveCapability(caps.vision, modelId),
        thinking: resolveCapability(caps.thinking, modelId),
      };
    }
  }
  return { contextWindow: 1048576, maxOutputTokens: 65536, vision: false, thinking: true };
}

function resolveTransport(modelId: string, devMeta: ModelDevMetadata | undefined, isGo: boolean): { apiType: 'chat-completions' | 'messages' | 'responses'; modelUrl: string } {
  const lower = modelId.toLowerCase();
  const goBase = 'https://opencode.ai/zen/go/v1';
  const zenBase = 'https://opencode.ai/zen/v1';
  const isResponses =
    devMeta?.provider?.npm === '@ai-sdk/openai' ||
    lower.includes('muse') ||
    lower.includes('gpt-') ||
    lower.includes('grok-');
  const isMessages =
    devMeta?.provider?.npm === '@ai-sdk/anthropic' ||
    lower.includes('claude');
  if (isMessages) {
    return { apiType: 'messages', modelUrl: isGo ? goBase : zenBase };
  }
  if (isResponses) {
    return { apiType: 'responses', modelUrl: isGo ? goBase : zenBase };
  }
  return {
    apiType: 'chat-completions',
    modelUrl: isGo ? `${goBase}/chat/completions` : `${zenBase}/chat/completions`,
  };
}

function resolveReasoningEfforts(
  thinking: boolean,
  devMeta: ModelDevMetadata | undefined,
  isResponses: boolean,
  modelId: string
): string[] | undefined {
  if (!thinking) return undefined;
  const devEffortOpt = devMeta?.reasoning_options?.find((o) => o.type === 'effort');
  if (devEffortOpt && Array.isArray(devEffortOpt.values)) {
    const filtered = devEffortOpt.values.filter((v: string) => v !== 'none');
    if (filtered.length > 0) {
      return filtered;
    }
    return undefined;
  }
  // Fallback heuristics only when models.dev metadata is unavailable
  if (devMeta) return undefined;
  const lower = modelId.toLowerCase();
  if (isResponses) {
    return ['minimal', 'low', 'medium', 'high', 'xhigh'];
  }
  if (lower.includes('deepseek') || lower.includes('kimi-k3') || lower.includes('glm')) {
    return ['low', 'medium', 'high', 'max'];
  }
  return undefined;
}

const TITLE_CASE_EXCEPTIONS: Record<string, string> = {
  glm: 'GLM',
  gpt: 'GPT',
  mimo: 'MiMo',
  qwen: 'Qwen',
  kimi: 'Kimi',
  minimax: 'MiniMax',
  deepseek: 'DeepSeek',
  gemini: 'Gemini',
  claude: 'Claude',
  grok: 'Grok',
  nemotron: 'Nemotron',
  muse: 'Muse',
  spark: 'Spark',
  contributor: 'Contributor',
  free: 'Free',
};

function titleCasePart(part: string): string {
  const known = TITLE_CASE_EXCEPTIONS[part.toLowerCase()];
  if (known) return known;
  if (/^v\d+/i.test(part)) return part.toUpperCase();
  return part.charAt(0).toUpperCase() + part.slice(1);
}

export function formatModelName(id: string, suffix = '(OpenCode)'): string {
  // Normalize version patterns like "-4-6", "-1-3", "-2-7" to "-4.6"
  const normalized = id.replace(/-(\d+)-(\d+)(?=-|$)/g, '-$1.$2');
  const title = normalized.split(/[-_]/).map(titleCasePart).join(' ');
  return `${title} ${suffix}`;
}

interface ResolvedCapabilities {
  contextWindow: number;
  maxOutputTokens: number;
  vision: boolean;
  thinking: boolean;
}

function devCapability<T>(devValue: T | undefined, fallbackValue: T | undefined, defaultValue: T): T {
  return devValue ?? fallbackValue ?? defaultValue;
}

function resolveCapabilities(
  devMeta: ModelDevMetadata | undefined,
  modelId: string
): ResolvedCapabilities {
  const fallback = !devMeta ? fallbackCapabilities(modelId) : undefined;
  return {
    contextWindow: devCapability(devMeta?.limit?.context, fallback?.contextWindow, 1048576),
    maxOutputTokens: devCapability(devMeta?.limit?.output, fallback?.maxOutputTokens, 65536),
    vision: devCapability(devMeta?.modalities?.input?.includes('image'), fallback?.vision, false),
    thinking: devCapability(devMeta?.reasoning, fallback?.thinking, true),
  };
}

export function enrichModel(modelId: string, options: EnrichOptions = {}): CustomEndpointModel {
  const isGo = options.isGo ?? true;
  const devMeta = options.modelsDevData;
  const isFree = options.isFree ?? (isGo ? false : isFreeTierModel(modelId, devMeta));

  const { apiType, modelUrl } = resolveTransport(modelId, devMeta, isGo);

  const defaultSuffix = isGo ? '(OpenCode Go)' : isFree ? '(OpenCode Free)' : '(OpenCode Zen)';
  const suffix = options.suffix ?? defaultSuffix;
  const name = formatModelName(modelId, suffix);

  // Derive limits and capabilities dynamically from models.dev if available,
  // else from the per-family fallback table.
  const { contextWindow, maxOutputTokens, vision, thinking } = resolveCapabilities(devMeta, modelId);

  const tokenLimits = resolveModelTokenLimits(contextWindow, maxOutputTokens);
  const supportsReasoningEffort = resolveReasoningEfforts(
    thinking,
    devMeta,
    apiType === 'responses',
    modelId
  );

  const model: CustomEndpointModel = {
    id: modelId,
    name,
    // Stable per-model family matching the VERIFIED_OPENCODE_MODELS convention (family = id).
    family: modelId,
    url: modelUrl,
    apiType,
    toolCalling: true,
    vision,
    contextWindow: tokenLimits.contextWindow,
    maxInputTokens: tokenLimits.maxInputTokens,
    maxOutputTokens: tokenLimits.maxOutputTokens,
    thinking,
    supportsReasoningEffort,
    reasoningEffortFormat: apiType,
    modelOptions: {
      temperature: null,
      top_p: null,
    },
    isFree,
  };

  if (isGo || isFree) {
    model.requestHeaders = {
      'x-opencode-session': 'vscode-copilot',
    };
  }

  return model;
}
