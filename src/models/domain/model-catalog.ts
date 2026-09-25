// Models domain: catalog identity types.
import type { CustomEndpointModel } from './model.js';

export interface OpenCodeCatalogIds {
  goModelIds: string[];
  zenModelIds: string[];
}

export interface UnifiedOpenCodeModels {
  models: CustomEndpointModel[];
  zenCount: number;
}
