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

export function mergeChatLanguageModels(
  existingConfig: any[],
  newProviders: ProviderEntry[]
): any[] {
  const addingUnifiedOpenCode = newProviders.some((p) => p.name === 'OpenCode');
  const result = existingConfig.filter((entry) => {
    if (addingUnifiedOpenCode && (entry?.name === 'OpenCode Go' || entry?.name === 'OpenCode Zen Free')) {
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

      result[idx] = {
        ...result[idx],
        ...newProvider,
        models: modelsToKeep,
      };
    } else {
      result.push(newProvider);
    }
  }

  return result;
}
