import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enrichModel } from '../out/enricher.js';

test('enrichModel handles deepseek models with reasoning', () => {
  const model = enrichModel('deepseek-v4-flash', { isGo: true });
  assert.equal(model.id, 'deepseek-v4-flash');
  assert.equal(model.name, 'DeepSeek V4 Flash (OpenCode)');
  assert.equal(model.toolCalling, true);
  assert.equal(model.thinking, true);
  assert.deepEqual(model.requestHeaders, { 'x-opencode-session': 'vscode-copilot' });
  assert.ok(model.contextWindow >= 128000);
});

test('enrichModel handles vision models like kimi-k3', () => {
  const model = enrichModel('kimi-k3', { isGo: true });
  assert.equal(model.id, 'kimi-k3');
  assert.equal(model.vision, true);
  assert.equal(model.toolCalling, true);
  assert.deepEqual(model.requestHeaders, { 'x-opencode-session': 'vscode-copilot' });
});

test('enrichModel handles standard Zen models without session header', () => {
  const model = enrichModel('deepseek-v4-flash', { isGo: false });
  assert.equal(model.requestHeaders, undefined);
  assert.equal(model.url, 'https://opencode.ai/zen/v1/chat/completions');
});

test('enrichModel preserves version decimals in display name', () => {
  const model = enrichModel('minimax-m2.7', { isGo: true });
  assert.equal(model.name, 'MiniMax M2.7 (OpenCode)');
});

test('enrichModel computes maxInputTokens and sets modelOptions', () => {
  const model = enrichModel('deepseek-v4-flash', { isGo: true });
  assert.equal(model.maxInputTokens, model.contextWindow - model.maxOutputTokens);
  assert.deepEqual(model.modelOptions, { temperature: null, top_p: null });
});
