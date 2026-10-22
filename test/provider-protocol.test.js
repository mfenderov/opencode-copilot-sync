import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveModelTokenLimits } from '../out/models/domain/token-budget.js';

test('resolveModelTokenLimits rejects metadata that cannot preserve a positive input budget', () => {
  const cases = [
    {
      input: [0.5, 0.5],
      expected: { contextWindow: 1048576, maxInputTokens: 983040, maxOutputTokens: 65536 },
    },
    {
      input: [1, 1],
      expected: { contextWindow: 1048576, maxInputTokens: 1048575, maxOutputTokens: 1 },
    },
    {
      input: [2, 2],
      expected: { contextWindow: 1048576, maxInputTokens: 1048574, maxOutputTokens: 2 },
    },
    {
      input: [3, 3],
      expected: { contextWindow: 1048576, maxInputTokens: 1048573, maxOutputTokens: 3 },
    },
    {
      input: [1048576, 0.5],
      expected: { contextWindow: 1048576, maxInputTokens: 983040, maxOutputTokens: 65536 },
    },
  ];

  for (const { input, expected } of cases) {
    assert.deepEqual(resolveModelTokenLimits(...input), expected);
  }
});
