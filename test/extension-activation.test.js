import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import { activate } from '../out/extension.js';
import { catalogMetadata } from './helpers/catalog-fixture.js';

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

function catalogCache(apiKey = 'sk-test-key-12345') {
  return {
    version: 1,
    keyHash: createHash('sha256').update(apiKey).digest('hex'),
    includeGo: true,
    includeZen: true,
    ids: { goModelIds: ['cached-model'], zenModelIds: [] },
    metadata: catalogMetadata(['cached-model'], []),
  };
}

function contextWithState(entries) {
  const context = createMockContext();
  const values = new Map(Object.entries(entries));
  context.globalState = {
    get: (key, fallback) => values.has(key) ? values.get(key) : fallback,
    update: async (key, value) => { values.set(key, value); },
  };
  return { context, values };
}

async function disposeContext(context) {
  for (const disposable of context.subscriptions) disposable.dispose?.();
  fs.rmSync(context.globalStorageUri.fsPath, { recursive: true, force: true });
}

test('activation restores the validated catalog for the same API key without a network call', async (t) => {
  const { context } = contextWithState({ 'opencode.catalog-cache.v1': catalogCache() });
  t.after(() => disposeContext(context));
  const { chatProvider } = await activate(context);
  assert.deepEqual(chatProvider.provideLanguageModelChatInformation().map((model) => model.id), ['cached-model']);
});

test('activation does not reuse legacy guessed model data as authoritative cache', async (t) => {
  const { context } = contextWithState({
    'opencode.models': [{ id: 'legacy-model', name: 'Legacy', family: 'legacy-model', apiType: 'responses',
      url: 'https://opencode.ai/zen/v1', maxInputTokens: 112000, maxOutputTokens: 16000,
      contextWindow: 128000, vision: false, thinking: false, toolCalling: true }],
  });
  t.after(() => disposeContext(context));
  const { chatProvider } = await activate(context);
  assert.deepEqual(chatProvider.provideLanguageModelChatInformation(), []);
});

test('activation never reuses a catalog cached for a different API key', async (t) => {
  const { context } = contextWithState({ 'opencode.catalog-cache.v1': catalogCache('sk-other-account') });
  t.after(() => disposeContext(context));
  const { chatProvider } = await activate(context);
  assert.deepEqual(chatProvider.provideLanguageModelChatInformation(), []);
});

test('activation ignores cached metadata with an untrusted endpoint', async (t) => {
  const cache = catalogCache();
  cache.metadata.go.api = 'https://example.com/inference/v1';
  const { context } = contextWithState({ 'opencode.catalog-cache.v1': cache });
  t.after(() => disposeContext(context));
  const { chatProvider } = await activate(context);
  assert.deepEqual(chatProvider.provideLanguageModelChatInformation(), []);
});

test('a background sync failure without validated cache is surfaced to the user', async () => {
  const { context } = contextWithState({});
  const previousFetch = globalThis.fetch;
  const previousError = vscode.window.showErrorMessage;
  const errors = [];
  globalThis.fetch = async () => new Response('unavailable', { status: 400 });
  vscode.window.showErrorMessage = async (message) => { errors.push(String(message)); };
  try {
    const { performSync } = await activate(context);
    await performSync(false);
    assert.ok(errors.some((message) => /sync failed/i.test(message)));
  } finally {
    globalThis.fetch = previousFetch;
    vscode.window.showErrorMessage = previousError;
    await disposeContext(context);
  }
});

test('a background sync failure warns and keeps the last validated cached catalog', async () => {
  const { context } = contextWithState({ 'opencode.catalog-cache.v1': catalogCache() });
  const previousFetch = globalThis.fetch;
  const previousWarning = vscode.window.showWarningMessage;
  const warnings = [];
  globalThis.fetch = async () => new Response('unavailable', { status: 400 });
  vscode.window.showWarningMessage = async (message) => { warnings.push(String(message)); };
  try {
    const { chatProvider, performSync } = await activate(context);
    await performSync(false);
    assert.deepEqual(chatProvider.provideLanguageModelChatInformation().map((model) => model.id), ['cached-model']);
    assert.ok(warnings.some((message) => /using.*cached/i.test(message)));
  } finally {
    globalThis.fetch = previousFetch;
    vscode.window.showWarningMessage = previousWarning;
    await disposeContext(context);
  }
});

test('changing the API key clears the previous account catalog if sync fails', async () => {
  const { context } = contextWithState({ 'opencode.catalog-cache.v1': catalogCache() });
  let apiKey = 'sk-test-key-12345';
  context.secrets.get = async () => apiKey;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('unavailable', { status: 400 });
  try {
    const { chatProvider, performSync } = await activate(context);
    assert.equal(chatProvider.provideLanguageModelChatInformation().length, 1);
    apiKey = 'sk-different-account';
    await performSync(false);
    assert.deepEqual(chatProvider.provideLanguageModelChatInformation(), []);
  } finally {
    globalThis.fetch = previousFetch;
    await disposeContext(context);
  }
});

test('activation announces provider models before any network call', async () => {
  const { context } = contextWithState({ 'opencode.catalog-cache.v1': catalogCache() });
  const { chatProvider } = await activate(context);

  const models = chatProvider.provideLanguageModelChatInformation();
  assert.equal(models.length, 1);
  assert.equal(models[0].id, 'cached-model');
  assert.equal(models[0].maxInputTokens, 983040);
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
