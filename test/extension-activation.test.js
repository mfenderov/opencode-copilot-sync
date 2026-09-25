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
    subscriptions: [],
  };
}

test('activation announces provider models before any network call', async () => {
  const context = createMockContext();
  const { chatProvider } = await activate(context);

  // _onDidChange is TS-private but runtime-accessible; identity check is the
  // only way to attribute the fire to the chat provider's emitter.
  assert.ok(
    firedEmitters.includes(chatProvider._onDidChange),
    'expected the chat provider change event to fire during activation'
  );
  assert.equal(fetchCalls.length, 0);
});
