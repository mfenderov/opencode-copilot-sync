import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enrichModel } from '../out/enricher.js';
import { isResponsesModel } from '../out/provider.js';

test('muse-* models MUST have apiType === "responses" and url ending with /zen/go/v1 or /zen/v1', () => {
  const museModels = [
    'muse-spark-1.3-contributor-free',
    'muse-spark-1.2-contributor-free',
    'muse-creative',
  ];

  for (const modelId of museModels) {
    // Go catalog variant
    const goModel = enrichModel(modelId, { isGo: true });
    assert.equal(goModel.apiType, 'responses', `${modelId} (Go) must have apiType === 'responses'`);
    assert.ok(
      goModel.url.endsWith('/zen/go/v1'),
      `${modelId} (Go) url must end with /zen/go/v1, got: ${goModel.url}`
    );
    assert.ok(
      !goModel.url.includes('/chat/completions'),
      `${modelId} (Go) url must not contain /chat/completions`
    );

    // Zen / Free catalog variant
    const zenModel = enrichModel(modelId, { isGo: false, isFree: true });
    assert.equal(zenModel.apiType, 'responses', `${modelId} (Zen) must have apiType === 'responses'`);
    assert.ok(
      zenModel.url.endsWith('/zen/v1'),
      `${modelId} (Zen) url must end with /zen/v1, got: ${zenModel.url}`
    );
    assert.ok(
      !zenModel.url.includes('/chat/completions'),
      `${modelId} (Zen) url must not contain /chat/completions`
    );
  }
});

test('gpt-* models MUST have apiType === "responses" and base url without /chat/completions', () => {
  const gptModels = [
    'gpt-5.5',
    'gpt-5.6-terra',
    'gpt-5.6-luna',
    'gpt-5-mini',
    'gpt-5.4',
    'gpt-5.3-codex',
  ];

  for (const modelId of gptModels) {
    const goModel = enrichModel(modelId, { isGo: true });
    assert.equal(goModel.apiType, 'responses', `${modelId} must have apiType === 'responses'`);
    assert.ok(
      goModel.url.endsWith('/zen/go/v1'),
      `${modelId} url must end with /zen/go/v1, got: ${goModel.url}`
    );
    assert.ok(
      !goModel.url.includes('/chat/completions'),
      `${modelId} url must not contain /chat/completions`
    );

    const zenModel = enrichModel(modelId, { isGo: false });
    assert.equal(zenModel.apiType, 'responses', `${modelId} (Zen) must have apiType === 'responses'`);
    assert.ok(
      zenModel.url.endsWith('/zen/v1'),
      `${modelId} (Zen) url must end with /zen/v1, got: ${zenModel.url}`
    );
    assert.ok(
      !zenModel.url.includes('/chat/completions'),
      `${modelId} (Zen) url must not contain /chat/completions`
    );
  }
});

test('grok-* models MUST have apiType === "responses" and base url without /chat/completions', () => {
  const grokModels = [
    'grok-4.6',
    'grok-4.5',
  ];

  for (const modelId of grokModels) {
    const goModel = enrichModel(modelId, { isGo: true });
    assert.equal(goModel.apiType, 'responses', `${modelId} must have apiType === 'responses'`);
    assert.ok(
      goModel.url.endsWith('/zen/go/v1'),
      `${modelId} url must end with /zen/go/v1, got: ${goModel.url}`
    );
    assert.ok(
      !goModel.url.includes('/chat/completions'),
      `${modelId} url must not contain /chat/completions`
    );

    const zenModel = enrichModel(modelId, { isGo: false });
    assert.equal(zenModel.apiType, 'responses', `${modelId} (Zen) must have apiType === 'responses'`);
    assert.ok(
      zenModel.url.endsWith('/zen/v1'),
      `${modelId} (Zen) url must end with /zen/v1, got: ${zenModel.url}`
    );
    assert.ok(
      !zenModel.url.includes('/chat/completions'),
      `${modelId} (Zen) url must not contain /chat/completions`
    );
  }
});

test('claude-* models MUST have apiType === "messages" and url ending with /zen/go/v1 or /zen/v1', () => {
  const claudeModels = [
    'claude-sonnet-5',
    'claude-opus-5',
    'claude-opus-4.8',
    'claude-haiku-4.5',
  ];

  for (const modelId of claudeModels) {
    const goModel = enrichModel(modelId, { isGo: true });
    assert.equal(goModel.apiType, 'messages', `${modelId} must have apiType === 'messages'`);
    assert.ok(
      goModel.url.endsWith('/zen/go/v1'),
      `${modelId} url must end with /zen/go/v1, got: ${goModel.url}`
    );
    assert.ok(
      !goModel.url.includes('/chat/completions'),
      `${modelId} url must not contain /chat/completions`
    );

    const zenModel = enrichModel(modelId, { isGo: false });
    assert.equal(zenModel.apiType, 'messages', `${modelId} (Zen) must have apiType === 'messages'`);
    assert.ok(
      zenModel.url.endsWith('/zen/v1'),
      `${modelId} (Zen) url must end with /zen/v1, got: ${zenModel.url}`
    );
    assert.ok(
      !zenModel.url.includes('/chat/completions'),
      `${modelId} (Zen) url must not contain /chat/completions`
    );
  }
});

