import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterFreeModels } from '../out/fetcher.js';

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
