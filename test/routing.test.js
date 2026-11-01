import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enrichModel } from '../out/models/infrastructure/model-enricher.js';
import { catalogMetadata, modelMetadata } from './helpers/catalog-fixture.js';

for (const [providerPackage, apiType] of [
  ['@ai-sdk/openai-compatible', 'chat-completions'],
  ['@ai-sdk/openai', 'responses'],
  ['@ai-sdk/anthropic', 'messages'],
  ['@ai-sdk/google', 'google'],
  ['@ai-sdk/mistral', 'chat-completions'],
]) {
  test(`${providerPackage} metadata selects its declared protocol regardless of model name`, () => {
    const provider = catalogMetadata(['gpt-looking-name']).go;
    const model = enrichModel('gpt-looking-name', {
      isGo: true,
      provider,
      modelsDevData: modelMetadata('gpt-looking-name', {
        provider: { npm: providerPackage, api: 'https://opencode.ai/inference/go/provider/v1' },
      }),
    });
    assert.equal(model.providerPackage, providerPackage);
    assert.equal(model.apiType, apiType);
    assert.equal(model.url, 'https://opencode.ai/inference/go/provider/v1');
    assert.equal(model.catalog, 'go');
    assert.equal(model.requestHeaders, undefined);
  });
}
