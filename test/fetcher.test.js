import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { checkZenBalance, fetchModelsDevMetadata, filterFreeModels, isFreeTierModel, filterAvailableGoModels, KNOWN_UNAVAILABLE_MODELS } from '../out/fetcher.js';

const originalOfflineMode = process.env.OPENCODE_OFFLINE;
delete process.env.OPENCODE_OFFLINE;

after(() => {
  if (originalOfflineMode === undefined) delete process.env.OPENCODE_OFFLINE;
  else process.env.OPENCODE_OFFLINE = originalOfflineMode;
});

test('isFreeTierModel uses authoritative cost metadata over string heuristic', () => {
  // Zero-cost model without "free" in name (e.g. grok-code, big-pickle)
  assert.equal(
    isFreeTierModel('grok-code', { cost: { input: 0, output: 0 } }),
    true
  );

  // Paid model with non-zero cost
  assert.equal(
    isFreeTierModel('claude-sonnet-4-6', { cost: { input: 3, output: 15 } }),
    false
  );

  // Paid model with non-zero cost even if "free" appeared in id
  assert.equal(
    isFreeTierModel('freeform-premium-model', { cost: { input: 0.5, output: 1.5 } }),
    false
  );

  // Fallback to name heuristic when devMeta has no cost
  assert.equal(isFreeTierModel('mimo-v2.5-free'), true);
  assert.equal(isFreeTierModel('big-pickle'), true);
  assert.equal(isFreeTierModel('deepseek-v4-pro'), false);
  assert.equal(isFreeTierModel('muse-spark-1.3-contributor'), false);
  assert.equal(isFreeTierModel('muse-spark-1.3-contributor-free'), true);
});

test('filterFreeModels correctly identifies free models with and without metadata', () => {
  const allModels = [
    'claude-opus-5',
    'deepseek-v4-flash-free',
    'big-pickle',
    'mimo-v2.5-free',
    'muse-spark-1.3-contributor',
    'muse-spark-1.3-contributor-free',
    'grok-code',
    'gpt-5.5'
  ];

  // Without metadata
  const freeWithoutMeta = filterFreeModels(allModels);
  assert.deepEqual(freeWithoutMeta, [
    'deepseek-v4-flash-free',
    'big-pickle',
    'mimo-v2.5-free',
    'muse-spark-1.3-contributor-free'
  ]);

  // With metadata (grok-code has zero cost)
  const devMap = {
    'grok-code': { cost: { input: 0, output: 0 } },
    'gpt-5.5': { cost: { input: 2, output: 8 } },
  };
  const freeWithMeta = filterFreeModels(allModels, devMap);
  assert.deepEqual(freeWithMeta, [
    'deepseek-v4-flash-free',
    'big-pickle',
    'mimo-v2.5-free',
    'muse-spark-1.3-contributor-free',
    'grok-code'
  ]);
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