test('deepseek-*, kimi-*, glm-*, mimo-*, qwen-* MUST have apiType === "chat-completions"', () => {
  const chatCompletionsModels = [
    'deepseek-v4.1-flash',
    'deepseek-v4-pro',
    'deepseek-flash',
    'kimi-k3',
    'kimi-k2.7-code',
    'kimi-k2.6',
    'glm-5.3',
    'glm-5.3-flash',
    'glm-5.2',
    'glm-5.1',
    'mimo-v2.5',
    'mimo-v2.5-pro',
    'qwen3.8-flash',
    'qwen3.8-max',
    'qwen3.7-max',
    'qwen3.6-plus',
  ];

  for (const modelId of chatCompletionsModels) {
    const goModel = enrichModel(modelId, { isGo: true });
    assert.equal(
      goModel.apiType,
      'chat-completions',
      `${modelId} must have apiType === 'chat-completions'`
    );
    assert.ok(
      goModel.url.endsWith('/chat/completions'),
      `${modelId} url must end with /chat/completions, got: ${goModel.url}`
    );

    const zenModel = enrichModel(modelId, { isGo: false });
    assert.equal(
      zenModel.apiType,
      'chat-completions',
      `${modelId} (Zen) must have apiType === 'chat-completions'`
    );
    assert.ok(
      zenModel.url.endsWith('/chat/completions'),
      `${modelId} (Zen) url must end with /chat/completions, got: ${zenModel.url}`
    );
  }
});

test('All models MUST retain x-opencode-session: "vscode-copilot" in requestHeaders', () => {
  const representativeModels = [
    { id: 'muse-spark-1.3-contributor-free', options: { isFree: true } },
    { id: 'gpt-5.5', options: { isGo: true } },
    { id: 'grok-4.6', options: { isGo: true } },
    { id: 'claude-sonnet-5', options: { isGo: true } },
    { id: 'deepseek-v4.1-flash', options: { isGo: true } },
    { id: 'kimi-k3', options: { isGo: true } },
    { id: 'glm-5.3', options: { isGo: true } },
    { id: 'mimo-v2.5', options: { isGo: true } },
    { id: 'qwen3.8-flash', options: { isGo: true } },
    { id: 'big-pickle', options: { isFree: true } },
  ];

  for (const { id, options } of representativeModels) {
    const model = enrichModel(id, options);
    assert.ok(
      model.requestHeaders,
      `Model ${id} must include requestHeaders`
    );
    assert.equal(
      model.requestHeaders['x-opencode-session'],
      'vscode-copilot',
      `Model ${id} must retain x-opencode-session: "vscode-copilot"`
    );
  }

  // Also verify default options (isGo defaults to true) retains header across all families
  const defaultOptionModels = [
    'muse-spark-1.3-contributor-free',
    'gpt-5.5',
    'grok-4.6',
    'claude-sonnet-5',
    'deepseek-v4.1-flash',
    'kimi-k3',
    'glm-5.3',
    'mimo-v2.5',
    'qwen3.8-flash',
  ];

  for (const id of defaultOptionModels) {
    const model = enrichModel(id);
    assert.equal(
      model.requestHeaders?.['x-opencode-session'],
      'vscode-copilot',
      `Default enriched model ${id} must retain x-opencode-session header`
    );
  }
});

test('isResponsesModel returns true for responses models and false for others', () => {
  // Required true assertions
  assert.equal(isResponsesModel('muse-spark-1.3-contributor-free'), true);
  assert.equal(isResponsesModel('gpt-5.5'), true);
  assert.equal(isResponsesModel('grok-4.6'), true);

  // Additional responses models
  assert.equal(isResponsesModel('muse-spark-1.2-contributor-free'), true);
  assert.equal(isResponsesModel('gpt-5.6-terra'), true);
  assert.equal(isResponsesModel('gpt-5-mini'), true);
  assert.equal(isResponsesModel('grok-4.5'), true);

  // Required false assertions
  assert.equal(isResponsesModel('deepseek-v4.1-flash'), false);
  assert.equal(isResponsesModel('kimi-k3'), false);

  // Additional chat-completions / messages models
  assert.equal(isResponsesModel('claude-sonnet-5'), false);
  assert.equal(isResponsesModel('glm-5.3'), false);
  assert.equal(isResponsesModel('mimo-v2.5'), false);
  assert.equal(isResponsesModel('qwen3.8-flash'), false);
});

test('All Muse models MUST have thinking === true and valid supportsReasoningEffort without "max"', () => {
  const museVariants = [
    'muse-spark-1.3',
    'muse-spark-1.3-contributor',
    'muse-spark-1.3-contributor-free',
    'muse-spark-1.2-contributor-free',
  ];

  for (const id of museVariants) {
    const model = enrichModel(id);
    assert.equal(model.thinking, true, `${id} must have thinking === true`);
    assert.ok(Array.isArray(model.supportsReasoningEffort), `${id} must have supportsReasoningEffort array`);
    assert.ok(!model.supportsReasoningEffort.includes('max'), `${id} must never include 'max' effort`);
    assert.ok(model.supportsReasoningEffort.includes('high'), `${id} must include 'high' effort`);
  }
});

test('VERIFIED_OPENCODE_MODELS static fallback includes all Muse models with thinking: true', async () => {
  const { VERIFIED_OPENCODE_MODELS } = await import('../out/provider.js');
  const museIds = [
    'muse-spark-1.3',
    'muse-spark-1.3-contributor',
    'muse-spark-1.3-contributor-free',
  ];
  for (const id of museIds) {
    const found = VERIFIED_OPENCODE_MODELS.find(m => m.id === id);
    assert.ok(found, `VERIFIED_OPENCODE_MODELS must include ${id}`);
    assert.equal(found.thinking, true, `${id} must have thinking: true in static fallback`);
    assert.ok(Array.isArray(found.supportsReasoningEffort), `${id} must have supportsReasoningEffort array`);
    assert.ok(!found.supportsReasoningEffort.includes('max'), `${id} must not include max in static fallback`);
  }
  assert.equal(isResponsesModel('big-pickle'), false);
});
