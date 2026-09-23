import { type ProviderEntry } from './config.js';
import { type CustomEndpointModel } from './enricher.js';
import {
  buildUnifiedModels,
  fetchOpenCodeCatalogIds,
  fetchOpenCodeModelMetadata,
} from './sync-catalog.js';
import { writeProvidersToConfig } from './sync-writer.js';

export {
  getAllChatLanguageModelsPaths,
  getChatLanguageModelsPath,
  isWSL,
  resolveAssociatedWslHome,
  discoverSyncTargets,
} from './sync-targets.js';
export { createBackup, readChatLanguageModels, safeWriteFileSync } from './sync-files.js';
export {
  cleanupLegacyOpenCodeCustomEndpoints,
  syncWslMirror,
  writeProvidersToConfig,
  writeProvidersToTargets,
} from './sync-writer.js';
export { buildUnifiedModels } from './sync-catalog.js';
export type { OpenCodeCatalogIds, UnifiedOpenCodeModels } from './sync-catalog.js';

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
  models: CustomEndpointModel[];
  targetPath: string;
  backupPath: string | null;
  warnings: string[];
}

export async function syncOpenCodeModels(
  apiKey: string,
  options: SyncOpenCodeOptions = {}
): Promise<SyncOpenCodeResult> {
  const includeGo = options.includeGo ?? true;
  const includeZen = options.includeZen ?? true;
  const catalogIds = await fetchOpenCodeCatalogIds(apiKey, includeGo, includeZen);
  const metadata = await fetchOpenCodeModelMetadata();
  const { models, zenCount } = buildUnifiedModels(
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
    models,
  };
  const writeResult = writeProvidersToConfig([unifiedProvider], options.targetPath, options.storagePath, {
    remoteName: options.remoteName,
    additionalTargetPaths: options.additionalTargetPaths,
  });

  return {
    goCount: catalogIds.goModelIds.length,
    zenCount,
    totalCount: models.length,
    models,
    targetPath: writeResult.targetPath,
    backupPath: writeResult.backupPath,
    warnings: writeResult.warnings,
  };
}
