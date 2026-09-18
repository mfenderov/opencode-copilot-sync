// This file MUST set OPENCODE_STREAM_IDLE_TIMEOUT_MS before '../out/provider.js'
// evaluates its top-level module code, because STREAM_IDLE_TIMEOUT_MS is read
// once at module-load time. Static `import` specifiers are hoisted above all
// other statements in an ES module, so a plain top-level assignment here would
// run too late. We use a dynamic `import()` instead, which is NOT hoisted, to
// guarantee the env var is set first. Node's test runner isolates each
// *.test.js file into its own process, so this override does not leak into
// other test files.
process.env.OPENCODE_STREAM_IDLE_TIMEOUT_MS = '150';

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import * as vscode from 'vscode';
import { startMockServer } from './helpers/mock-opencode-server.js';

const { OpenCodeChatProvider } = await import('../out/provider.js');

let mockServer;
let originalFetch;

before(async () => {
  mockServer = await startMockServer(0);
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    let target = input;
    if (typeof target === 'string') {
      if (target.startsWith('https://opencode.ai/zen/')) {
        target = target.replace('https://opencode.ai', mockServer.url);
      }
    } else if (target instanceof URL) {
      if (target.origin === 'https://opencode.ai' && target.pathname.startsWith('/zen/')) {
        target = new URL(target.pathname + target.search, mockServer.url);
      }
    } else if (target && typeof target.url === 'string') {
      if (target.url.startsWith('https://opencode.ai/zen/')) {
        target = new Request(target.url.replace('https://opencode.ai', mockServer.url), target);
      }
    }
    return originalFetch(target, init);
  };
});

after(async () => {
  globalThis.fetch = originalFetch;
  if (mockServer) {
    await mockServer.close();
  }
});

beforeEach(() => {
  mockServer.resetScenarios();
  mockServer.clearRequests();
});

function createMockContext(apiKey = 'sk-test-key-12345') {
  const secretsMap = new Map();
  if (apiKey) secretsMap.set('opencode_api_key', apiKey);
  return {
    secrets: {
      get: async (key) => secretsMap.get(key),
      store: async (key, val) => { secretsMap.set(key, val); },
      delete: async (key) => { secretsMap.delete(key); },
    },
    globalStorageUri: {
      fsPath: path.resolve(process.cwd(), '.test-user-data', 'idle-timeout-storage'),
    },
  };
}

function createMockProgress() {
  const parts = [];
  return { parts, report(part) { parts.push(part); } };
}

function createMockToken() {
  const emitter = new vscode.EventEmitter();
  return {
    isCancellationRequested: false,
    onCancellationRequested: emitter.event,
    cancel() {
      this.isCancellationRequested = true;
      emitter.fire();
    },
  };
}

function createMockMessage(text, role = vscode.LanguageModelChatMessageRole.User) {
  return { role, content: [new vscode.LanguageModelTextPart(text)] };
}

const GO_CHAT_MODEL = {
  id: 'deepseek-v4-pro',
  name: 'DeepSeek V4 Pro (OpenCode Go)',
  family: 'deepseek-v4-pro',
};

test('Idle-timeout watchdog: a stalled stream with no data is surfaced as a friendly interruption message, not a hang', async () => {
  mockServer.setScenario({ mode: 'stall' });

  const context = createMockContext();
  const provider = new OpenCodeChatProvider(context);
  const progress = createMockProgress();
  const token = createMockToken();

  const start = Date.now();
  await provider.provideLanguageModelChatResponse(
    GO_CHAT_MODEL,
    [createMockMessage('this stream will stall')],
    {},
    progress,
    token
  );
  const elapsed = Date.now() - start;

  // Must resolve well before the mocha/test-runner default timeout, proving
  // the idle watchdog (150ms in this file) fired rather than hanging until
  // some external timeout or the (default 90s) production idle limit.
  assert.ok(elapsed < 5000, `expected the idle watchdog to resolve quickly, took ${elapsed}ms`);

  const textParts = progress.parts.filter((p) => p instanceof vscode.LanguageModelTextPart);
  const combined = textParts.map((p) => p.value).join('');
  assert.match(combined, /Initial partial response before stalling/);
  assert.match(combined, /stream interrupted/i);
  assert.match(combined, /idle/i);
});

test('Idle-timeout auto-recovery: when stream stalls with zero bytes, retries once and completes transparently', async () => {
  mockServer.setScenario([
    { mode: 'silent-stall' },
    { mode: 'standard', content: 'Recovered after zero-byte stall!' },
  ]);

  const context = createMockContext();
  const provider = new OpenCodeChatProvider(context);
  const progress = createMockProgress();
  const token = createMockToken();

  const start = Date.now();
  await provider.provideLanguageModelChatResponse(
    GO_CHAT_MODEL,
    [createMockMessage('hello stall recovery')],
    {},
    progress,
    token
  );
  const elapsed = Date.now() - start;

  assert.ok(elapsed < 5000, `expected recovery within timeout budget, took ${elapsed}ms`);

  const requests = mockServer.getRequests();
  assert.equal(requests.length, 2, 'expected exactly 2 upstream requests (initial stall + auto-retry)');
  assert.notEqual(
    requests[0].headers['x-opencode-request'],
    requests[1].headers['x-opencode-request'],
    'retry must use a fresh request ID'
  );

  const textParts = progress.parts.filter((p) => p instanceof vscode.LanguageModelTextPart);
  const combined = textParts.map((p) => p.value).join('');
  assert.match(combined, /Recovered after zero-byte stall!/);
  assert.doesNotMatch(combined, /stream interrupted/i, 'should not report interruption when recovery succeeds');
});

test('Idle-timeout auto-recovery: when retry also stalls with zero bytes, surfaces interruption message', async () => {
  mockServer.setScenario([
    { mode: 'silent-stall' },
    { mode: 'silent-stall' },
  ]);

  const context = createMockContext();
  const provider = new OpenCodeChatProvider(context);
  const progress = createMockProgress();
  const token = createMockToken();

  await provider.provideLanguageModelChatResponse(
    GO_CHAT_MODEL,
    [createMockMessage('double stall')],
    {},
    progress,
    token
  );

  const requests = mockServer.getRequests();
  assert.equal(requests.length, 2, 'expected exactly 2 upstream requests');

  const textParts = progress.parts.filter((p) => p instanceof vscode.LanguageModelTextPart);
  const combined = textParts.map((p) => p.value).join('');
  assert.match(combined, /stream interrupted/i);
  assert.match(combined, /idle for over/i);
});

