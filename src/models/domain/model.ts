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
