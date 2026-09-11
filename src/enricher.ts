export interface EnrichOptions {
  isGo?: boolean;
  isFree?: boolean;
  modelsDevData?: Record<string, any>;
}

export interface CustomEndpointModel {
  id: string;
  name: string;
  url: string;
  apiType: 'chat-completions';
  toolCalling: boolean;
  vision: boolean;
  contextWindow: number;
  maxOutputTokens: number;
  thinking: boolean;
  supportsReasoningEffort?: string[];
  reasoningEffortFormat?: 'chat-completions';
  requestHeaders?: Record<string, string>;
}

function formatModelName(id: string, suffix: string = '(OpenCode)'): string {
  // Convert "deepseek-v4-flash" -> "DeepSeek V4 Flash (OpenCode)"
  const parts = id.split(/[-_]/);
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

  const suffix = isFree ? '(Zen Free)' : '(OpenCode)';
  const name = formatModelName(modelId, suffix);
  const lower = modelId.toLowerCase();

  let contextWindow = 131072;
  let maxOutputTokens = 8192;
  let vision = false;
  let thinking = true;

  if (lower.includes('kimi') || lower.includes('minimax') || lower.includes('1m') || lower.includes('opus')) {
    contextWindow = 262144;
  }
  if (lower.includes('vision') || lower.includes('glm') || lower.includes('qwen') || lower.includes('kimi') || lower.includes('omni')) {
    vision = true;
  }

  const model: CustomEndpointModel = {
    id: modelId,
    name,
    url: baseUrl,
    apiType: 'chat-completions',
    toolCalling: true,
    vision,
    contextWindow,
    maxOutputTokens,
    thinking,
    supportsReasoningEffort: ['low', 'medium', 'high', 'xhigh', 'max'],
    reasoningEffortFormat: 'chat-completions',
  };

  if (isGo || isFree) {
    model.requestHeaders = {
      'x-opencode-session': 'vscode-copilot',
    };
  }

  return model;
}
