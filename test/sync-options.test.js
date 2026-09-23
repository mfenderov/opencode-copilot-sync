import { test } from 'node:test';
import assert from 'node:assert/strict';

async function loadSyncOptions() {
  try {
    return await import('../out/sync-options.js');
  } catch {
    assert.fail('Extension sync settings must be parsed by a testable helper.');
  }
}

test('buildSyncOptions reads catalog flags and exact additional target paths', async () => {
  const { buildSyncOptions } = await loadSyncOptions();
  assert.equal(typeof buildSyncOptions, 'function');

  const values = {
    includeGoModels: false,
    includeZenModels: true,
    additionalSyncTargets: ['/tmp/profile/chatLanguageModels.json'],
  };
  const options = buildSyncOptions(
    { get: (key, fallback) => values[key] ?? fallback },
    '/tmp/extension-storage',
    'wsl+Ubuntu'
  );

  assert.deepEqual(options, {
    includeGo: false,
    includeZen: true,
    storagePath: '/tmp/extension-storage',
    remoteName: 'wsl+Ubuntu',
    additionalTargetPaths: ['/tmp/profile/chatLanguageModels.json'],
  });
});

test('buildSyncOptions rejects a malformed additional target setting', async () => {
  const { buildSyncOptions } = await loadSyncOptions();

  assert.throws(
    () => buildSyncOptions({ get: (key, fallback) => key === 'additionalSyncTargets' ? [42] : fallback }, '/tmp/storage'),
    /additionalSyncTargets/
  );
});

test('shouldPromptForApiKey prompts only for interactive non-CI syncs', async () => {
  const { shouldPromptForApiKey } = await loadSyncOptions();
  assert.equal(typeof shouldPromptForApiKey, 'function');
  assert.equal(shouldPromptForApiKey(true, false), true);
  assert.equal(shouldPromptForApiKey(false, false), false);
  assert.equal(shouldPromptForApiKey(true, true), false);
});
