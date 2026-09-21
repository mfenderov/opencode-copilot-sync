import { fetchWithRetry, withProxy } from './network.js';

export async function fetchOpenCodeModels(
  apiKey: string,
  catalog: 'go' | 'zen' = 'go'
): Promise<string[]> {
  const url =
    catalog === 'go'
      ? 'https://opencode.ai/zen/go/v1/models'
      : 'https://opencode.ai/zen/v1/models';

  const res = await fetchWithRetry(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'User-Agent': 'vscode-copilot/1.0',
    },
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Failed to fetch models (${res.status} ${res.statusText}): ${errorText}`);
  }

  const json = (await res.json()) as { data?: { id: string }[] };
  if (!json.data || !Array.isArray(json.data)) {
    throw new Error('Invalid response structure: expected data array');
  }

  return json.data.map((m) => m.id).filter(Boolean);
}

export interface ModelCostMetadata {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
}

export interface ModelReasoningOption {
  type?: string;
  values?: string[];
  [key: string]: unknown;
}

export interface ModelDevMetadata {
  cost?: ModelCostMetadata;
  limit?: { context?: number; output?: number };
  modalities?: { input?: string[]; output?: string[] };
  reasoning?: boolean;
  reasoning_options?: ModelReasoningOption[];
  provider?: { npm?: string };
  [key: string]: unknown;
}

export async function fetchModelsDevMetadata(): Promise<Record<string, ModelDevMetadata>> {
  const urls = ['https://models.opencode.ai/api.json', 'https://models.dev/api.json'];
  for (const url of urls) {
    try {
      const res = await fetchWithRetry(
        url,
        { signal: AbortSignal.timeout(5000) },
        { retries: 1, baseDelayMs: 200 }
      );
      if (!res.ok) continue;
      const data = (await res.json()) as Record<string, { models?: Record<string, ModelDevMetadata> } | undefined>;
      const result: Record<string, ModelDevMetadata> = {};

      // 1. Gather all models across all providers as fallback
      for (const providerData of Object.values(data)) {
        if (providerData?.models) {
          for (const [mId, mData] of Object.entries(providerData.models)) {
            result[mId] ??= mData;
          }
        }
      }

      // 2. OpenCode provider is authoritative - overlay OpenCode-specific definitions
      if (data.opencode?.models) {
        for (const [mId, mData] of Object.entries(data.opencode.models)) {
          result[mId] = mData;
        }
      }

      return result;
    } catch {}
  }
  return {};
}

/**
 * Determines whether a model belongs to OpenCode's free tier.
 * Prioritizes authoritative cost metadata from models.dev / models.opencode.ai
 * (where free models have input: 0 and output: 0), falling back to name
 * heuristics when metadata is not provided or cost is undefined.
 */
export function isFreeTierModel(modelId: string, devMeta?: ModelDevMetadata): boolean {
  if (devMeta?.cost) {
    if (devMeta.cost.input === 0 && devMeta.cost.output === 0) {
      return true;
    }
    if (
      (typeof devMeta.cost.input === 'number' && devMeta.cost.input > 0) ||
      (typeof devMeta.cost.output === 'number' && devMeta.cost.output > 0)
    ) {
      return false;
    }
  }

  const lower = modelId.toLowerCase();
  return (
    lower.includes('free') ||
    lower.includes('community') ||
    lower === 'big-pickle'
  );
}

export function filterFreeModels(
  modelIds: string[],
  modelsDevMap?: Record<string, ModelDevMetadata>
): string[] {
  return modelIds.filter((id) => isFreeTierModel(id, modelsDevMap?.[id]));
}

export const KNOWN_UNAVAILABLE_MODELS = new Set([
  'gpt-5.6-luna',
  'grok-4.5',
  'grok-4.6',
  'kimi-k2.5',
  'glm-5',
  'qwen3.7-plus',
  'qwen3.5-plus',
  'mimo-v2-pro',
  'mimo-v2-omni',
  'hy3-preview',
  'minimax-m2.7',
]);

export function filterAvailableGoModels(modelIds: string[]): string[] {
  return modelIds.filter((id) => !KNOWN_UNAVAILABLE_MODELS.has(id));
}

export const filterAvailableModels = filterAvailableGoModels;

export async function checkZenBalance(apiKey: string): Promise<boolean> {
  const url = 'https://opencode.ai/zen/v1/chat/completions';
  try {
    const res = await fetch(
      url,
      await withProxy(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
        }),
        signal: AbortSignal.timeout(3000),
      })
    );
    if (res.status === 401) {
      const text = await res.text();
      if (text.includes('Insufficient balance') || text.includes('CreditsError')) {
        return false;
      }
    }
    return res.status === 200 || res.status === 400;
  } catch {
    return false;
  }
}
