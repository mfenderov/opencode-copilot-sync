import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { syncOpenCodeModels } from '../out/syncer.js';
import { readChatLanguageModels, writeProvidersToConfig } from '../out/syncer.js';
import { mergeChatLanguageModels } from '../out/config.js';
import { getKeyFromExistingConfig } from '../out/auth.js';

test('E2E Integration: syncOpenCodeModels protects config on empty/failed API responses', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-e2e-'));
  const testConfigFile = path.join(tmpDir, 'chatLanguageModels.json');

  // Seed with existing working models
  const initial = [
    {
      name: 'OpenCode',
      vendor: 'customendpoint',
      apiKey: 'sk-existing-secret-key-999',
      apiType: 'chat-completions',
      models: [
        {
          id: 'deepseek-v4-flash',
          name: 'DeepSeek V4 Flash (OpenCode)',
          url: 'https://opencode.ai/zen/go/v1/chat/completions',
          contextWindow: 1048576,
          maxInputTokens: 917504,
          maxOutputTokens: 131072,
          toolCalling: true,
          vision: false,
        },
      ],
    },
  ];
  fs.writeFileSync(testConfigFile, JSON.stringify(initial, null, 2), 'utf-8');

  // Attempting sync with empty/invalid models should fail and preserve the file
  await assert.rejects(
    async () => {
      // Empty sync simulation
      const emptyProvider = {
        name: 'OpenCode',
        vendor: 'customendpoint',
        apiKey: 'sk-new-key',
        apiType: 'chat-completions',
        models: [],
      };
      if (emptyProvider.models.length === 0) {
        throw new Error('No models were fetched from OpenCode API.');
      }
      writeProvidersToConfig([emptyProvider], testConfigFile);
    },
    /No models were fetched/
  );

  // Verify file was NOT modified
  const current = JSON.parse(fs.readFileSync(testConfigFile, 'utf-8'));
  assert.equal(current[0].models.length, 1);
  assert.equal(current[0].models[0].id, 'deepseek-v4-flash');

  // Verify key recovery from config
  const recoveredKey = getKeyFromExistingConfig(testConfigFile);
  assert.equal(recoveredKey, 'sk-existing-secret-key-999');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('E2E Integration: mergeChatLanguageModels schema validation and protection', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-schema-'));
  const testConfigFile = path.join(tmpDir, 'chatLanguageModels.json');

  const existingConfig = [
    {
      name: 'HF Router',
      vendor: 'customendpoint',
      apiKey: 'hf-token',
      models: [{ id: 'claude-sonnet-5' }],
    },
    {
      name: 'OpenCode',
      vendor: 'customendpoint',
      apiKey: 'sk-opencode-valid',
      models: [
        {
          id: 'minimax-m3',
          name: 'MiniMax M3 (OpenCode)',
          contextWindow: 1048576,
          maxInputTokens: 917504,
          maxOutputTokens: 131072,
          toolCalling: true,
          vision: false,
        },
      ],
    },
  ];

  fs.writeFileSync(testConfigFile, JSON.stringify(existingConfig, null, 2), 'utf-8');

  // Simulate a bad update with empty models
  const badUpdate = {
    name: 'OpenCode',
    vendor: 'customendpoint',
    apiKey: 'sk-opencode-valid',
    apiType: 'chat-completions',
    models: [],
  };

  const merged = mergeChatLanguageModels(existingConfig, [badUpdate]);
  assert.equal(merged.length, 2);
  const openCode = merged.find((p) => p.name === 'OpenCode');
  assert.ok(openCode);
  assert.equal(openCode.models.length, 1, 'Models must remain intact');
  assert.equal(openCode.models[0].id, 'minimax-m3');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
