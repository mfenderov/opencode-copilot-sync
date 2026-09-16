import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readChatLanguageModels, getChatLanguageModelsPath, getAllChatLanguageModelsPaths, syncWslMirror, writeProvidersToConfig, cleanupLegacyOpenCodeCustomEndpoints, safeWriteFileSync } from '../out/syncer.js';
import { buildProviderEntry } from '../out/config.js';
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

test('syncWslMirror executes safely without error on non-windows platform', () => {
  assert.doesNotThrow(() => {
    syncWslMirror('/Users/test/chatLanguageModels.json');
  });
});

test('writeProvidersToConfig detects a concurrent write and re-merges against the latest content', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-race-'));
  const testFile = path.join(tmpDir, 'chatLanguageModels.json');
  const v1 = [{ name: 'ExistingV1', vendor: 'customendpoint', models: [] }];
  const v2 = [{ name: 'ExistingV2', vendor: 'customendpoint', models: [] }];
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

  const provider = buildProviderEntry('OpenCode Go', 'sk-test-key', ['kimi-k3'], { isGo: true });
  writeProvidersToConfig([provider], testFile);
  t.mock.restoreAll();

  const updated = JSON.parse(fs.readFileSync(testFile, 'utf-8'));
  const names = updated.map((e) => e.name);
  assert.ok(names.includes('ExistingV2'), 'must preserve the concurrently-written entry, not clobber it');
  assert.ok(!names.includes('ExistingV1'), 'must not write based on the stale initial snapshot');
  assert.ok(names.includes('OpenCode Go'));

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

test('writeProvidersToConfig updates temp config without touching real files', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-test-'));
  const testFile = path.join(tmpDir, 'chatLanguageModels.json');

  const initial = [
    {
      name: 'HF Router',
      vendor: 'customendpoint',
      models: []
    }
  ];
  fs.writeFileSync(testFile, JSON.stringify(initial, null, 2), 'utf-8');

  const mockModelIds = ['deepseek-v4-flash', 'kimi-k3'];
  const provider = buildProviderEntry('OpenCode Go', 'sk-test-key', mockModelIds, { isGo: true });
  writeProvidersToConfig([provider], testFile);

  const updated = JSON.parse(fs.readFileSync(testFile, 'utf-8'));
  assert.equal(updated.length, 2);
  assert.equal(updated[0].name, 'HF Router');
  assert.equal(updated[1].name, 'OpenCode Go');
  assert.equal(updated[1].apiKey, 'sk-test-key');
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

test('writeProvidersToConfig still writes the OpenCode customendpoint entry to a non-primary path (e.g. a remote/WSL/Insiders mirror lacking the native vendor)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-nonprimary-'));
  const storageDir = path.join(tmpDir, 'User', 'globalStorage', 'mfenderov.opencode-copilot-sync');
  fs.mkdirSync(storageDir, { recursive: true });
  const otherPath = path.join(tmpDir, 'RemoteMirror', 'chatLanguageModels.json');
  fs.mkdirSync(path.dirname(otherPath), { recursive: true });
  fs.writeFileSync(otherPath, JSON.stringify([{ name: 'HF Router', vendor: 'customendpoint', models: [] }], null, 2), 'utf-8');

  const provider = buildProviderEntry('OpenCode', 'sk-test-key', ['kimi-k3'], { isGo: true });
  writeProvidersToConfig([provider], otherPath, storageDir);

  const updated = JSON.parse(fs.readFileSync(otherPath, 'utf-8'));
  const names = updated.map((e) => e.name);
  assert.ok(names.includes('OpenCode'), 'non-primary paths must still receive the customendpoint entry');
  assert.ok(names.includes('HF Router'));

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

  cleanupLegacyOpenCodeCustomEndpoints(storageDir);

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

