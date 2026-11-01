import { createHash } from 'node:crypto';
import type { OpenCodeCatalogIds } from '../domain/model-catalog.js';
import { providerMetadata, type CatalogModelMetadata } from './models-dev-client.js';

export const CATALOG_CACHE_KEY = 'opencode.catalog-cache.v1';

export interface CatalogSelection {
  includeGo: boolean;
  includeZen: boolean;
}

export interface CatalogCacheSource {
  ids: OpenCodeCatalogIds;
  metadata: CatalogModelMetadata;
}

interface CachedValue { version: unknown; keyHash: unknown; includeGo: unknown; includeZen: unknown; ids: unknown; metadata: unknown }

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === 'string' && item.length > 0);
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readCachedValue(value: unknown): CachedValue | undefined {
  const cached = toRecord(value);
  return cached ? cached as unknown as CachedValue : undefined;
}

function readSelection(cached: CachedValue, selection: CatalogSelection): boolean {
  return cached.version === 1 && cached.includeGo === selection.includeGo &&
    cached.includeZen === selection.includeZen;
}

function idsFrom(value: unknown, selection: CatalogSelection): CatalogCacheSource['ids'] | undefined {
  const sections = toRecord(value);
  const goModelIds = sections?.goModelIds;
  const zenModelIds = sections?.zenModelIds;
  if (!stringArray(goModelIds) || !stringArray(zenModelIds)) return undefined;
  if ((!selection.includeGo && goModelIds.length > 0) ||
    (!selection.includeZen && zenModelIds.length > 0)) return undefined;
  return { goModelIds, zenModelIds };
}

function metadataFrom(value: unknown, ids: CatalogCacheSource['ids']): CatalogCacheSource['metadata'] | undefined {
  const sections = toRecord(value);
  const go = providerMetadata(sections?.go);
  const zen = providerMetadata(sections?.zen);
  if ((ids.goModelIds.length && !go) || (ids.zenModelIds.length && !zen)) return undefined;
  return { go, zen };
}

export function catalogKeyHash(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex');
}

export function createCatalogCache(
  apiKey: string,
  selection: CatalogSelection,
  source: CatalogCacheSource
): Record<string, unknown> {
  return { version: 1, keyHash: catalogKeyHash(apiKey), ...selection, ...source };
}

export function readCatalogCache(
  value: unknown,
  apiKey: string,
  selection: CatalogSelection
): CatalogCacheSource | undefined {
  const cached = readCachedValue(value);
  if (!cached || !readSelection(cached, selection) ||
    cached.keyHash !== catalogKeyHash(apiKey)) return undefined;
  const ids = idsFrom(cached.ids, selection);
  if (!ids) return undefined;
  const metadata = metadataFrom(cached.metadata, ids);
  if (!metadata) return undefined;
  return { ids, metadata };
}
