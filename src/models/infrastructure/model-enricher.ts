import { isFreeTierModel, type ModelDevMetadata } from './models-dev-client.js';
import { resolveModelTokenLimits } from '../domain/token-budget.js';

export interface EnrichOptions {
  isGo?: boolean;
  isFree?: boolean;
  suffix?: string;
  modelsDevData?: ModelDevMetadata;
}

export interface CustomEndpointModel {
  id: string;
  name: string;
  url: string;
  family?: string;
  apiType: 'chat-completions' | 'messages' | 'responses';
  toolCalling: boolean;
  vision: boolean;
  contextWindow: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  thinking: boolean;
  supportsReasoningEffort?: string[];
  reasoningEffortFormat?: string;
  requestHeaders?: Record<string, string>;
  isFree?: boolean;
  modelOptions?: {
    temperature: number | null;
    top_p: number | null;
  };
}

export function formatModelName(id: string, suffix = '(OpenCode)'): string {
  // Normalize version patterns like "-4-6", "-1-3", "-2-7" to "-4.6"
  const normalized = id.replace(/-(\d+)-(\d+)(?=-|$)/g, '-$1.$2');
  const parts = normalized.split(/[-_]/);
  const title = parts
    .map((p) => {
      const lower = p.toLowerCase();
      if (lower === 'glm') return 'GLM';
      if (lower === 'gpt') return 'GPT';
      if (lower === 'mimo') return 'MiMo';
      if (lower === 'qwen') return 'Qwen';
      if (lower === 'kimi') return 'Kimi';
      if (lower === 'minimax') return 'MiniMax';
      if (lower === 'deepseek') return 'DeepSeek';
      if (lower === 'gemini') return 'Gemini';
      if (lower === 'claude') return 'Claude';
      if (lower === 'grok') return 'Grok';
      if (lower === 'nemotron') return 'Nemotron';
      if (lower === 'muse') return 'Muse';
      if (lower === 'spark') return 'Spark';
      if (lower === 'contributor') return 'Contributor';
      if (lower === 'free') return 'Free';
      if (/^v\d+/i.test(p)) return p.toUpperCase();
      return p.charAt(0).toUpperCase() + p.slice(1);
    })
    .join(' ');
  return `${title} ${suffix}`;
}

