import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mergeChatLanguageModels, buildProviderEntry, purgeOpenCodeFromChatLanguageModels } from '../out/config.js';
import * as configModule from '../out/config.js';

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
    {
      name: 'Custom Endpoint',
      vendor: 'customendpoint',
      apiKey: 'sk-old2',
      models: [{ id: 'kimi-k3', url: 'https://opencode.ai/zen/go/v1/chat/completions' }],
    }
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

test('mergeChatLanguageModels preserves VS Code SecretStorage input references on existing providers', () => {
  const existing = [
    {
      name: 'OpenCode',
      vendor: 'customendpoint',
      apiKey: '${input:chat.lm.secret.7f3a2c91}',
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
  assert.equal(merged[0].apiKey, '${input:chat.lm.secret.7f3a2c91}', 'Secret storage reference must be preserved');
  assert.equal(merged[0].models[0].id, 'new-model');
});

test('target mirror merge requires and preserves a VS Code target-local SecretStorage reference', () => {
  const mergeForTarget = configModule.mergeOpenCodeProviderForTarget;
  assert.equal(typeof mergeForTarget, 'function', 'target-local mirror merge must be independently testable');

  const secretReference = '${input:chat.lm.secret.7f3a2c91}';
  const existing = [
    { name: 'HF Router', vendor: 'customendpoint', apiKey: 'hf-secret', models: [{ id: 'hf-model' }] },
    { name: 'OpenCode', vendor: 'customendpoint', apiKey: secretReference, models: [{ id: 'old-model' }] },
  ];
  const incoming = {
    name: 'OpenCode',
    vendor: 'customendpoint',
    apiKey: 'sk-source-only-key',
    apiType: 'chat-completions',
    models: [{ id: 'new-model' }],
  };

  const merged = mergeForTarget(existing, incoming);
  assert.equal(merged.status, 'updated');
  assert.equal(merged.config[0].apiKey, 'hf-secret');
  assert.equal(merged.config[1].apiKey, secretReference);
  assert.equal(merged.config[1].models[0].id, 'new-model');
  assert.doesNotMatch(JSON.stringify(merged.config), /sk-source-only-key/);

  const withoutReference = mergeForTarget([existing[0]], incoming);
  assert.equal(withoutReference.status, 'skipped');
  assert.deepEqual(withoutReference.config, [existing[0]]);
  assert.ok(withoutReference.warning);
  assert.doesNotMatch(JSON.stringify(withoutReference.config), /sk-source-only-key/);

  const unsupportedReference = [{ ...existing[1], apiKey: '${input:customendpoint.OpenCode.apiKey}' }];
  const unsupported = mergeForTarget(unsupportedReference, incoming);
  assert.equal(unsupported.status, 'skipped');
  assert.deepEqual(unsupported.config, unsupportedReference);
  assert.ok(unsupported.warning);
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

test('purgeOpenCodeFromChatLanguageModels purges all OpenCode variants and keeps other providers', () => {
  const existing = [
    { name: 'HF Router', vendor: 'customendpoint', models: [{ id: 'claude-3-opus' }] },
    { name: 'OpenCode', vendor: 'customendpoint', models: [{ id: 'deepseek-v4-flash', url: 'https://opencode.ai/zen/go/v1/chat/completions' }] },
    { name: 'OpenCode Go', vendor: 'customendpoint', models: [] },
    { name: 'OpenCode Zen Free', vendor: 'customendpoint', models: [] },
    { name: 'Customprovider', vendor: 'customendpoint', apiKey: 'sk-test', models: [] }
  ];

  const purged = purgeOpenCodeFromChatLanguageModels(existing);
  assert.equal(purged.length, 2);
  assert.equal(purged[0].name, 'HF Router');
  assert.equal(purged[1].name, 'Customprovider');
});

test('purgeOpenCodeFromChatLanguageModels preserves generic custom endpoints and other vendors named OpenCode', () => {
  const genericCustomEndpoint = {
    name: 'Customprovider',
    vendor: 'customendpoint',
    apiKey: 'sk-unrelated-provider-key',
    models: [],
  };
  const otherVendor = {
    name: 'OpenCode',
    vendor: 'internalgateway',
    apiKey: 'gateway-key',
    models: [{ id: 'private-model' }],
  };

  assert.deepEqual(
    purgeOpenCodeFromChatLanguageModels([genericCustomEndpoint, otherVendor]),
    [genericCustomEndpoint, otherVendor]
  );
});

test('VSIX packaging excludes generated coverage and development-only files', () => {
  const ignore = fs.readFileSync(path.join(process.cwd(), '.vscodeignore'), 'utf8');
  assert.match(ignore, /^coverage\/\*\*$/m);
  assert.match(ignore, /^scripts\/\*\*$/m);
  for (const file of ['.c8rc.json', 'cog.toml', 'crap-baseline.json', 'eslint.config.js', 'eslint-suppressions.json']) {
    assert.ok(ignore.split(/\r?\n/).includes(file), `${file} must not be packaged`);
  }
});
