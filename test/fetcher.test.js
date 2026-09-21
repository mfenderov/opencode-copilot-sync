import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterFreeModels, isFreeTierModel, filterAvailableGoModels, KNOWN_UNAVAILABLE_MODELS } from '../out/fetcher.js';

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