export function enrichModel(modelId: string, options: EnrichOptions = {}): CustomEndpointModel {
  const isGo = options.isGo ?? true;
  const devMeta = options.modelsDevData;
  const isFree = options.isFree ?? (isGo ? false : isFreeTierModel(modelId, devMeta));
  const lower = modelId.toLowerCase();

  // 1. Determine transport dynamically: check provider hint from models.dev first
  const isResponses =
    devMeta?.provider?.npm === '@ai-sdk/openai' ||
    lower.includes('muse') ||
    lower.includes('gpt-') ||
    lower.includes('grok-');

  const isMessages =
    devMeta?.provider?.npm === '@ai-sdk/anthropic' ||
    lower.includes('claude');

  let apiType: 'chat-completions' | 'messages' | 'responses' = 'chat-completions';
  let modelUrl: string;

  if (isMessages) {
    apiType = 'messages';
    modelUrl = isGo ? 'https://opencode.ai/zen/go/v1' : 'https://opencode.ai/zen/v1';
  } else if (isResponses) {
    apiType = 'responses';
    modelUrl = isGo ? 'https://opencode.ai/zen/go/v1' : 'https://opencode.ai/zen/v1';
  } else {
    apiType = 'chat-completions';
    modelUrl = isGo
      ? 'https://opencode.ai/zen/go/v1/chat/completions'
      : 'https://opencode.ai/zen/v1/chat/completions';
  }

  const defaultSuffix = isGo ? '(OpenCode Go)' : isFree ? '(OpenCode Free)' : '(OpenCode Zen)';
  const suffix = options.suffix ?? defaultSuffix;
  const name = formatModelName(modelId, suffix);

  // 2. Derive limits and capabilities dynamically from models.dev if available
  let contextWindow = devMeta?.limit?.context ?? 1048576;
  let maxOutputTokens = devMeta?.limit?.output ?? 65536;
  let vision = devMeta?.modalities?.input?.includes('image') ?? false;
  let thinking = devMeta?.reasoning ?? true;

  if (!devMeta) {
    if (lower.includes('deepseek')) {
      contextWindow = 1048576;
      maxOutputTokens = 131072;
      vision = lower.includes('vision');
    } else if (lower.includes('glm')) {
      contextWindow = 1048576;
      maxOutputTokens = 131072;
      vision = true;
    } else if (lower.includes('kimi')) {
      contextWindow = 1048576;
      maxOutputTokens = 65536;
      vision = true;
    } else if (lower.includes('qwen')) {
      contextWindow = 1000000;
      maxOutputTokens = 131072;
      vision = true;
      thinking = false;
    } else if (lower.includes('minimax')) {
      contextWindow = 1048576;
      maxOutputTokens = 131072;
      vision = false;
      thinking = false;
    } else if (lower.includes('claude')) {
      if (lower.includes('haiku')) {
        contextWindow = 200000;
        maxOutputTokens = 64000;
        thinking = false;
      } else {
        contextWindow = 1000000;
        maxOutputTokens = 128000;
        thinking = true;
      }
      vision = true;
    } else if (lower.includes('gpt')) {
      if (lower.includes('mini') || lower.includes('nano')) {
        contextWindow = 128000;
        maxOutputTokens = 16384;
      } else {
        contextWindow = 1000000;
        maxOutputTokens = 128000;
      }
      vision = true;
      thinking = true;
    } else if (lower.includes('gemini')) {
      contextWindow = 1000000;
      maxOutputTokens = 65536;
      vision = true;
      thinking = lower.includes('thinking');
    } else if (lower.includes('grok')) {
      contextWindow = 1000000;
      maxOutputTokens = 65536;
      vision = true;
      thinking = true;
    } else if (lower.includes('mimo')) {
      contextWindow = 1048576;
      maxOutputTokens = 65536;
      vision = lower.includes('omni');
      thinking = true;
    } else if (lower.includes('nemotron')) {
      contextWindow = 1000000;
      maxOutputTokens = 128000;
      vision = false;
      thinking = true;
    } else if (lower.includes('muse')) {
      contextWindow = 1000000;
      maxOutputTokens = 65536;
      vision = false;
      thinking = true;
    } else if (lower.includes('longcat')) {
      contextWindow = 1048576;
      maxOutputTokens = 65536;
      vision = false;
      thinking = false;
    } else if (lower.includes('omen') || lower.includes('hy4')) {
      contextWindow = 1048576;
      maxOutputTokens = 65536;
      vision = false;
      thinking = true;
    }
  }

  const tokenLimits = resolveModelTokenLimits(contextWindow, maxOutputTokens);
  contextWindow = tokenLimits.contextWindow;
  maxOutputTokens = tokenLimits.maxOutputTokens;
  const maxInputTokens = tokenLimits.maxInputTokens;
  let supportsReasoningEffort: string[] | undefined = undefined;

  if (thinking) {
    const devEffortOpt = devMeta?.reasoning_options?.find((o) => o.type === 'effort');
    if (devEffortOpt && Array.isArray(devEffortOpt.values)) {
      const filtered = devEffortOpt.values.filter((v: string) => v !== 'none');
      if (filtered.length > 0) {
        supportsReasoningEffort = filtered;
      }
    } else if (!devMeta) {
      // Fallback heuristics only when models.dev metadata is unavailable
      if (isResponses) {
        supportsReasoningEffort = ['minimal', 'low', 'medium', 'high', 'xhigh'];
      } else if (lower.includes('deepseek') || lower.includes('kimi-k3') || lower.includes('glm')) {
        supportsReasoningEffort = ['low', 'medium', 'high', 'max'];
      }
    }
  }

  const model: CustomEndpointModel = {
    id: modelId,
    name,
    // Stable per-model family matching the VERIFIED_OPENCODE_MODELS convention (family = id).
    family: modelId,
    url: modelUrl,
    apiType,
    toolCalling: true,
    vision,
    contextWindow,
    maxInputTokens,
    maxOutputTokens,
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
