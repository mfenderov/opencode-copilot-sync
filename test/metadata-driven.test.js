import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchModelsDevMetadata } from '../out/models/infrastructure/models-dev-client.js';
import { buildUnifiedModels } from '../out/models/application/synchronize-models.js';
import { enrichModel } from '../out/models/infrastructure/model-enricher.js';

function model(id, provider = undefined) {
  return {
    id,
    name: `Name ${id}`,
    limit: { context: 1000000, input: 800000, output: 100000 },
    modalities: { input: ['text', 'image'], output: ['text'] },
    reasoning: true,
    reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
    tool_call: true,
    ...(provider ? { provider } : {}),
  };
}

function catalogs() {
  return {
    zen: {
      npm: '@ai-sdk/openai-compatible',
      api: 'https://opencode.ai/inference/openai/v1',
      models: {
        shared: model('shared', { npm: '@ai-sdk/google', api: 'https://opencode.ai/inference/google/v1beta' }),
        'zen-only': model('zen-only'),
        'go-missing': model('go-missing'),
      },
    },
    go: {
      npm: '@ai-sdk/openai-compatible',
      api: 'https://opencode.ai/inference/go/openai/v1',
      models: {
        shared: model('shared', { npm: '@ai-sdk/anthropic', api: 'https://opencode.ai/inference/go/anthropic/v1' }),
      },
    },
  };
}

test('metadata fetch retains separate Go and Zen provider defaults and overrides', async (t) => {
  const previousFetch = globalThis.fetch;
  const previousNoProxy = process.env.NO_PROXY;
  t.after(() => {
    globalThis.fetch = previousFetch;
    if (previousNoProxy === undefined) delete process.env.NO_PROXY;
    else process.env.NO_PROXY = previousNoProxy;
  });
  process.env.NO_PROXY = '*';
  const source = catalogs();
  globalThis.fetch = async () => new Response(JSON.stringify({
    opencode: source.zen,
    'opencode-go': source.go,
  }), { status: 200, headers: { 'content-type': 'application/json' } });

  const metadata = await fetchModelsDevMetadata();
  assert.equal(metadata.zen?.npm, '@ai-sdk/openai-compatible');
  assert.equal(metadata.go?.api, 'https://opencode.ai/inference/go/openai/v1');
  assert.equal(metadata.zen?.models.shared.provider.npm, '@ai-sdk/google');
  assert.equal(metadata.go?.models.shared.provider.npm, '@ai-sdk/anthropic');
});

test('model sync skips missing metadata without silently falling back to Zen billing', () => {
  const result = buildUnifiedModels(
    ['shared', 'go-missing'],
    ['shared', 'go-missing', 'zen-only', 'zen-missing'],
    catalogs(),
  );
  assert.deepEqual(result.models.map((item) => item.id), ['shared', 'zen-only']);
  assert.equal(result.models[0].catalog, 'go');
  assert.match(result.warnings.join('\n'), /go-missing/i);
  assert.match(result.warnings.join('\n'), /zen-missing/i);
});

test('model transport, limits and capabilities come from upstream metadata', () => {
  const source = catalogs().zen;
  const result = enrichModel('shared', {
    isGo: false,
    provider: source,
    modelsDevData: source.models.shared,
  });
  assert.equal(result.providerPackage, '@ai-sdk/google');
  assert.equal(result.apiType, 'google');
  assert.equal(result.url, 'https://opencode.ai/inference/google/v1beta');
  assert.equal(result.name, 'Name shared (OpenCode Zen)');
  assert.equal(result.maxInputTokens, 800000);
  assert.equal(result.maxOutputTokens, 100000);
  assert.equal(result.toolCalling, true);
  assert.deepEqual(result.supportsReasoningEffort, ['low', 'high']);
});

test('model-specific endpoint overrides inherit their catalog SDK default', () => {
  const source = catalogs().zen;
  const result = enrichModel('zen-only', {
    isGo: false,
    provider: source,
    modelsDevData: model('zen-only', { api: 'https://opencode.ai/inference/openai/v1' }),
  });
  assert.equal(result.providerPackage, '@ai-sdk/openai-compatible');
  assert.equal(result.apiType, 'chat-completions');
});

test('tool support follows metadata rather than being assumed for every model', () => {
  const source = catalogs().zen;
  const result = enrichModel('no-tools', {
    isGo: false,
    provider: source,
    modelsDevData: { ...model('no-tools'), tool_call: false },
  });
  assert.equal(result.toolCalling, false);
});

test('missing token limits are rejected rather than filled with guessed values', () => {
  const source = catalogs().zen;
  assert.throws(() => enrichModel('unknown-limit', {
    isGo: false,
    provider: source,
    modelsDevData: { ...model('unknown-limit'), limit: undefined },
  }), /limit/i);
});

test('unknown SDK packages are rejected instead of guessed from the model name', () => {
  const source = catalogs().zen;
  assert.throws(() => enrichModel('gpt-new', {
    isGo: false,
    provider: source,
    modelsDevData: model('gpt-new', { npm: '@ai-sdk/future', api: source.api }),
  }), /unsupported.*@ai-sdk\/future/i);
});

test('untrusted metadata endpoints cannot receive the OpenCode API key', () => {
  const source = catalogs().zen;
  assert.throws(() => enrichModel('safe-name', {
    isGo: false,
    provider: source,
    modelsDevData: model('safe-name', { api: 'https://example.com/inference/v1' }),
  }), /untrusted|unsupported.*endpoint/i);
});

test('metadata service failures are reported instead of returning an empty catalog', async (t) => {
  const previousFetch = globalThis.fetch;
  const previousNoProxy = process.env.NO_PROXY;
  t.after(() => {
    globalThis.fetch = previousFetch;
    if (previousNoProxy === undefined) delete process.env.NO_PROXY;
    else process.env.NO_PROXY = previousNoProxy;
  });
  process.env.NO_PROXY = '*';
  globalThis.fetch = async () => new Response('unavailable', { status: 503 });
  await assert.rejects(fetchModelsDevMetadata(), /metadata.*unavailable/i);
});
