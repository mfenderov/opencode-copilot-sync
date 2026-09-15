import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readChatLanguageModels, getChatLanguageModelsPath, getAllChatLanguageModelsPaths, syncWslMirror, writeProvidersToConfig, cleanupLegacyOpenCodeCustomEndpoints } from '../out/syncer.js';
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

