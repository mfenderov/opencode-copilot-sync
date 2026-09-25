import { enrichModel, type CustomEndpointModel } from './enricher.js';
import {
  fetchModelsDevMetadata,
  fetchOpenCodeModels,
  isFreeTierModel,
  type ModelDevMetadata,
} from './fetcher.js';

export interface OpenCodeCatalogIds {
  goModelIds: string[];
  zenModelIds: string[];
}

export interface UnifiedOpenCodeModels {
  models: CustomEndpointModel[];
  zenCount: number;
}

export async function fetchOpenCodeCatalogIds(
  apiKey: string,
  includeGo: boolean,
  includeZen: boolean
): Promise<OpenCodeCatalogIds> {
  // Go and Zen catalogs are independent: fetch them concurrently so one slow
  // endpoint does not serialize behind the other on startup.
  const [goOutcome, zenOutcome] = await Promise.allSettled([
    includeGo ? fetchOpenCodeModels(apiKey, 'go') : Promise.resolve([] as string[]),
    includeZen ? fetchOpenCodeModels(apiKey, 'zen') : Promise.resolve([] as string[]),
  ]);

  let goModelIds: string[] = [];
  let zenModelIds: string[] = [];

  if (goOutcome.status === 'fulfilled') {
    goModelIds = goOutcome.value.filter(Boolean);
  } else {
    const message = goOutcome.reason instanceof Error ? goOutcome.reason.message : String(goOutcome.reason);
    console.error(`Failed to fetch Go models: ${message}`);
  }

  if (zenOutcome.status === 'fulfilled') {
    zenModelIds = zenOutcome.value.filter(Boolean);
  } else {
    const message = zenOutcome.reason instanceof Error ? zenOutcome.reason.message : String(zenOutcome.reason);
    console.error(`Failed to fetch Zen models: ${message}`);
  }

  return { goModelIds, zenModelIds };
}

export async function fetchOpenCodeModelMetadata(): Promise<Record<string, ModelDevMetadata>> {
  try {
    return await fetchModelsDevMetadata();
  } catch {
    return {};
  }
}

function firstModelMetadata(
  metadata: Partial<Record<string, ModelDevMetadata>>,
  candidates: string[]
): ModelDevMetadata | undefined {
  return candidates.map((id) => metadata[id]).find((item) => item !== undefined);
}

function getGoModelMetadata(modelId: string, metadata: Record<string, ModelDevMetadata>): ModelDevMetadata | undefined {
  return firstModelMetadata(metadata, [
    modelId,
    modelId.replace(/-contributor$/, ''),
    modelId.replace(/-free$/, ''),
  ]);
}

function getZenModelMetadata(modelId: string, metadata: Record<string, ModelDevMetadata>): ModelDevMetadata | undefined {
  return firstModelMetadata(metadata, [
    modelId,
    modelId.replace(/-contributor-free$/, ''),
    modelId.replace(/-free$/, ''),
  ]);
}

function buildGoModels(
  modelIds: string[],
  metadata: Record<string, ModelDevMetadata>
): CustomEndpointModel[] {
  return modelIds.map((id) =>
    enrichModel(id, {
      isGo: true,
      suffix: '(OpenCode Go)',
      modelsDevData: getGoModelMetadata(id, metadata),
    })
  );
}

function buildZenModels(
  modelIds: string[],
  goModelIds: string[],
  metadata: Record<string, ModelDevMetadata>
): CustomEndpointModel[] {
  const goModelIdSet = new Set(goModelIds);
  const models: CustomEndpointModel[] = [];

  for (const id of modelIds) {
    if (goModelIdSet.has(id)) continue;

    const isFree = isFreeTierModel(id, metadata[id]);
    const suffix = isFree ? '(OpenCode Free)' : '(OpenCode Zen)';
    models.push(enrichModel(id, { isGo: false, isFree, suffix, modelsDevData: getZenModelMetadata(id, metadata) }));
  }

  return models;
}

export function buildUnifiedModels(
  goModelIds: string[],
  zenModelIds: string[],
  metadata: Record<string, ModelDevMetadata>
): UnifiedOpenCodeModels {
  const goModels = buildGoModels(goModelIds, metadata);
  const zenModels = buildZenModels(zenModelIds, goModelIds, metadata);
  return { models: [...goModels, ...zenModels], zenCount: zenModels.length };
}
