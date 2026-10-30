import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveModelTokenLimits } from '../out/models/domain/token-budget.js';

test('token limits use upstream input and output maxima without family-based guesses', () => {
  assert.deepEqual(resolveModelTokenLimits(1000, 800, 700), {
    contextWindow: 1000, maxInputTokens: 700, maxOutputTokens: 800,
  });
  assert.deepEqual(resolveModelTokenLimits(1000, 1000), {
    contextWindow: 1000, maxInputTokens: 1000, maxOutputTokens: 1000,
  });
  assert.deepEqual(resolveModelTokenLimits(1000, 2000, 1500), {
    contextWindow: 1000, maxInputTokens: 1000, maxOutputTokens: 1000,
  });
});

test('invalid token limits are rejected rather than replaced with hardcoded defaults', () => {
  for (const input of [[0, 10], [0.5, 1], [1000, 0], [1000, 1.5], [1000, 10, 0]]) {
    assert.throws(() => resolveModelTokenLimits(...input), /Invalid model/);
  }
});
