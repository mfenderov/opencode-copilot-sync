export interface EnrichOptions {
  isGo?: boolean;
  isFree?: boolean;
  suffix?: string;
  modelsDevData?: Record<string, any>;
}

export interface CustomEndpointModel {
  id: string;
  name: string;
  url: string;
  family?: string;
  apiType: 'chat-completions';
  toolCalling: boolean;
  vision: boolean;
  contextWindow: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  thinking: boolean;
  supportsReasoningEffort?: string[];
  reasoningEffortFormat?: 'chat-completions';
  requestHeaders?: Record<string, string>;
  modelOptions?: {
    temperature: number | null;
    top_p: number | null;
  };
}

export function formatModelName(id: string, suffix: string = '(OpenCode)'): string {
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
  const isFree = options.isFree ?? false;
  const baseUrl = isGo
    ? 'https://opencode.ai/zen/go/v1/chat/completions'
    : 'https://opencode.ai/zen/v1/chat/completions';

  const defaultSuffix = isGo ? '(OpenCode Go)' : isFree ? '(OpenCode Free)' : '(OpenCode Zen)';
  const suffix = options.suffix || defaultSuffix;
  const name = formatModelName(modelId, suffix);
  const lower = modelId.toLowerCase();

  let contextWindow = 1048576;
  let maxOutputTokens = 65536;
  let vision = false;
  let thinking = true;

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
    thinking = false;
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

  const maxInputTokens = contextWindow - maxOutputTokens;

  const model: CustomEndpointModel = {
    id: modelId,
    name,
    family: 'gpt-5-5',
    url: baseUrl,
    apiType: 'chat-completions',
    toolCalling: true,
    vision,
    contextWindow,
    maxInputTokens,
    maxOutputTokens,
    thinking,
    supportsReasoningEffort: thinking ? ['low', 'medium', 'high', 'xhigh', 'max'] : undefined,
    reasoningEffortFormat: thinking ? 'chat-completions' : undefined,
    modelOptions: {
      temperature: null,
      top_p: null,
    },
  };

  if (isGo || isFree) {
    model.requestHeaders = {
      'x-opencode-session': 'vscode-copilot',
    };
  }

  return model;
}
