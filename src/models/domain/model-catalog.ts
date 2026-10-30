// Models domain: catalog identity types.
import type { OpenCodeModel } from './model.js';

export interface OpenCodeCatalogIds {
  goModelIds: string[];
  zenModelIds: string[];
}

export interface UnifiedOpenCodeModels {
  models: OpenCodeModel[];
  zenCount: number;
  warnings: string[];
}
