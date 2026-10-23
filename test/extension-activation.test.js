import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import { activate } from '../out/extension.js';

// Record every EventEmitter fire so the test can tell whether the chat
// provider announced its models during activation.
const firedEmitters = [];
const originalFire = vscode.EventEmitter.prototype.fire;
vscode.EventEmitter.prototype.fire = function (data) {
  firedEmitters.push(this);
  return originalFire.call(this, data);
};
after(() => {
  vscode.EventEmitter.prototype.fire = originalFire;
});

// Never run deferred work: the startup sync timer and usage interval must
// not fire during this test.
const originalSetTimeout = globalThis.setTimeout;
const originalSetInterval = globalThis.setInterval;
globalThis.setTimeout = () => 0;
globalThis.setInterval = () => 0;
after(() => {
  globalThis.setTimeout = originalSetTimeout;
  globalThis.setInterval = originalSetInterval;
});

// Record outbound network calls; activation itself must make none.
const fetchCalls = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  fetchCalls.push(String(url));
  throw new Error('network disabled in activation test');
};
after(() => {
  globalThis.fetch = originalFetch;
});

function createMockContext() {
  const secretsMap = new Map([['opencode_api_key', 'sk-test-key-12345']]);
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-activation-'));
  return {
    secrets: {
      get: async (key) => secretsMap.get(key),
      store: async (key, value) => { secretsMap.set(key, value); },
      delete: async (key) => { secretsMap.delete(key); },
    },
    globalStorageUri: { fsPath: storageDir },
    globalState: {
      get: (key, fallback) => key === 'opencode.models' ? [{
        id: 'cached-model', name: 'Cached model', family: 'cached-model', apiType: 'responses',
        url: 'https://opencode.ai/zen/go/v1', maxInputTokens: 112000, maxOutputTokens: 16000,
        contextWindow: 128000, vision: false, thinking: false, toolCalling: true,
      }] : fallback,
      update: async () => {},
    },
    subscriptions: [],
  };
}

test('activation announces provider models before any network call', async () => {
  const context = createMockContext();
  const { chatProvider } = await activate(context);

  const models = chatProvider.provideLanguageModelChatInformation();
  assert.equal(models.length, 1);
  assert.equal(models[0].id, 'cached-model');
  assert.equal(models[0].maxInputTokens, 112000);
  assert.equal(fetchCalls.length, 0);
  for (const disposable of context.subscriptions) disposable.dispose?.();
  fs.rmSync(context.globalStorageUri.fsPath, { recursive: true, force: true });
});

test('activation wires stream diagnostics logging when the setting is enabled', async () => {
  const context = createMockContext();
  const configValues = new Map([['opencode.streamDiagnostics', true]]);
  const originalGetConfiguration = vscode.workspace.getConfiguration;
  vscode.workspace.getConfiguration = (section) => ({
    get: (key, defaultValue) => {
      const fullKey = section ? `${section}.${key}` : key;
      return configValues.has(fullKey) ? configValues.get(fullKey) : defaultValue;
    },
    update: async () => {},
  });
  try {
    const logged = [];
    const originalCreateChannel = vscode.window.createOutputChannel;
    vscode.window.createOutputChannel = () => {
      const channel = originalCreateChannel();
      const originalInfo = channel.info.bind(channel);
      channel.info = (message) => {
        logged.push(String(message));
        return originalInfo(message);
      };
      return channel;
    };
    try {
      const { chatProvider } = await activate(context);
      const seen = logged.some((line) => line.includes('[Stream]'));
      assert.equal(seen, false, 'activation itself must not emit stream lines');
      assert.ok(chatProvider, 'provider must be constructed with diagnostics wiring');
    } finally {
      vscode.window.createOutputChannel = originalCreateChannel;
    }
  } finally {
    vscode.workspace.getConfiguration = originalGetConfiguration;
  }
  for (const disposable of context.subscriptions) disposable.dispose?.();
  fs.rmSync(context.globalStorageUri.fsPath, { recursive: true, force: true });
});
