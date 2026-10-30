import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCatalogCache, readCatalogCache } from '../out/models/infrastructure/catalog-cache.js';
import { catalogMetadata } from './helpers/catalog-fixture.js';

const selection = { includeGo: true, includeZen: true };
const source = {
  ids: { goModelIds: ['go-model'], zenModelIds: ['zen-model'] },
  metadata: catalogMetadata(['go-model'], ['zen-model']),
};

test('cached catalogs are bound to an API key without persisting the key', () => {
  const cached = createCatalogCache('sk-private-test-key', selection, source);
  assert.doesNotMatch(JSON.stringify(cached), /sk-private-test-key/);
  assert.deepEqual(readCatalogCache(cached, 'sk-private-test-key', selection), source);
  assert.equal(readCatalogCache(cached, 'sk-different-key', selection), undefined);
});

test('cached catalogs do not return models from a disabled catalog', () => {
  const disabled = { includeGo: false, includeZen: true };
  const cached = createCatalogCache('sk-test-key', disabled, source);
  assert.equal(readCatalogCache(cached, 'sk-test-key', disabled), undefined);
});
