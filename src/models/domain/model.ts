// Models domain: model identity types.
export interface OpenCodeModelMeta {
  id: string;
  name: string;
  family: string;
  catalog?: 'go' | 'zen';
  isFree?: boolean;
  contextWindow: number;
  maxOutputTokens: number;
  vision: boolean;
  thinking?: boolean;
  supportsReasoningEffort?: string[];
  defaultReasoningEffort?: string;
  apiType?: 'chat-completions' | 'messages' | 'responses';
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
