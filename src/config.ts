import { enrichModel, type CustomEndpointModel } from './enricher.js';

export interface ProviderEntry {
  name: string;
  vendor: 'customendpoint';
  apiKey: string;
  apiType: 'chat-completions';
  models: CustomEndpointModel[];
  settings?: Record<string, any>;
}

export function buildProviderEntry(
  name: string,
  apiKey: string,
  modelIds: string[],
  options: { isGo?: boolean; isFree?: boolean } = { isGo: true }
): ProviderEntry {
  const models = modelIds.map((id) => enrichModel(id, options));

  return {
    name,
    vendor: 'customendpoint',
    apiKey,
    apiType: 'chat-completions',
    models,
  };
}

export function isOpenCodeLegacyOrCustomEntry(entry: any): boolean {
  if (!entry || entry.vendor !== 'customendpoint') {
    return false;
  }
  const name = typeof entry.name === 'string' ? entry.name.trim() : '';
  if (name === 'OpenCode Go' || name === 'OpenCode Zen Free') {
    return true;
  }
  const hasOpenCodeModels =
    Array.isArray(entry.models) &&
    entry.models.some((m: any) => typeof m?.url === 'string' && m.url.includes('opencode.ai'));

  if (hasOpenCodeModels) {
    return true;
  }

  if (/^(customprovider|custom endpoint|customendpoint)$/i.test(name)) {
    if (typeof entry.apiKey === 'string' && entry.apiKey.trim().startsWith('sk-')) {
      return true;
    }
  }

  return false;
}

export function mergeChatLanguageModels(
  existingConfig: any[],
  newProviders: ProviderEntry[]
): any[] {
  const addingUnifiedOpenCode = newProviders.some((p) => p.name === 'OpenCode');
  const result = existingConfig.filter((entry) => {
    if (addingUnifiedOpenCode && isOpenCodeLegacyOrCustomEntry(entry) && entry?.name !== 'OpenCode') {
      return false;
    }
    return true;
  });

  for (const newProvider of newProviders) {
    const idx = result.findIndex(
      (entry) => entry && entry.name === newProvider.name && entry.vendor === newProvider.vendor
    );

    if (idx >= 0) {
      const existingModels = result[idx].models || [];
      const incomingModels = newProvider.models || [];
      const modelsToKeep = incomingModels.length > 0 ? incomingModels : existingModels;

      // Preserve SecretStorage reference if VS Code migrated apiKey to ${input:...}
      const existingApiKey = result[idx].apiKey;
      const apiKey =
        typeof existingApiKey === 'string' && existingApiKey.startsWith('${input:')
          ? existingApiKey
          : newProvider.apiKey;

      result[idx] = {
        ...result[idx],
        ...newProvider,
        apiKey,
        models: modelsToKeep,
      };
    } else {
      result.push(newProvider);
    }
  }

  return result;
}
