import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterFreeModels, filterAvailableGoModels, KNOWN_UNAVAILABLE_MODELS } from '../out/fetcher.js';

test('filterFreeModels correctly identifies free models', () => {
  const allModels = [
    'claude-opus-5',
    'deepseek-v4-flash-free',
    'big-pickle',
    'mimo-v2.5-free',
    'gpt-5.5'
  ];

  const free = filterFreeModels(allModels);
  assert.deepEqual(free, [
    'deepseek-v4-flash-free',
    'big-pickle',
    'mimo-v2.5-free'
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

test('filterAvailableGoModels filters out muse models including muse-spark-1.3-contributor-free', () => {
  const models = [
    'kimi-k3',
    'muse-spark-1.3-contributor-free',
    'muse-spark-1.2-contributor-free',
    'muse-spark-1.3-contributor',
    'muse-spark-1.3',
    'big-pickle'
  ];
  const available = filterAvailableGoModels(models);
  assert.deepEqual(available, ['kimi-k3', 'big-pickle']);
});

