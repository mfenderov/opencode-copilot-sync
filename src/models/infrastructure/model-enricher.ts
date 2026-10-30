import { resolveModelTokenLimits } from '../domain/token-budget.js';
import type { OpenCodeApiType, OpenCodeModel, OpenCodeProviderPackage } from '../domain/model.js';
import type { ModelDevMetadata, ModelProviderMetadata } from './models-dev-client.js';

import { PROVIDER_PROTOCOLS } from '../../infrastructure/vscode/open-code-chat-adapter.js';

export class ModelMetadataError extends Error {}

export interface EnrichOptions {
  isGo: boolean;
  provider: ModelProviderMetadata;
  modelsDevData: unknown;
}

function providerProtocol(value: string): { providerPackage: OpenCodeProviderPackage; apiType: OpenCodeApiType } {
  if (!Object.hasOwn(PROVIDER_PROTOCOLS, value)) throw new ModelMetadataError(`Unsupported provider SDK: ${value}.`);
  const providerPackage = value as OpenCodeProviderPackage;
  return { providerPackage, apiType: PROVIDER_PROTOCOLS[providerPackage] };
}

function trustedEndpoint(value: string): string {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new ModelMetadataError('Invalid OpenCode provider endpoint.');
  }
  if (endpoint.protocol !== 'https:' || endpoint.hostname !== 'opencode.ai' ||
    endpoint.port || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new ModelMetadataError(`Untrusted OpenCode provider endpoint: ${endpoint.origin}.`);
  }
  return endpoint.toString().replace(/\/$/, '');
}

interface ValidatedCapabilities {
  toolCall: boolean;
  reasoning: boolean;
  input: string[];
  name: string | undefined;
}

function checkedCapabilities(metadata: ModelDevMetadata, modelId: string): ValidatedCapabilities {
  if (typeof metadata.tool_call !== 'boolean' || typeof metadata.reasoning !== 'boolean' ||
    !Array.isArray(metadata.modalities?.input)) {
    throw new ModelMetadataError(`Missing capabilities for model ${modelId}.`);
  }
  return {
    toolCall: metadata.tool_call,
    reasoning: metadata.reasoning,
    input: metadata.modalities.input,
    name: metadata.name,
  };
}

function checkedId(metadata: ModelDevMetadata, modelId: string): void {
  if (metadata.id !== undefined && metadata.id !== modelId) {
    throw new ModelMetadataError(`Metadata ID does not match model ${modelId}.`);
  }
}

function validEffortValues(values: unknown): values is string[] {
  return Array.isArray(values) && values.every((value) => typeof value === 'string');
}

function withoutNone(values: string[]): string[] | undefined {
  const kept = values.filter((value) => value !== 'none');
  return kept.length ? kept : undefined;
}

function reasoningEfforts(metadata: ModelDevMetadata): string[] | undefined {
  if (!metadata.reasoning) return undefined;
  const effort = metadata.reasoning_options?.find((option) => option.type === 'effort');
  if (!effort?.values) return undefined;
  if (!validEffortValues(effort.values)) {
    throw new ModelMetadataError('Invalid reasoning effort metadata.');
  }
  return withoutNone(effort.values);
}

function asMetadata(raw: unknown, modelId: string): ModelDevMetadata {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ModelMetadataError(`Missing metadata for model ${modelId}.`);
  }
  return raw as ModelDevMetadata;
}

function modelEndpoints(
  metadata: ModelDevMetadata,
  provider: ModelProviderMetadata
): { providerPackage: OpenCodeProviderPackage; apiType: OpenCodeApiType; url: string } {
  const { providerPackage, apiType } = providerProtocol(metadata.provider?.npm ?? provider.npm);
  return { providerPackage, apiType, url: trustedEndpoint(metadata.provider?.api ?? provider.api) };
}

function modelTokenLimits(metadata: ModelDevMetadata, modelId: string): ReturnType<typeof resolveModelTokenLimits> {
  try {
    return resolveModelTokenLimits(metadata.limit?.context, metadata.limit?.output, metadata.limit?.input);
  } catch (error) {
    if (error instanceof RangeError) throw new ModelMetadataError(`${modelId}: ${error.message}`);
    throw error;
  }
}

export function enrichModel(modelId: string, options: EnrichOptions): OpenCodeModel {
  const metadata = asMetadata(options.modelsDevData, modelId);
  checkedId(metadata, modelId);
  const capabilities = checkedCapabilities(metadata, modelId);
  const endpoints = modelEndpoints(metadata, options.provider);
  const isGo = options.isGo;

  return {
    id: modelId,
    name: `${capabilities.name ?? modelId} (OpenCode ${isGo ? 'Go' : 'Zen'})`,
    family: modelId,
    catalog: isGo ? 'go' : 'zen',
    ...endpoints,
    ...(endpoints.apiType === 'responses' ? { statefulResponses: false } : {}),
    toolCalling: capabilities.toolCall,
    vision: capabilities.input.includes('image'),
    thinking: capabilities.reasoning,
    ...modelTokenLimits(metadata, modelId),
    supportsReasoningEffort: reasoningEfforts(metadata),
    reasoningEffortFormat: endpoints.apiType,
    modelOptions: { temperature: null, top_p: null },
  };
}
