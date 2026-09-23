import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readChatLanguageModels,
  getChatLanguageModelsPath,
  getAllChatLanguageModelsPaths,
  syncWslMirror,
  writeProvidersToConfig,
  cleanupLegacyOpenCodeCustomEndpoints,
  safeWriteFileSync,
  syncOpenCodeModels,
} from '../out/syncer.js';
import { buildProviderEntry } from '../out/config.js';
import * as syncerModule from '../out/syncer.js';
import { setVSCodeProxyUrl } from '../out/network.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

test('getChatLanguageModelsPath returns a path ending in chatLanguageModels.json', () => {
  const p = getChatLanguageModelsPath();
  assert.ok(p.endsWith('chatLanguageModels.json'));
});

test('getChatLanguageModelsPath derives server path from activeExtensionStoragePath', () => {
  const mockServerStorage = path.join(os.homedir(), '.vscode-server', 'data', 'User', 'globalStorage', 'mfenderov.opencode-copilot-sync');
  const derived = getChatLanguageModelsPath(mockServerStorage);
  assert.equal(derived, path.join(os.homedir(), '.vscode-server', 'data', 'User', 'chatLanguageModels.json'));
});

test('getChatLanguageModelsPath trusts activeExtensionStoragePath unconditionally for portable/VSCodium/custom user-data-dir installs', () => {
  // Simulate a portable install / custom --user-data-dir / VSCodium storage folder that
  // (a) doesn't exist on disk yet (fresh install) and (b) doesn't contain "Code" or
  // ".vscode-server" in its path — the old heuristic would abandon this authoritative
  // path and fall back to a hardcoded (wrong) platform guess in that case.
  const portableStorage = path.join(
    os.tmpdir(),
    `opencode-portable-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    'user-data',
    'User',
    'globalStorage',
    'mfenderov.opencode-copilot-sync'
  );
  assert.ok(!fs.existsSync(path.dirname(portableStorage)), 'precondition: dir must not exist yet');
  const derived = getChatLanguageModelsPath(portableStorage);
  assert.equal(derived, path.resolve(portableStorage, '..', '..', 'chatLanguageModels.json'));
});

test('getAllChatLanguageModelsPaths includes candidates', () => {
  const paths = getAllChatLanguageModelsPaths();
  assert.ok(paths.length >= 1);
  assert.ok(paths[0].endsWith('chatLanguageModels.json'));
});

test('buildUnifiedModels gives Go catalog models priority over Zen overlap', () => {
  const buildUnifiedModels = syncerModule.buildUnifiedModels;
  assert.equal(typeof buildUnifiedModels, 'function', 'catalog model construction must be independently testable');

  const { models, zenCount } = buildUnifiedModels(
    ['kimi-k3', 'deepseek-v4-flash'],
    ['kimi-k3', 'big-pickle'],
    {}
  );

  assert.deepEqual(models.map((model) => model.id), ['kimi-k3', 'deepseek-v4-flash', 'big-pickle']);
  assert.equal(models[0].url, 'https://opencode.ai/zen/go/v1/chat/completions');
  assert.equal(models[2].url, 'https://opencode.ai/zen/v1/chat/completions');
  assert.equal(models[2].isFree, true);
  assert.equal(zenCount, 1);
});

test('syncOpenCodeModels fetches catalogs, merges Go priority, and never stores the source key', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-sync-models-'));
  const storageDir = path.join(tmpDir, 'User', 'globalStorage', 'mfenderov.opencode-copilot-sync');
  fs.mkdirSync(storageDir, { recursive: true });
  const primaryPath = getChatLanguageModelsPath(storageDir);
  fs.writeFileSync(
    primaryPath,
    JSON.stringify([
      { name: 'HF Router', vendor: 'customendpoint', models: [{ id: 'hf-model' }] },
      { name: 'OpenCode', vendor: 'customendpoint', apiKey: 'sk-old-local-key', models: [{ id: 'old-model' }] },
    ], null, 2),
    'utf8'
  );

  const originalFetch = globalThis.fetch;
  const previousNoProxy = process.env.NO_PROXY;
  const previousOffline = process.env.OPENCODE_OFFLINE;
  let calls = 0;
  process.env.NO_PROXY = '*';
  delete process.env.OPENCODE_OFFLINE;
  setVSCodeProxyUrl(undefined);
  globalThis.fetch = async (input) => {
    calls++;
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.pathname.endsWith('/models')) {
      const ids = url.pathname.includes('/go/')
        ? ['kimi-k3', 'deepseek-v4-flash']
        : ['kimi-k3', 'big-pickle'];
      return new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200 });
    }
    if (url.hostname === 'models.opencode.ai') {
      return new Response('{}', { status: 200 });
    }
    throw new Error(`Unexpected test URL: ${url.href}`);
  };

  try {
    const result = await syncOpenCodeModels('sk-source-only-key', {
      storagePath: storageDir,
      targetPath: primaryPath,
    });

    assert.equal(result.goCount, 2);
    assert.equal(result.zenCount, 1);
    assert.equal(result.totalCount, 3);
    assert.deepEqual(result.models.map((model) => model.id), ['kimi-k3', 'deepseek-v4-flash', 'big-pickle']);
    assert.equal(calls, 3);
    assert.deepEqual(JSON.parse(fs.readFileSync(primaryPath, 'utf8')).map((entry) => entry.name), ['HF Router']);
    assert.doesNotMatch(fs.readFileSync(primaryPath, 'utf8'), /sk-source-only-key|sk-old-local-key/);
  } finally {
    globalThis.fetch = originalFetch;
    setVSCodeProxyUrl(undefined);
    if (previousNoProxy === undefined) delete process.env.NO_PROXY;
    else process.env.NO_PROXY = previousNoProxy;
    if (previousOffline === undefined) delete process.env.OPENCODE_OFFLINE;
    else process.env.OPENCODE_OFFLINE = previousOffline;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('syncWslMirror merges only the OpenCode provider into explicit targets', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-wsl-mirror-'));
  const primaryPath = path.join(tmpDir, 'primary', 'chatLanguageModels.json');
  const mirrorPath = path.join(tmpDir, 'associated-wsl', 'chatLanguageModels.json');
  fs.mkdirSync(path.dirname(mirrorPath), { recursive: true });

  const secretReference = '${input:chat.lm.secret.7f3a2c91}';
  fs.writeFileSync(
    mirrorPath,
    JSON.stringify([
      { name: 'HF Router', vendor: 'customendpoint', apiKey: 'hf-key', models: [{ id: 'hf-model' }] },
      { name: 'OpenCode', vendor: 'customendpoint', apiKey: secretReference, models: [{ id: 'old-model' }] },
    ], null, 2),
    'utf-8'
  );

  const provider = buildProviderEntry('OpenCode', 'sk-source-only-key', ['kimi-k3'], { isGo: true });
  const result = syncWslMirror([provider], [mirrorPath], primaryPath);

  const updated = JSON.parse(fs.readFileSync(mirrorPath, 'utf-8'));
  assert.deepEqual(updated.map((entry) => entry.name), ['HF Router', 'OpenCode']);
  assert.deepEqual(updated[0].models, [{ id: 'hf-model' }]);
  assert.equal(updated[1].apiKey, secretReference);
  assert.equal(updated[1].models[0].id, 'kimi-k3');
  assert.deepEqual(result.writtenPaths, [mirrorPath]);
  assert.doesNotMatch(fs.readFileSync(mirrorPath, 'utf-8'), /sk-source-only-key/);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('writeProvidersToConfig detects a concurrent write and re-merges against the latest content', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-race-'));
  const testFile = path.join(tmpDir, 'chatLanguageModels.json');
  const secretReference = '${input:chat.lm.secret.7f3a2c91}';
  const v1 = [
    { name: 'ExistingV1', vendor: 'customendpoint', models: [] },
    { name: 'OpenCode', vendor: 'customendpoint', apiKey: secretReference, models: [] },
  ];
  const v2 = [
    { name: 'ExistingV2', vendor: 'customendpoint', models: [] },
    { name: 'OpenCode', vendor: 'customendpoint', apiKey: secretReference, models: [] },
  ];
  fs.writeFileSync(testFile, JSON.stringify(v1, null, 2), 'utf-8');

  const originalReadFileSync = fs.readFileSync;
  let callsForTestFile = 0;
  t.mock.method(fs, 'readFileSync', (p, ...rest) => {
    if (p === testFile) {
      callsForTestFile++;
      // The first two reads are our own initial snapshot + readChatLanguageModels()
      // parse of it. From the 3rd read onward (the pre-write re-check), simulate
      // another VS Code window having landed v2 in the meantime.
      return JSON.stringify(callsForTestFile <= 2 ? v1 : v2, null, 2);
    }
    return originalReadFileSync.call(fs, p, ...rest);
  });

  const provider = buildProviderEntry('OpenCode', 'sk-test-key', ['kimi-k3'], { isGo: true });
  writeProvidersToConfig([provider], testFile);
  t.mock.restoreAll();

  const updated = JSON.parse(fs.readFileSync(testFile, 'utf-8'));
  const names = updated.map((e) => e.name);
  assert.ok(
    names.includes('ExistingV2'),
    `must preserve the concurrently-written entry, not clobber it; got ${JSON.stringify(updated)}`
  );
  assert.ok(!names.includes('ExistingV1'), 'must not write based on the stale initial snapshot');
  assert.ok(names.includes('OpenCode'));
  assert.equal(updated.find((e) => e.name === 'OpenCode').apiKey, secretReference);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('safeWriteFileSync preserves the existing file mode on rewrite instead of resetting it', { skip: process.platform === 'win32' }, () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-mode-'));
  const testFile = path.join(tmpDir, 'chatLanguageModels.json');
  fs.writeFileSync(testFile, '[]', { mode: 0o640 });
  fs.chmodSync(testFile, 0o640); // writeFileSync's mode is subject to umask; force it explicitly

  safeWriteFileSync(testFile, JSON.stringify([{ name: 'x' }]));

  const mode = fs.statSync(testFile).mode & 0o777;
  assert.equal(mode, 0o640, 'rewrite must preserve the pre-existing permission bits');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('safeWriteFileSync writes correct content and cleans up its temp file', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-fsync-'));
  const testFile = path.join(tmpDir, 'chatLanguageModels.json');

  safeWriteFileSync(testFile, JSON.stringify([{ name: 'y' }]));

  assert.deepEqual(JSON.parse(fs.readFileSync(testFile, 'utf-8')), [{ name: 'y' }]);
  const leftoverTmp = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.tmp'));
  assert.equal(leftoverTmp.length, 0, 'no leftover .tmp file should remain after a successful write');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('safeWriteFileSync falls back to a direct write if atomic rename fails', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-fsync-fallback-'));
  const testFile = path.join(tmpDir, 'chatLanguageModels.json');
  t.mock.method(fs, 'renameSync', () => {
    throw new Error('simulated rename failure');
  });

  safeWriteFileSync(testFile, '{"fallback": true}');

  assert.deepEqual(JSON.parse(fs.readFileSync(testFile, 'utf-8')), { fallback: true });
  assert.deepEqual(fs.readdirSync(tmpDir), ['chatLanguageModels.json']);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('writeProvidersToConfig updates temp config without touching real files', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-test-'));
  const testFile = path.join(tmpDir, 'chatLanguageModels.json');

  const initial = [
    {
      name: 'HF Router',
      vendor: 'customendpoint',
      models: []
    },
    {
      name: 'OpenCode',
      vendor: 'customendpoint',
      apiKey: '${input:chat.lm.secret.7f3a2c91}',
      models: []
    }
  ];
  fs.writeFileSync(testFile, JSON.stringify(initial, null, 2), 'utf-8');

  const mockModelIds = ['deepseek-v4-flash', 'kimi-k3'];
  const provider = buildProviderEntry('OpenCode', 'sk-test-key', mockModelIds, { isGo: true });
  writeProvidersToConfig([provider], testFile);

  const updated = JSON.parse(fs.readFileSync(testFile, 'utf-8'));
  assert.equal(updated.length, 2);
  assert.equal(updated[0].name, 'HF Router');
  assert.equal(updated[1].name, 'OpenCode');
  assert.equal(updated[1].apiKey, '${input:chat.lm.secret.7f3a2c91}');
  assert.doesNotMatch(fs.readFileSync(testFile, 'utf-8'), /sk-test-key/);
  assert.equal(updated[1].models.length, 2);
  assert.deepEqual(updated[1].models[0].requestHeaders, { 'x-opencode-session': 'vscode-copilot' });

  // Clean up
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('writeProvidersToConfig purges (does not re-add) the OpenCode customendpoint entry at the local primary path, since the native `opencode` vendor already covers models there and a duplicate is how the reasoning `encrypted_content` idle-expiry bug gets triggered', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-primary-purge-'));
  const storageDir = path.join(tmpDir, 'User', 'globalStorage', 'mfenderov.opencode-copilot-sync');
  fs.mkdirSync(storageDir, { recursive: true });

  const primaryPath = getChatLanguageModelsPath(storageDir);
  assert.equal(primaryPath, path.join(tmpDir, 'User', 'chatLanguageModels.json'), 'sanity check on derivation');

  const initial = [
    { name: 'HF Router', vendor: 'customendpoint', models: [] },
    { name: 'OpenCode', vendor: 'customendpoint', models: [{ id: 'kimi-k3' }] },
  ];
  fs.writeFileSync(primaryPath, JSON.stringify(initial, null, 2), 'utf-8');

  const provider = buildProviderEntry('OpenCode', 'sk-test-key', ['kimi-k3'], { isGo: true });
  writeProvidersToConfig([provider], primaryPath, storageDir);

  const updated = JSON.parse(fs.readFileSync(primaryPath, 'utf-8'));
  assert.deepEqual(
    updated.map((e) => e.name),
    ['HF Router'],
    'OpenCode customendpoint entry must be purged (not re-added) at the local primary path, leaving unrelated entries untouched'
  );

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('writeProvidersToConfig updates an OpenCode mirror using its target-local secret reference', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-nonprimary-'));
  const storageDir = path.join(tmpDir, 'User', 'globalStorage', 'mfenderov.opencode-copilot-sync');
  fs.mkdirSync(storageDir, { recursive: true });
  const otherPath = path.join(tmpDir, 'RemoteMirror', 'chatLanguageModels.json');
  fs.mkdirSync(path.dirname(otherPath), { recursive: true });
  const secretReference = '${input:chat.lm.secret.7f3a2c91}';
  fs.writeFileSync(
    otherPath,
    JSON.stringify([
      { name: 'HF Router', vendor: 'customendpoint', models: [] },
      { name: 'OpenCode', vendor: 'customendpoint', apiKey: secretReference, models: [{ id: 'old-model' }] },
    ], null, 2),
    'utf-8'
  );

  const provider = buildProviderEntry('OpenCode', 'sk-test-key', ['kimi-k3'], { isGo: true });
  writeProvidersToConfig([provider], otherPath, storageDir);

  const updated = JSON.parse(fs.readFileSync(otherPath, 'utf-8'));
  const names = updated.map((e) => e.name);
  assert.ok(names.includes('OpenCode'), 'non-primary paths must still receive the customendpoint entry');
  assert.ok(names.includes('HF Router'));
  assert.equal(updated.find((entry) => entry.name === 'OpenCode').apiKey, secretReference);
  assert.doesNotMatch(fs.readFileSync(otherPath, 'utf-8'), /sk-test-key/);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('writeProvidersToConfig purges only the primary OpenCode entry and safely merges each mirror', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-target-merge-'));
  const storageDir = path.join(tmpDir, 'User', 'globalStorage', 'mfenderov.opencode-copilot-sync');
  fs.mkdirSync(storageDir, { recursive: true });

  const primaryPath = getChatLanguageModelsPath(storageDir);
  const mirrorPath = path.join(tmpDir, 'Remote', 'User', 'chatLanguageModels.json');
  const unconfiguredPath = path.join(tmpDir, 'OtherProfile', 'User', 'chatLanguageModels.json');
  const rawKeyPath = path.join(tmpDir, 'Legacy', 'User', 'chatLanguageModels.json');
  for (const targetPath of [mirrorPath, unconfiguredPath, rawKeyPath]) {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  }

  const secretReference = '${input:chat.lm.secret.7f3a2c91}';
  const primaryOriginal = [
    { name: 'HF Router', vendor: 'customendpoint', apiKey: 'hf-key', models: [] },
    { name: 'OpenCode', vendor: 'customendpoint', apiKey: 'sk-old-primary-key', models: [{ id: 'old-model' }] },
  ];
  const mirrorOriginal = [
    { name: 'HF Router', vendor: 'customendpoint', apiKey: 'hf-key', models: [{ id: 'hf-model' }] },
    { name: 'OpenCode', vendor: 'customendpoint', apiKey: secretReference, models: [{ id: 'old-model' }] },
  ];
  const unconfiguredOriginal = [{ name: 'HF Router', vendor: 'customendpoint', models: [] }];
  const rawKeyOriginal = [{ name: 'OpenCode', vendor: 'customendpoint', apiKey: 'sk-target-key', models: [{ id: 'old-model' }] }];
  fs.writeFileSync(primaryPath, JSON.stringify(primaryOriginal, null, 2), 'utf-8');
  fs.writeFileSync(mirrorPath, JSON.stringify(mirrorOriginal, null, 2), 'utf-8');
  fs.writeFileSync(unconfiguredPath, JSON.stringify(unconfiguredOriginal, null, 2), 'utf-8');
  fs.writeFileSync(rawKeyPath, JSON.stringify(rawKeyOriginal, null, 2), 'utf-8');
  const rawKeyContents = fs.readFileSync(rawKeyPath, 'utf-8');

  const provider = buildProviderEntry('OpenCode', 'sk-current-source-key', ['kimi-k3'], { isGo: true });
  const result = writeProvidersToConfig([provider], primaryPath, storageDir, {
    additionalTargetPaths: [mirrorPath, unconfiguredPath, rawKeyPath],
  });

  const primary = JSON.parse(fs.readFileSync(primaryPath, 'utf-8'));
  const mirror = JSON.parse(fs.readFileSync(mirrorPath, 'utf-8'));
  const unconfigured = JSON.parse(fs.readFileSync(unconfiguredPath, 'utf-8'));

  assert.deepEqual(primary.map((entry) => entry.name), ['HF Router']);
  assert.deepEqual(mirror.map((entry) => entry.name), ['HF Router', 'OpenCode']);
  assert.deepEqual(mirror[0].models, mirrorOriginal[0].models);
  assert.equal(mirror[1].apiKey, secretReference);
  assert.equal(mirror[1].models[0].id, 'kimi-k3');
  assert.deepEqual(unconfigured, unconfiguredOriginal);
  assert.equal(fs.readFileSync(rawKeyPath, 'utf-8'), rawKeyContents);
  assert.ok(result.warnings.some((warning) => warning.includes(unconfiguredPath)));
  assert.ok(result.warnings.some((warning) => warning.includes(rawKeyPath)));
  assert.doesNotMatch(fs.readFileSync(primaryPath, 'utf-8'), /sk-current-source-key|sk-old-primary-key/);
  assert.doesNotMatch(fs.readFileSync(mirrorPath, 'utf-8'), /sk-current-source-key/);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('writeProvidersToConfig reports an explicitly associated WSL target with no existing VS Code profile', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-missing-wsl-profile-'));
  const homeDir = path.join(tmpDir, 'current-user');
  const storageDir = path.join(homeDir, '.vscode-server', 'data', 'User', 'globalStorage', 'mfenderov.opencode-copilot-sync');
  const associatedWslHome = path.join(tmpDir, 'wsl', 'Ubuntu', 'home', 'wsl-user');
  fs.mkdirSync(storageDir, { recursive: true });
  fs.mkdirSync(associatedWslHome, { recursive: true });

  const provider = buildProviderEntry('OpenCode', 'sk-in-memory-only', ['kimi-k3'], { isGo: true });
  const result = writeProvidersToConfig([provider], undefined, storageDir, {
    discoveryContext: {
      platform: 'linux',
      homeDir,
      isWsl: true,
      associatedWslHome,
    },
  });

  assert.ok(
    result.warnings.some((warning) => warning.includes('associated WSL') && warning.includes('additionalSyncTargets'))
  );

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('writeProvidersToConfig recognizes an exact opt-in path under the associated WSL home', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-explicit-associated-wsl-'));
  const homeDir = path.join(tmpDir, 'current-user');
  const storageDir = path.join(homeDir, '.vscode-server', 'data', 'User', 'globalStorage', 'mfenderov.opencode-copilot-sync');
  const associatedWslHome = path.join(tmpDir, 'wsl', 'Ubuntu', 'home', 'wsl-user');
  const explicitWslPath = path.join(associatedWslHome, '.vscode-server', 'data', 'User', 'chatLanguageModels.json');
  fs.mkdirSync(storageDir, { recursive: true });
  fs.mkdirSync(path.dirname(explicitWslPath), { recursive: true });
  fs.writeFileSync(
    explicitWslPath,
    JSON.stringify([
      { name: 'OpenCode', vendor: 'customendpoint', apiKey: '${input:chat.lm.secret.7f3a2c91}', models: [] },
    ]),
    'utf8'
  );

  const provider = buildProviderEntry('OpenCode', 'sk-source-only-key', ['kimi-k3'], { isGo: true });
  const result = writeProvidersToConfig([provider], undefined, storageDir, {
    additionalTargetPaths: [explicitWslPath],
    discoveryContext: { platform: 'linux', homeDir, associatedWslHome },
  });

  assert.deepEqual(result.warnings, []);
  const updated = JSON.parse(fs.readFileSync(explicitWslPath, 'utf8'));
  assert.equal(updated[0].apiKey, '${input:chat.lm.secret.7f3a2c91}');
  assert.equal(updated[0].models[0].id, 'kimi-k3');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('primary backups redact raw OpenCode keys while preserving unrelated providers', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-redacted-backup-'));
  const storageDir = path.join(tmpDir, 'User', 'globalStorage', 'mfenderov.opencode-copilot-sync');
  fs.mkdirSync(storageDir, { recursive: true });
  const primaryPath = getChatLanguageModelsPath(storageDir);
  fs.writeFileSync(
    primaryPath,
    JSON.stringify([
      { name: 'HF Router', vendor: 'customendpoint', apiKey: 'hf-secret', models: [{ id: 'hf-model' }] },
      { name: 'OpenCode', vendor: 'customendpoint', apiKey: 'sk-primary-old-key', models: [{ id: 'kimi-k3' }] },
    ], null, 2),
    'utf8'
  );

  const provider = buildProviderEntry('OpenCode', 'sk-current-key', ['kimi-k3'], { isGo: true });
  const result = writeProvidersToConfig([provider], primaryPath, storageDir);
  assert.ok(result.backupPath);

  const backupText = fs.readFileSync(result.backupPath, 'utf8');
  const backup = JSON.parse(backupText);
  assert.equal(backup[0].apiKey, 'hf-secret');
  assert.equal(backup[1].models[0].id, 'kimi-k3');
  assert.equal(backup[1].apiKey, undefined);
  assert.doesNotMatch(backupText, /sk-primary-old-key|sk-current-key/);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('mirror merge skips duplicate OpenCode entries when one contains a raw key', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-duplicate-mirror-'));
  const storageDir = path.join(tmpDir, 'User', 'globalStorage', 'mfenderov.opencode-copilot-sync');
  fs.mkdirSync(storageDir, { recursive: true });
  const primaryPath = getChatLanguageModelsPath(storageDir);
  const mirrorPath = path.join(tmpDir, 'Remote', 'chatLanguageModels.json');
  fs.mkdirSync(path.dirname(mirrorPath), { recursive: true });
  const secretReference = '${input:chat.lm.secret.7f3a2c91}';
  const original = [
    { name: 'HF Router', vendor: 'customendpoint', models: [{ id: 'hf-model' }] },
    { name: 'OpenCode', vendor: 'customendpoint', apiKey: secretReference, models: [{ id: 'old-model' }] },
    { name: 'OpenCode', vendor: 'customendpoint', apiKey: 'sk-duplicate-key', models: [{ id: 'legacy-model' }] },
  ];
  fs.writeFileSync(mirrorPath, JSON.stringify(original, null, 2), 'utf8');
  const originalText = fs.readFileSync(mirrorPath, 'utf8');

  const provider = buildProviderEntry('OpenCode', 'sk-current-key', ['kimi-k3'], { isGo: true });
  const result = writeProvidersToConfig([provider], primaryPath, storageDir, {
    additionalTargetPaths: [mirrorPath],
  });

  assert.equal(fs.readFileSync(mirrorPath, 'utf8'), originalText);
  assert.ok(result.warnings.some((warning) => warning.includes(mirrorPath)));

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('mirror backups redact raw keys from legacy OpenCode entries', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-redacted-mirror-backup-'));
  const storageDir = path.join(tmpDir, 'User', 'globalStorage', 'mfenderov.opencode-copilot-sync');
  fs.mkdirSync(storageDir, { recursive: true });
  const primaryPath = getChatLanguageModelsPath(storageDir);
  const mirrorPath = path.join(tmpDir, 'Remote', 'chatLanguageModels.json');
  fs.mkdirSync(path.dirname(mirrorPath), { recursive: true });
  const secretReference = '${input:chat.lm.secret.7f3a2c91}';
  const mirrorInitial = [
    { name: 'HF Router', vendor: 'customendpoint', apiKey: 'hf-secret', models: [{ id: 'hf-model' }] },
    { name: 'OpenCode', vendor: 'customendpoint', apiKey: secretReference, models: [{ id: 'old-model' }] },
    { name: 'OpenCode Go', vendor: 'customendpoint', apiKey: 'sk-legacy-mirror-key', models: [{ id: 'old-go-model' }] },
  ];
  fs.writeFileSync(mirrorPath, JSON.stringify(mirrorInitial, null, 2), 'utf8');

  const provider = buildProviderEntry('OpenCode', 'sk-current-key', ['kimi-k3'], { isGo: true });
  writeProvidersToConfig([provider], mirrorPath, storageDir);

  const backupFiles = fs.readdirSync(path.dirname(mirrorPath))
    .filter((file) => file.startsWith('chatLanguageModels.json.bak-'));
  assert.equal(backupFiles.length, 1);
  const backupText = fs.readFileSync(path.join(path.dirname(mirrorPath), backupFiles[0]), 'utf8');
  const backup = JSON.parse(backupText);

  assert.equal(backup[0].apiKey, 'hf-secret');
  assert.equal(backup[1].apiKey, secretReference);
  assert.equal(backup[2].apiKey, undefined);
  assert.doesNotMatch(backupText, /sk-legacy-mirror-key|sk-current-key/);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('writeProvidersToConfig rejects an explicit non-chatLanguageModels target', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-invalid-target-'));
  const storageDir = path.join(tmpDir, 'User', 'globalStorage', 'mfenderov.opencode-copilot-sync');
  fs.mkdirSync(storageDir, { recursive: true });
  const provider = buildProviderEntry('OpenCode', 'sk-source-only-key', ['kimi-k3'], { isGo: true });

  assert.throws(
    () => writeProvidersToConfig([provider], path.join(tmpDir, 'settings.json'), storageDir),
    /chatLanguageModels\.json/
  );

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('cleanupLegacyOpenCodeCustomEndpoints purges OpenCode from storage config', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-cleanup-'));
  // Create mock storage path structure: <tmpDir>/User/globalStorage/mfenderov.opencode-copilot-sync
  const storageDir = path.join(tmpDir, 'User', 'globalStorage', 'mfenderov.opencode-copilot-sync');
  fs.mkdirSync(storageDir, { recursive: true });

  const configPath = path.join(tmpDir, 'User', 'chatLanguageModels.json');
  const initial = [
    { name: 'HF Router', vendor: 'customendpoint', models: [] },
    { name: 'OpenCode', vendor: 'customendpoint', models: [{ id: 'kimi-k3', url: 'https://opencode.ai/zen/go/v1/chat/completions' }] },
    { name: 'OpenCode Go', vendor: 'customendpoint', models: [] }
  ];
  fs.writeFileSync(configPath, JSON.stringify(initial, null, 2), 'utf-8');

  cleanupLegacyOpenCodeCustomEndpoints(storageDir, {
    discoveryContext: { platform: process.platform, homeDir: tmpDir },
  });

  const updated = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  assert.equal(updated.length, 1);
  assert.equal(updated[0].name, 'HF Router');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('package.json extensionKind MUST include both ui and workspace for Remote-WSL compatibility', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8'));
  assert.ok(Array.isArray(pkg.extensionKind), 'extensionKind must be an array');
  assert.ok(
    pkg.extensionKind.includes('ui'),
    'extensionKind must include "ui" so Windows UI host can serve Remote-WSL'
  );
  assert.ok(
    pkg.extensionKind.includes('workspace'),
    'extensionKind must include "workspace"'
  );
});

test('WSL path resolution handles Windows drives with mixed slashes and spaces', () => {
  const testPaths = [
    'C:\\Users\\John Doe\\AppData\\Roaming\\Code\\User\\chatLanguageModels.json',
    'c:/Users/John Doe/AppData/Roaming/Code/User/chatLanguageModels.json',
    'D:\\Data\\Code\\User\\chatLanguageModels.json',
  ];

  for (const p of testPaths) {
    const driveMatch = p.match(/^([A-Za-z]):[\\/](.*)$/);
    assert.ok(driveMatch, `Path ${p} must match drive regex`);
    const letter = driveMatch[1].toLowerCase();
    const rest = driveMatch[2].replace(/\\/g, '/');
    const wslPath = `/mnt/${letter}/${rest}`;
    assert.ok(wslPath.startsWith('/mnt/'));
    assert.ok(!wslPath.includes('\\'));
    assert.ok(wslPath.includes('chatLanguageModels.json'));
  }
});
