import { extensionUserAgent } from '../../extension-version.js';
import { fetchWithRetry } from '../../infrastructure/http/fetch-policy.js';

const CATALOG_FETCH_TIMEOUT_MS = 5_000;

export async function fetchOpenCodeModels(
  apiKey: string,
  catalog: 'go' | 'zen' = 'go'
): Promise<string[]> {
  const url = catalog === 'go'
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
  return json.data.map((model) => model.id).filter(Boolean);
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
  id?: string;
  name?: string;
  cost?: ModelCostMetadata;
  limit?: { context?: number; input?: number; output?: number };
  modalities?: { input?: string[]; output?: string[] };
  reasoning?: boolean;
  reasoning_options?: ModelReasoningOption[];
  tool_call?: boolean;
  provider?: { npm?: string; api?: string };
  [key: string]: unknown;
}

export interface ModelProviderMetadata {
  npm: string;
  api: string;
  models: Record<string, ModelDevMetadata>;
}

export interface CatalogModelMetadata {
  zen?: ModelProviderMetadata;
  go?: ModelProviderMetadata;
}

export function providerMetadata(value: unknown): ModelProviderMetadata | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const provider = value as Record<string, unknown>;
  if (typeof provider.npm !== 'string' || typeof provider.api !== 'string' ||
    !provider.models || typeof provider.models !== 'object' || Array.isArray(provider.models)) return undefined;
  return { npm: provider.npm, api: provider.api, models: provider.models as Record<string, ModelDevMetadata> };
}

async function fetchCatalogFrom(url: string): Promise<CatalogModelMetadata> {
  const res = await fetchWithRetry(
    url,
    { signal: AbortSignal.timeout(CATALOG_FETCH_TIMEOUT_MS) },
    { retries: 1, baseDelayMs: 200 }
  );
  if (!res.ok) throw new Error(`Metadata request failed (${res.status}).`);
  const raw: unknown = await res.json();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid metadata catalog.');
  const data = raw as Record<string, unknown>;
  const zen = providerMetadata(data.opencode);
  const go = providerMetadata(data['opencode-go']);
  if (!zen && !go) throw new Error('OpenCode provider metadata is missing.');
  return { zen, go };
}

export async function fetchModelsDevMetadata(): Promise<CatalogModelMetadata> {
  const failures: string[] = [];
  for (const url of ['https://models.opencode.ai/api.json', 'https://models.dev/api.json']) {
    try {
      return await fetchCatalogFrom(url);
    } catch (error) {
      failures.push(`${new URL(url).hostname}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`OpenCode model metadata is unavailable: ${failures.join('; ')}`);
}
