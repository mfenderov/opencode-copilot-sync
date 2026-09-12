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
