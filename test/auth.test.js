import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getStoredOpenCodeKey, getKeyFromExistingConfig } from '../out/auth.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

test('getStoredOpenCodeKey finds key in opencode auth file if it exists', () => {
  const authPath = path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json');
  if (fs.existsSync(authPath)) {
    const key = getStoredOpenCodeKey();
    assert.ok(typeof key === 'string');
    assert.ok(key.startsWith('sk-'));
  }
});

test('getStoredOpenCodeKey returns null if file does not exist', () => {
  const key = getStoredOpenCodeKey('/non/existent/path/auth.json');
  assert.equal(key, null);
});

test('getKeyFromExistingConfig extracts valid OpenCode API key from chatLanguageModels.json', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-auth-test-'));
  const testFile = path.join(tmpDir, 'chatLanguageModels.json');
  const dummy = [
    {
      name: 'OpenCode',
      vendor: 'customendpoint',
      apiKey: 'sk-test-extracted-key-12345',
      models: []
    }
  ];
  fs.writeFileSync(testFile, JSON.stringify(dummy), 'utf-8');

  const key = getKeyFromExistingConfig(testFile);
  assert.equal(key, 'sk-test-extracted-key-12345');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('getKeyFromExistingConfig extracts key from Customprovider or Custom Endpoint entry', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-auth-test-custom-'));
  const testFile = path.join(tmpDir, 'chatLanguageModels.json');
  const dummy = [
    {
      name: 'Customprovider',
      vendor: 'customendpoint',
      apiKey: 'sk-custom-provider-key-999',
      models: [{ id: 'deepseek-v4-flash', url: 'https://opencode.ai/zen/go/v1/chat/completions' }]
    }
  ];
  fs.writeFileSync(testFile, JSON.stringify(dummy), 'utf-8');

  const key = getKeyFromExistingConfig(testFile);
  assert.equal(key, 'sk-custom-provider-key-999');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('getKeyFromExistingConfig returns null if file has no matching provider or key', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-auth-test-empty-'));
  const testFile = path.join(tmpDir, 'chatLanguageModels.json');
  fs.writeFileSync(testFile, JSON.stringify([{ name: 'Other', apiKey: 'sk-other' }]), 'utf-8');

  const key = getKeyFromExistingConfig(testFile);
  assert.equal(key, null);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

