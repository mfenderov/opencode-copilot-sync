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
  const result = [...existingConfig];

  for (const newProvider of newProviders) {
    const idx = result.findIndex(
      (entry) => entry && entry.name === newProvider.name && entry.vendor === newProvider.vendor
    );

    if (idx >= 0) {
      result[idx] = {
        ...result[idx],
        ...newProvider,
      };
    } else {
      result.push(newProvider);
    }
  }

  return result;
}
