// Models infrastructure: model catalog HTTP clients.
import { extensionUserAgent } from '../../extension-version.js';
import { fetchWithRetry, isOfflineMode } from '../../infrastructure/http/fetch-policy.js';
import { withProxy } from '../../infrastructure/http/proxy-routing.js';

// Bound for catalog fetches: a hung connection must fail fast instead of
// stalling the whole startup sync past every retry budget.
const CATALOG_FETCH_TIMEOUT_MS = 5_000;

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
      'User-Agent': extensionUserAgent(),
    },
    signal: AbortSignal.timeout(CATALOG_FETCH_TIMEOUT_MS),
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

type ProviderCatalog = Record<string, { models?: Record<string, ModelDevMetadata> } | undefined>;

function collectFallbackModels(data: ProviderCatalog, result: Record<string, ModelDevMetadata>): void {
  // Gather all models across all providers as fallback
  for (const providerData of Object.values(data)) {
    if (providerData?.models) {
      for (const [mId, mData] of Object.entries(providerData.models)) {
        result[mId] ??= mData;
      }
    }
  }
}

function applyAuthoritativeModels(data: ProviderCatalog, result: Record<string, ModelDevMetadata>): void {
  // OpenCode providers are authoritative. OpenCode Go is applied last because
  // Go-only model IDs can be absent from the general OpenCode provider entry.
  for (const provider of ['opencode', 'opencode-go']) {
    const models = data[provider]?.models;
    if (models) {
      for (const [mId, mData] of Object.entries(models)) {
        result[mId] = mData;
      }
    }
  }
}

async function fetchCatalogFrom(url: string): Promise<Record<string, ModelDevMetadata> | undefined> {
  try {
    const res = await fetchWithRetry(
      url,
      { signal: AbortSignal.timeout(5000) },
      { retries: 1, baseDelayMs: 200 }
    );
    if (!res.ok) return undefined;
    const data = (await res.json()) as ProviderCatalog;
    const result: Record<string, ModelDevMetadata> = {};
    collectFallbackModels(data, result);
    applyAuthoritativeModels(data, result);
    return result;
  } catch {
    return undefined;
  }
}

export async function fetchModelsDevMetadata(): Promise<Record<string, ModelDevMetadata>> {
  const urls = ['https://models.opencode.ai/api.json', 'https://models.dev/api.json'];
  for (const url of urls) {
    const catalog = await fetchCatalogFrom(url);
    if (catalog) return catalog;
  }
  return {};
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

async function postBalanceProbe(apiKey: string): Promise<Response | undefined> {
  const url = 'https://opencode.ai/zen/v1/chat/completions';
  try {
    return await fetch(
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
  } catch {
    return undefined;
  }
}

async function isInsufficientBalance(res: Response): Promise<boolean> {
  const text = await res.text();
  return text.includes('Insufficient balance') || text.includes('CreditsError');
}

export async function checkZenBalance(apiKey: string): Promise<boolean> {
  if (isOfflineMode()) return false;
  const res = await postBalanceProbe(apiKey);
  if (!res) return false;
  if (res.status === 401) {
    return !(await isInsufficientBalance(res));
  }
  return res.status === 200 || res.status === 400;
}
