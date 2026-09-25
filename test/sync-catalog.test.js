import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { fetchOpenCodeCatalogIds } from '../out/sync-catalog.js';

const originalOfflineMode = process.env.OPENCODE_OFFLINE;
delete process.env.OPENCODE_OFFLINE;

const originalFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = originalFetch;
  if (originalOfflineMode === undefined) delete process.env.OPENCODE_OFFLINE;
  else process.env.OPENCODE_OFFLINE = originalOfflineMode;
});

function okEmptyList() {
  return { ok: true, status: 200, statusText: 'OK', json: async () => ({ data: [] }) };
}

test('fetchOpenCodeCatalogIds requests Go and Zen catalogs concurrently', async () => {
  const requested = [];
  let releaseGo;
  const goGate = new Promise((resolve) => { releaseGo = resolve; });
  globalThis.fetch = async (url) => {
    requested.push(String(url));
    if (String(url).includes('/zen/go/v1/models')) await goGate;
    return okEmptyList();
  };

  try {
    const pending = fetchOpenCodeCatalogIds('sk-test-key-12345', true, true);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(
      requested.some((u) => u.includes('/zen/v1/models')),
      `zen catalog must be requested while go is still pending; got: ${JSON.stringify(requested)}`
    );
    releaseGo();
    assert.deepEqual(await pending, { goModelIds: [], zenModelIds: [] });
  } finally {
    releaseGo();
    globalThis.fetch = originalFetch;
  }
});
