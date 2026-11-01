import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enrichModel } from '../out/models/infrastructure/model-enricher.js';
import { catalogMetadata, modelMetadata } from './helpers/catalog-fixture.js';

function enrich(id, overrides = {}, isGo = true) {
  const provider = isGo ? catalogMetadata([id]).go : catalogMetadata([], [id]).zen;
  return enrichModel(id, { isGo, provider, modelsDevData: modelMetadata(id, overrides) });
}

test('model name, capabilities and token limits come from metadata', () => {
  const model = enrich('dynamic-model', {
    name: 'Upstream Model Name',
    reasoning: true,
    tool_call: false,
    modalities: { input: ['text', 'image'], output: ['text'] },
    limit: { context: 1000000, input: 800000, output: 100000 },
  });
  assert.equal(model.name, 'Upstream Model Name (OpenCode Go)');
  assert.equal(model.family, 'dynamic-model');
  assert.equal(model.vision, true);
  assert.equal(model.thinking, true);
  assert.equal(model.toolCalling, false);
  assert.equal(model.maxInputTokens, 800000);
  assert.equal(model.maxOutputTokens, 100000);
  assert.equal(model.requestHeaders, undefined);
  assert.deepEqual(model.modelOptions, { temperature: null, top_p: null });
});

test('Responses models delegate full-history transport to VS Code', () => {
  const model = enrich('dynamic-model', {
    provider: { npm: '@ai-sdk/openai', api: 'https://opencode.ai/inference/go/openai/v1' },
  });
  assert.equal(model.apiType, 'responses');
  assert.equal(model.statefulResponses, false);
});

test('reasoning effort options come from metadata and omit none', () => {
  const model = enrich('dynamic-model', {
    reasoning: true,
    reasoning_options: [{ type: 'effort', values: ['none', 'low', 'high', 'max'] }],
  });
  assert.deepEqual(model.supportsReasoningEffort, ['low', 'high', 'max']);
});

test('boolean-only and disabled reasoning do not advertise effort options', () => {
  assert.equal(enrich('toggle', { reasoning: true }).supportsReasoningEffort, undefined);
  assert.equal(enrich('disabled', {
    reasoning: false,
    reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
  }).supportsReasoningEffort, undefined);
});

test('model family remains stable across catalogs', () => {
  assert.equal(enrich('shared', {}, true).family, 'shared');
  assert.equal(enrich('shared', {}, false).family, 'shared');
});
