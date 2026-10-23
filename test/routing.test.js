import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enrichModel } from '../out/models/infrastructure/model-enricher.js';

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

    // Zen catalog variant
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

test('enriched models carry no fake session headers (honest client)', () => {
  const representativeModels = [
    'muse-spark-1.3-contributor',
    'gpt-5.5',
    'deepseek-v4.1-flash',
    'kimi-k3',
    'big-pickle',
  ];

  for (const id of representativeModels) {
    const model = enrichModel(id, { isGo: true });
    assert.equal(
      model.requestHeaders,
      undefined,
      `Model ${id} must not carry fake session headers`
    );
  }
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

