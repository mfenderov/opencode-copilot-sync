export function modelMetadata(id, overrides = {}) {
  return {
    id,
    name: id,
    limit: { context: 1048576, input: 983040, output: 65536 },
    modalities: { input: ['text'], output: ['text'] },
    reasoning: false,
    tool_call: true,
    ...overrides,
  };
}

export function catalogMetadata(goIds = [], zenIds = []) {
  return {
    go: {
      npm: '@ai-sdk/openai-compatible',
      api: 'https://opencode.ai/inference/go/openai/v1',
      models: Object.fromEntries(goIds.map((id) => [id, modelMetadata(id)])),
    },
    zen: {
      npm: '@ai-sdk/openai-compatible',
      api: 'https://opencode.ai/inference/openai/v1',
      models: Object.fromEntries(zenIds.map((id) => [id, modelMetadata(id)])),
    },
  };
}

export function metadataResponse(goIds = [], zenIds = []) {
  const { go, zen } = catalogMetadata(goIds, zenIds);
  return { opencode: zen, 'opencode-go': go };
}

export function mirrorProvider(name, apiKey, ids, options = {}) {
  const base = options.isGo === false
    ? 'https://opencode.ai/inference/openai/v1'
    : 'https://opencode.ai/inference/go/openai/v1';
  return {
    name,
    vendor: 'customendpoint',
    apiKey,
    apiType: 'chat-completions',
    models: ids.map((id) => ({
      id,
      name: id,
      family: id,
      url: `${base}/chat/completions`,
      apiType: 'chat-completions',
      toolCalling: true,
      vision: false,
      thinking: false,
      contextWindow: 1048576,
      maxInputTokens: 983040,
      maxOutputTokens: 65536,
    })),
  };
}
