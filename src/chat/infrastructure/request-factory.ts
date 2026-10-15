// Chat infrastructure: provider request construction and routing.
import { extensionUserAgent } from '../../extension-version.js';
import type { OpenCodeModelMeta } from '../../models/domain/model.js';
import type { FormattedMessage } from './message-mapper.js';
import { sanitizeResponsesInput } from './message-mapper.js';
import { isStaleReasoningInput, normalizeReasoningEffort } from './reasoning-controls.js';
import type { WireToolDefinition } from './tool-mapper.js';

/**
 * Determines whether a model speaks the OpenAI Responses API protocol.
 * Prefers authoritative `apiType` metadata (sourced from models.dev / the
 * live OpenCode catalog) when available, falling back to a name-based
 * heuristic only for models we have no metadata for yet.
 */
export function isResponsesModel(modelId: string, apiType?: string): boolean {
  if (apiType === 'responses') return true;
  if (apiType === 'chat-completions' || apiType === 'messages') return false;
  const lower = modelId.toLowerCase();
  return lower.includes('muse') || lower.includes('gpt-') || lower.includes('grok-');
}

/**
 * Determines whether a model belongs to the OpenCode Zen catalog, which
 * routes to https://opencode.ai/zen/v1 instead of the flat-rate Go gateway.
 * Routing follows the catalog the model synced from. IDs without metadata
 * fall back to a `-free` suffix check (the Zen catalog's legacy free IDs
 * live there regardless of tier policy) plus two named exceptions:
 * `big-pickle` and `grok-code`, which are Zen-only IDs without the suffix.
 * Everything else defaults to Go.
 */
export function isZenModel(modelId: string, meta?: OpenCodeModelMeta): boolean {
  if (meta?.catalog === 'zen') {
    return true;
  }
  if (meta?.catalog === 'go') {
    return false;
  }
  const lower = modelId.toLowerCase();
  return lower.endsWith('-free') || lower === 'big-pickle' || lower === 'grok-code';
}

export interface ProviderRequestInput {
  modelId: string;
  isResponses: boolean;
  isZen: boolean;
  formattedMessages: FormattedMessage[];
  toolsPayload: WireToolDefinition[] | undefined;
  responsesInput: unknown[];
  reasoningEffort: string | undefined;
}

export interface ProviderRequest {
  url: string;
  body: Record<string, unknown>;
}

export function createProviderRequest(input: ProviderRequestInput): ProviderRequest {
  const baseUrl = input.isZen
    ? 'https://opencode.ai/zen/v1'
    : 'https://opencode.ai/zen/go/v1';
  const url = input.isResponses ? `${baseUrl}/responses` : `${baseUrl}/chat/completions`;
  const reasoningPayload = normalizeReasoningEffort(input.reasoningEffort, input.isResponses);

  const sanitizedInput = sanitizeResponsesInput(input.responsesInput);
  const body: Record<string, unknown> = input.isResponses
    ? {
        model: input.modelId,
        input: sanitizedInput.length > 0
          ? sanitizedInput
          : input.formattedMessages.filter((message) => !isStaleReasoningInput(message)),
        tools: input.toolsPayload,
        stream: true,
        ...reasoningPayload,
      }
    : {
        model: input.modelId,
        messages: input.formattedMessages,
        tools: input.toolsPayload,
        stream: true,
        ...reasoningPayload,
      };

  return { url, body };
}

export function createOpenCodeRequestHeaders(
  apiKey: string,
  sessionId: string
): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'User-Agent': extensionUserAgent(),
    'x-opencode-session': sessionId,
  };
}
