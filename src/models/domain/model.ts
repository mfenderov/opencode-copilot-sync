// Models domain: model identity types.
export interface OpenCodeModelMeta {
  id: string;
  name: string;
  family: string;
  catalog?: 'go' | 'zen';
  contextWindow: number;
  maxOutputTokens: number;
  vision: boolean;
  thinking?: boolean;
  supportsReasoningEffort?: string[];
  defaultReasoningEffort?: string;
  apiType?: 'chat-completions' | 'messages' | 'responses';
}

export type OpenCodeApiType = 'chat-completions' | 'messages' | 'responses' | 'google';
export type OpenCodeProviderPackage =
  | '@ai-sdk/openai-compatible'
  | '@ai-sdk/openai'
  | '@ai-sdk/anthropic'
  | '@ai-sdk/google'
  | '@ai-sdk/mistral';

export interface CustomEndpointModel {
  id: string;
  name: string;
  url: string;
  family?: string;
  apiType: 'chat-completions' | 'messages' | 'responses';
  statefulResponses?: boolean;
  toolCalling: boolean;
  vision: boolean;
  contextWindow: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  thinking: boolean;
  supportsReasoningEffort?: string[];
  reasoningEffortFormat?: string;
  modelOptions?: {
    temperature: number | null;
    top_p: number | null;
  };
}

export interface OpenCodeModel extends Omit<CustomEndpointModel, 'apiType'> {
  apiType: OpenCodeApiType;
  providerPackage: OpenCodeProviderPackage;
  catalog: 'go' | 'zen';
}

export function toCustomEndpointModel(model: OpenCodeModel): CustomEndpointModel | undefined {
  if (model.apiType === 'google') return undefined;
  const { providerPackage: _providerPackage, catalog: _catalog, ...compatible } = model;
  return {
    ...compatible,
    apiType: model.apiType,
    url: model.apiType === 'chat-completions' ? `${model.url.replace(/\/$/, '')}/chat/completions` : model.url,
  };
}
