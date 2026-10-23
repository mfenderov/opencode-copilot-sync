import { test } from 'node:test';
import assert from 'node:assert/strict';

test('honest client: buildUnifiedModels announces Zen IDs as-is with Zen suffix', async () => {
  const { buildUnifiedModels } = await import('../out/models/application/synchronize-models.js');
  const { models } = buildUnifiedModels(['kimi-k3'], ['ling-3.1-flash-free', 'claude-sonnet-4-6'], {});
  const ling = models.find((m) => m.id === 'ling-3.1-flash-free');
  assert.ok(ling, 'Zen catalog IDs must be announced as-is, including -free IDs');
  assert.ok(ling.name.includes('(OpenCode Zen)'), `No (OpenCode Free) suffix may remain, got: ${ling.name}`);
  assert.ok(!models.some((m) => m.name.includes('(OpenCode Free)')));
});

test('honest client: enrichModel has no isFree concept and no Free suffix', async () => {
  const { enrichModel } = await import('../out/models/infrastructure/model-enricher.js');
  const model = enrichModel('ling-3.1-flash-free', { isGo: false });
  assert.equal(model.isFree, undefined, 'isFree field must be gone');
  assert.ok(!model.name.includes('(OpenCode Free)'), `name must not carry the Free-tier suffix, got: ${model.name}`);
  assert.ok(model.name.includes('(OpenCode Zen)'), `Zen IDs keep the Zen suffix, got: ${model.name}`);
  assert.equal(model.requestHeaders, undefined, 'fake x-opencode-session requestHeaders must be gone');
});

test('honest client: models-dev-client exposes no free-tier helpers', async () => {
  const client = await import('../out/models/infrastructure/models-dev-client.js');
  assert.equal('isFreeTierModel' in client, false, 'isFreeTierModel must be deleted');
  assert.equal('filterFreeModels' in client, false, 'filterFreeModels must be deleted');
});
