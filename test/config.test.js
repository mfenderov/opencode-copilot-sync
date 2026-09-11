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
    name: 'OpenCode Go',
    vendor: 'customendpoint',
    apiKey: 'new-key',
    models: []
  };

  const merged = mergeChatLanguageModels(existing, [newProvider]);
  assert.equal(merged.length, 2);
  assert.equal(merged[1].name, 'OpenCode Go');
});
