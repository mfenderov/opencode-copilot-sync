// Models application: catalog sync orchestration.
import { type ProviderEntry } from '../../config.js';
import { enrichModel, ModelMetadataError } from '../infrastructure/model-enricher.js';
import { toCustomEndpointModel, type OpenCodeModel } from '../domain/model.js';
import {
  fetchModelsDevMetadata,
  fetchOpenCodeModels,
  type CatalogModelMetadata,
  type ModelProviderMetadata,
} from '../infrastructure/models-dev-client.js';
import type { OpenCodeCatalogIds, UnifiedOpenCodeModels } from '../domain/model-catalog.js';
import { writeProvidersToConfig } from '../../sync-writer.js';

async function fetchCatalogIds(apiKey: string, catalog: 'go' | 'zen'): Promise<string[]> {
  const label = catalog === 'go' ? 'Go' : 'Zen';
  try {
    return (await fetchOpenCodeModels(apiKey, catalog)).filter(Boolean);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to fetch ${label} models: ${detail}`);
  }
}

export async function fetchOpenCodeCatalogIds(
  apiKey: string,
  includeGo: boolean,
  includeZen: boolean
): Promise<OpenCodeCatalogIds> {
  // Catalog sync is atomic: every enabled catalog must succeed. A failed Go
  // or Zen fetch aborts the whole sync instead of shrinking the announced
  // model list out from under pinned Agent sessions. Disabled catalogs stay
  // empty without fetching.
  // Go and Zen catalogs are independent: fetch them concurrently so one slow
  // endpoint does not serialize behind the other on startup.
  const [goModelIds, zenModelIds] = await Promise.all([
    includeGo ? fetchCatalogIds(apiKey, 'go') : Promise.resolve([] as string[]),
    includeZen ? fetchCatalogIds(apiKey, 'zen') : Promise.resolve([] as string[]),
  ]);

  return { goModelIds, zenModelIds };
}

export async function fetchOpenCodeModelMetadata(): Promise<CatalogModelMetadata> {
  return fetchModelsDevMetadata();
}

function buildCatalogModels(
  modelIds: string[],
  provider: ModelProviderMetadata | undefined,
  isGo: boolean,
  warnings: string[]
): OpenCodeModel[] {
  const models: OpenCodeModel[] = [];
  const label = isGo ? 'Go' : 'Zen';
  for (const id of modelIds) {
    const modelsDevData = provider?.models[id];
    if (!provider || !modelsDevData) {
      warnings.push(`Skipped ${label} model ${id}: OpenCode metadata is missing.`);
      continue;
    }
    try {
      models.push(enrichModel(id, { isGo, provider, modelsDevData }));
    } catch (error) {
      if (!(error instanceof ModelMetadataError)) throw error;
      warnings.push(`Skipped ${label} model ${id}: ${error.message}`);
    }
  }
  return models;
}

export function buildUnifiedModels(
  goModelIds: string[],
  zenModelIds: string[],
  metadata: CatalogModelMetadata
): UnifiedOpenCodeModels {
  const warnings: string[] = [];
  const goModels = buildCatalogModels(goModelIds, metadata.go, true, warnings);
  const goModelIdSet = new Set(goModelIds);
  const zenModels = buildCatalogModels(zenModelIds.filter((id) => !goModelIdSet.has(id)), metadata.zen, false, warnings);
  return { models: [...goModels, ...zenModels], zenCount: zenModels.length, warnings };
}

export function getModelFamily(model: SyncOpenCodeResult['models'][number]): string {
  return model.family || model.id;
}

export function getModelCatalog(model: SyncOpenCodeResult['models'][number]): 'go' | 'zen' {
  return model.catalog;
}

export interface SyncOpenCodeOptions {
  includeGo?: boolean;
  includeZen?: boolean;
  /** Explicit config-file target; it is primary only when it resolves to the active storage path. */
  targetPath?: string;
  storagePath?: string;
  remoteName?: string;
  additionalTargetPaths?: readonly string[];
}

export interface SyncOpenCodeResult {
  goCount: number;
  zenCount: number;
  totalCount: number;
  models: OpenCodeModel[];
  targetPath: string;
  backupPath: string | null;
  warnings: string[];
  cacheSource: { ids: OpenCodeCatalogIds; metadata: CatalogModelMetadata };
}

export async function syncOpenCodeModels(
  apiKey: string,
  options: SyncOpenCodeOptions = {}
): Promise<SyncOpenCodeResult> {
  const includeGo = options.includeGo ?? true;
  const includeZen = options.includeZen ?? true;
  // Catalog IDs and model metadata are independent: fetch them concurrently
  // so the multi-megabyte metadata download never serializes behind catalogs.
  const [catalogIds, metadata] = await Promise.all([
    fetchOpenCodeCatalogIds(apiKey, includeGo, includeZen),
    fetchOpenCodeModelMetadata(),
  ]);
  const { models, zenCount, warnings } = buildUnifiedModels(
    catalogIds.goModelIds,
    catalogIds.zenModelIds,
    metadata
  );

  if (models.length === 0) {
    throw new Error('No models were fetched from OpenCode API. Preserving existing configuration to prevent accidental erasure.');
  }

  const unifiedProvider: ProviderEntry = {
    name: 'OpenCode',
    vendor: 'customendpoint',
    apiKey,
    apiType: 'chat-completions',
    models: models.flatMap((model) => {
      const compatible = toCustomEndpointModel(model);
      return compatible ? [compatible] : [];
    }),
  };
  const writeResult = writeProvidersToConfig([unifiedProvider], options.targetPath, options.storagePath, {
    remoteName: options.remoteName,
    additionalTargetPaths: options.additionalTargetPaths,
  });

  return {
    goCount: models.filter((model) => model.catalog === 'go').length,
    zenCount,
    totalCount: models.length,
    models,
    targetPath: writeResult.targetPath,
    backupPath: writeResult.backupPath,
    warnings: [...warnings, ...writeResult.warnings],
    cacheSource: { ids: catalogIds, metadata },
  };
}
