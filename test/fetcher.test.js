import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { checkZenBalance, fetchModelsDevMetadata, fetchOpenCodeModels, filterAvailableGoModels, KNOWN_UNAVAILABLE_MODELS } from '../out/models/infrastructure/models-dev-client.js';

const originalOfflineMode = process.env.OPENCODE_OFFLINE;
delete process.env.OPENCODE_OFFLINE;

after(() => {
  if (originalOfflineMode === undefined) delete process.env.OPENCODE_OFFLINE;
  else process.env.OPENCODE_OFFLINE = originalOfflineMode;
});

test('filterAvailableGoModels filters out known broken/unavailable models', () => {
  const models = [
    'kimi-k3',
    'glm-5.2',
    'gpt-5.6-luna',
    'grok-4.5',
    'minimax-m3',
    'minimax-m2.7'
  ];

  const available = filterAvailableGoModels(models);
  assert.deepEqual(available, [
    'kimi-k3',
    'glm-5.2',
    'minimax-m3'
  ]);
});

test('fetchModelsDevMetadata prefers OpenCode Go limits over third-party providers', async () => {
  const originalFetch = globalThis.fetch;
  const originalNoProxy = process.env.NO_PROXY;
  process.env.NO_PROXY = '*';
  globalThis.fetch = async () => new Response(JSON.stringify({
    bothub: {
      models: {
        'muse-spark-1.3-contributor': {
          limit: { context: 1048576, output: 943718 },
        },
      },
    },
    opencode: {
      models: {
        'muse-spark-1.3-contributor': {
          limit: { context: 1048576, output: 65536 },
        },
      },
    },
    'opencode-go': {
      models: {
        'muse-spark-1.3-contributor': {
          limit: { context: 1048576, output: 131072 },
        },
      },
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } });

  try {
    const metadata = await fetchModelsDevMetadata();
    assert.deepEqual(metadata['muse-spark-1.3-contributor'].limit, {
      context: 1048576,
      output: 131072,
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalNoProxy === undefined) delete process.env.NO_PROXY;
    else process.env.NO_PROXY = originalNoProxy;
  }
});

test('fetchOpenCodeModels aborts a hung catalog request instead of stalling startup sync', { timeout: 15000 }, async () => {
  const originalFetch = globalThis.fetch;
  // Signal-aware hang: mirrors the real fetch contract, which rejects when
  // the passed AbortSignal fires.
  globalThis.fetch = (url, init) => new Promise((resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal.reason));
  });

  try {
    const start = Date.now();
    await assert.rejects(
      fetchOpenCodeModels('sk-test-key-12345', 'go'),
      (err) => err && err.name === 'TimeoutError'
    );
    assert.ok(Date.now() - start < 12000, 'hung request must be time-bounded');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('checkZenBalance does not call the API while OPENCODE_OFFLINE is enabled', async () => {
  const previousOffline = process.env.OPENCODE_OFFLINE;
  const previousNoProxy = process.env.NO_PROXY;
  const originalFetch = globalThis.fetch;
  process.env.OPENCODE_OFFLINE = '1';
  process.env.NO_PROXY = '*';
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response('ok', { status: 200 });
  };

  try {
    assert.equal(await checkZenBalance('sk-test'), false);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousOffline === undefined) delete process.env.OPENCODE_OFFLINE;
    else process.env.OPENCODE_OFFLINE = previousOffline;
    if (previousNoProxy === undefined) delete process.env.NO_PROXY;
    else process.env.NO_PROXY = previousNoProxy;
  }
});
