import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchModelsDevMetadata, fetchOpenCodeModels } from '../out/models/infrastructure/models-dev-client.js';
import { metadataResponse } from './helpers/catalog-fixture.js';

function isolateFetch(t, handler) {
  const previous = { fetch: globalThis.fetch, noProxy: process.env.NO_PROXY, offline: process.env.OPENCODE_OFFLINE };
  process.env.NO_PROXY = '*';
  delete process.env.OPENCODE_OFFLINE;
  globalThis.fetch = handler;
  t.after(() => {
    globalThis.fetch = previous.fetch;
    if (previous.noProxy === undefined) delete process.env.NO_PROXY;
    else process.env.NO_PROXY = previous.noProxy;
    if (previous.offline === undefined) delete process.env.OPENCODE_OFFLINE;
    else process.env.OPENCODE_OFFLINE = previous.offline;
  });
}

test('model availability follows the upstream catalog without a local model denylist', async (t) => {
  isolateFetch(t, async () => new Response(JSON.stringify({
    data: [{ id: 'grok-4.6' }, { id: 'minimax-m2.7' }, { id: 'new-model' }],
  }), { status: 200 }));
  assert.deepEqual(await fetchOpenCodeModels('sk-test-key', 'go'), [
    'grok-4.6', 'minimax-m2.7', 'new-model',
  ]);
});

test('metadata falls back to the second upstream catalog after a primary failure', async (t) => {
  const urls = [];
  isolateFetch(t, async (url) => {
    urls.push(String(url));
    if (String(url).includes('models.opencode.ai')) return new Response('unavailable', { status: 503 });
    return new Response(JSON.stringify(metadataResponse(['go-model'], ['zen-model'])), { status: 200 });
  });
  const catalog = await fetchModelsDevMetadata();
  assert.ok(catalog.go.models['go-model']);
  assert.ok(catalog.zen.models['zen-model']);
  assert.ok(urls.some((url) => url.includes('models.dev')));
});

test('fetchOpenCodeModels aborts a hung catalog request instead of stalling startup sync', { timeout: 15000 }, async (t) => {
  isolateFetch(t, (_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal.reason));
  }));
  const start = Date.now();
  await assert.rejects(fetchOpenCodeModels('sk-test-key', 'go'), (error) => error?.name === 'TimeoutError');
  assert.ok(Date.now() - start < 12000, 'hung request must be time-bounded');
});

test('fetchModelsDevMetadata aborts each metadata catalog with the caller-supplied timeout', { timeout: 15000 }, async (t) => {
  isolateFetch(t, (_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal.reason));
  }));
  const start = Date.now();
  await assert.rejects(
    fetchModelsDevMetadata(150),
    (error) => /metadata is unavailable/.test(String(error?.message)) &&
      String(error?.message).includes('models.dev')
  );
  assert.ok(Date.now() - start < 6_000, 'both metadata catalogs must abort with the configured timeout, not the default five seconds each');
});

test('a caller-supplied timeout bounds a hung catalog request faster than the default', async (t) => {
  isolateFetch(t, (_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal.reason));
  }));
  const start = Date.now();
  await assert.rejects(
    fetchOpenCodeModels('sk-test-key', 'go', 150),
    (error) => error?.name === 'TimeoutError'
  );
  assert.ok(Date.now() - start < 4_000, 'configured timeout must govern the abort');
});
