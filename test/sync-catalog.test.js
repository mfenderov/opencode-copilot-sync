import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { fetchOpenCodeCatalogIds } from '../out/models/application/synchronize-models.js';

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

function failedList() {
  return { ok: false, status: 500, statusText: 'Internal Server Error', text: async () => 'boom' };
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

test('fetchOpenCodeCatalogIds rejects when the enabled Go catalog fails instead of returning a partial list', async () => {
  globalThis.fetch = async (url) => {
    if (String(url).includes('/zen/go/v1/models')) return failedList();
    return okEmptyList();
  };

  try {
    await assert.rejects(
      fetchOpenCodeCatalogIds('sk-test-key-12345', true, true),
      /Go models/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchOpenCodeCatalogIds rejects when the enabled Zen catalog fails instead of returning a partial list', async () => {
  globalThis.fetch = async (url) => {
    if (String(url).includes('/zen/go/v1/models')) return okEmptyList();
    return failedList();
  };

  try {
    await assert.rejects(
      fetchOpenCodeCatalogIds('sk-test-key-12345', true, true),
      /Zen models/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchOpenCodeCatalogIds ignores a disabled catalog that would fail', async () => {
  globalThis.fetch = async (url) => {
    if (String(url).includes('/zen/go/v1/models')) return failedList();
    return okEmptyList();
  };

  try {
    assert.deepEqual(await fetchOpenCodeCatalogIds('sk-test-key-12345', false, true), {
      goModelIds: [],
      zenModelIds: [],
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
