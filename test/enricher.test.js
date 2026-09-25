import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enrichModel } from '../out/enricher.js';

test('enrichModel handles deepseek models with reasoning', () => {
  const model = enrichModel('deepseek-v4-flash', { isGo: true });
  assert.equal(model.id, 'deepseek-v4-flash');
  assert.equal(model.name, 'DeepSeek V4 Flash (OpenCode Go)');
  assert.equal(model.toolCalling, true);
  assert.equal(model.thinking, true);
  assert.deepEqual(model.requestHeaders, { 'x-opencode-session': 'vscode-copilot' });
  assert.ok(model.contextWindow >= 128000);
});

test('enrichModel handles vision models like kimi-k3', () => {
  const model = enrichModel('kimi-k3', { isGo: true });
  assert.equal(model.id, 'kimi-k3');
  assert.equal(model.name, 'Kimi K3 (OpenCode Go)');
  assert.equal(model.vision, true);
  assert.equal(model.toolCalling, true);
  assert.deepEqual(model.requestHeaders, { 'x-opencode-session': 'vscode-copilot' });
});

test('enrichModel handles standard Zen models without session header', () => {
  const model = enrichModel('deepseek-v4-flash', { isGo: false });
  assert.equal(model.name, 'DeepSeek V4 Flash (OpenCode Zen)');
  assert.equal(model.requestHeaders, undefined);
  assert.equal(model.url, 'https://opencode.ai/zen/v1/chat/completions');
});

test('enrichModel preserves version decimals in display name', () => {
  const model = enrichModel('minimax-m2.7', { isGo: true });
  assert.equal(model.name, 'MiniMax M2.7 (OpenCode Go)');
});

test('enrichModel computes maxInputTokens and sets modelOptions', () => {
  const model = enrichModel('deepseek-v4-flash', { isGo: true });
  assert.equal(model.maxInputTokens, model.contextWindow - model.maxOutputTokens);
  assert.deepEqual(model.modelOptions, { temperature: null, top_p: null });
  assert.equal(model.editTools, undefined, 'editTools must not be set to avoid proposed API rejection');
});

test('enrichModel extracts exact reasoning effort values from modelsDevData and filters out "none"', () => {
  const museDevData = {
    reasoning: true,
    reasoning_options: [
      {
        type: 'effort',
        values: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'],
      },
    ],
  };
  const model = enrichModel('muse-spark-1.3-contributor-free', { isGo: false, isFree: true, modelsDevData: museDevData });
  assert.equal(model.thinking, true);
  assert.deepEqual(model.supportsReasoningEffort, ['minimal', 'low', 'medium', 'high', 'xhigh']);
  assert.ok(!model.supportsReasoningEffort.includes('max'), 'Muse must not include max');
  assert.ok(!model.supportsReasoningEffort.includes('none'), 'Effort enum must not include none');
});

test('enrichModel sets supportsReasoningEffort to undefined for boolean-only reasoning models', () => {
  const booleanReasoningData = {
    reasoning: true,
  };
  const model = enrichModel('minimax-m2.5', { isGo: true, modelsDevData: booleanReasoningData });
  assert.equal(model.thinking, true);
  assert.strictEqual(model.supportsReasoningEffort, undefined, 'Boolean-only reasoning model must not have effort array');
});

test('enrichModel sets thinking = false and supportsReasoningEffort = undefined for non-reasoning models', () => {
  const noReasoningData = {
    reasoning: false,
  };
  const model = enrichModel('qwen3.7-max', { isGo: true, modelsDevData: noReasoningData });
  assert.equal(model.thinking, false);
  assert.strictEqual(model.supportsReasoningEffort, undefined);
});

test('enrichModel keeps at least 75 percent of context available for input', () => {
  const model = enrichModel('muse-spark-1.3-contributor', {
    isGo: true,
    modelsDevData: {
      limit: { context: 1048576, output: 943718 },
    },
  });

  assert.equal(model.maxOutputTokens, 262144);
  assert.equal(model.maxInputTokens, 786432);
});

test('enrichModel assigns a distinct stable family per model id (no shared hardcoded family)', () => {
  const ids = [
    'muse-spark-1.3',
    'deepseek-v4-flash',
    'kimi-k3',
    'big-pickle',
    'muse-spark-1.3-contributor',
    'muse-spark-1.3-contributor-free',
    'nemotron-3-ultra-free',
  ];
  const models = ids.map((id) => enrichModel(id, { isGo: true }));
  for (const m of models) {
    assert.equal(m.family, m.id, `${m.id} must advertise family === id (verified-list convention)`);
    assert.notEqual(m.family, 'gpt-5-5', `${m.id} must not carry the legacy hardcoded family`);
  }
  assert.equal(new Set(models.map((m) => m.family)).size, ids.length, 'no two different models may share one family');
});

test('enrichModel family is stable for the same model across calls and options', () => {
  const first = enrichModel('kimi-k3', { isGo: true }).family;
  for (const opts of [
    { isGo: false },
    { isGo: true, suffix: '(Custom)' },
    { isGo: true, modelsDevData: { limit: { context: 200000, output: 64000 } } },
  ]) {
    assert.equal(enrichModel('kimi-k3', opts).family, first, 'same model must keep same family across options');
  }
  const free = enrichModel('muse-spark-1.3-contributor-free', { isGo: false, isFree: true }).family;
  assert.equal(enrichModel('muse-spark-1.3-contributor-free', { isGo: true }).family, free);
  assert.notEqual(free, enrichModel('muse-spark-1.3-contributor', { isGo: true }).family, 'free/contributor variants are distinct models');
});

