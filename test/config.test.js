import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeChatLanguageModels, buildProviderEntry } from '../out/config.js';

test('mergeChatLanguageModels preserves other providers and updates OpenCode', () => {
  const existing = [
    {
      name: 'HF Router',
      vendor: 'customendpoint',
      apiKey: 'hf-token',
      models: []
    },
    {
      name: 'OpenCode Go',
      vendor: 'customendpoint',
      apiKey: 'old-key',
      models: []
    }
  ];

  const newProvider = {
    name: 'OpenCode Go',
    vendor: 'customendpoint',
    apiKey: 'new-key',
    apiType: 'chat-completions',
    models: [{ id: 'deepseek-v4-flash' }]
  };

  const merged = mergeChatLanguageModels(existing, [newProvider]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].name, 'HF Router');
  assert.equal(merged[1].name, 'OpenCode Go');
  assert.equal(merged[1].apiKey, 'new-key');
  assert.equal(merged[1].models.length, 1);
});

test('mergeChatLanguageModels appends new provider if not present', () => {
  const existing = [
    {
      name: 'HF Router',
      vendor: 'customendpoint',
      models: []
    }
  ];

  const newProvider = {
    name: 'OpenCode',
    vendor: 'customendpoint',
    apiKey: 'new-key',
    models: []
  };

  const merged = mergeChatLanguageModels(existing, [newProvider]);
  assert.equal(merged.length, 2);
  assert.equal(merged[1].name, 'OpenCode');
});

test('mergeChatLanguageModels cleans up legacy OpenCode Go and OpenCode Zen Free providers when unified OpenCode is added', () => {
  const existing = [
    { name: 'HF Router', vendor: 'customendpoint', models: [] },
    { name: 'OpenCode Go', vendor: 'customendpoint', models: [] },
    { name: 'OpenCode Zen Free', vendor: 'customendpoint', models: [] }
  ];

  const unified = {
    name: 'OpenCode',
    vendor: 'customendpoint',
    apiKey: 'key',
    models: [{ id: 'deepseek-v4-flash' }]
  };

  const merged = mergeChatLanguageModels(existing, [unified]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].name, 'HF Router');
  assert.equal(merged[1].name, 'OpenCode');
});

test('mergeChatLanguageModels cleans up legacy Customprovider or Custom Endpoint entries containing OpenCode models', () => {
  const existing = [
    { name: 'HF Router', vendor: 'customendpoint', models: [{ id: 'claude-3-opus', url: 'https://hf.co/v1' }] },
    { name: 'Customprovider', vendor: 'customendpoint', apiKey: 'sk-old', models: [{ id: 'deepseek-v4-flash', url: 'https://opencode.ai/zen/go/v1/chat/completions' }] },
    { name: 'Custom Endpoint', vendor: 'customendpoint', apiKey: 'sk-old2', models: [] }
  ];

  const unified = {
    name: 'OpenCode',
    vendor: 'customendpoint',
    apiKey: 'new-key',
    models: [{ id: 'deepseek-v4-flash' }]
  };

  const merged = mergeChatLanguageModels(existing, [unified]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].name, 'HF Router');
  assert.equal(merged[1].name, 'OpenCode');
  assert.equal(merged[1].apiKey, 'new-key');
});

test('mergeChatLanguageModels preserves secret input reference ${input:...} on existing provider', () => {
  const existing = [
    {
      name: 'OpenCode',
      vendor: 'customendpoint',
      apiKey: '${input:chat.lm.secret.customendpoint.OpenCode.apiKey}',
      models: [{ id: 'old-model' }]
    }
  ];

  const incoming = {
    name: 'OpenCode',
    vendor: 'customendpoint',
    apiKey: 'sk-raw-key',
    models: [{ id: 'new-model' }]
  };

  const merged = mergeChatLanguageModels(existing, [incoming]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].apiKey, '${input:chat.lm.secret.customendpoint.OpenCode.apiKey}', 'Secret storage reference must be preserved');
  assert.equal(merged[0].models[0].id, 'new-model');
});

test('mergeChatLanguageModels preserves existing models when new provider has empty models array', () => {
  const existing = [
    {
      name: 'OpenCode',
      vendor: 'customendpoint',
      apiKey: 'valid-key',
      models: [{ id: 'deepseek-v4-flash' }, { id: 'kimi-k3' }]
    }
  ];

  const emptyUpdate = {
    name: 'OpenCode',
    vendor: 'customendpoint',
    apiKey: 'valid-key',
    models: []
  };

  const merged = mergeChatLanguageModels(existing, [emptyUpdate]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].models.length, 2, 'Existing models must be preserved instead of being wiped out');
});

