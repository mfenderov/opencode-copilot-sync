import type { CustomEndpointModel } from '../infrastructure/model-enricher.js';

export interface OpenCodeCatalogIds {
  goModelIds: string[];
  zenModelIds: string[];
}

export interface UnifiedOpenCodeModels {
  models: CustomEndpointModel[];
  zenCount: number;
}
