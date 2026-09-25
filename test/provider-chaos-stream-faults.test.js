import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import * as vscode from 'vscode';
import { OpenCodeChatProvider } from '../out/chat/infrastructure/vscode-chat-provider.js';
import { startMockServer } from './helpers/mock-opencode-server.js';

let mockServer;
let originalFetch;

before(async () => {
  mockServer = await startMockServer(0);

  // Intercept globalThis.fetch to redirect https://opencode.ai/zen/ requests to the local mock server
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

/**
 * Creates an in-memory vscode.ExtensionContext mock
 * @param {string} [apiKey='sk-test-key-12345']
 */
function createMockContext(apiKey = 'sk-test-key-12345') {
  const secretsMap = new Map();
  if (apiKey) {
    secretsMap.set('opencode_api_key', apiKey);
  }

  return {
    secrets: {
      get: async (key) => secretsMap.get(key),
      store: async (key, val) => {
        secretsMap.set(key, val);
      },
      delete: async (key) => {
        secretsMap.delete(key);
      },
    },
    globalStorageUri: {
      fsPath: path.resolve(process.cwd(), '.test-user-data', 'chaos-storage'),
    },
  };
}

/**
 * Creates a mock progress collector
 */
function createMockProgress() {
  const parts = [];
  return {
    parts,
    report(part) {
      parts.push(part);
    },
  };
}

/**
 * Creates a mock CancellationToken
 */
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

/**
 * Helper to build a simple user chat request message
 */
function createMockMessage(text, role = vscode.LanguageModelChatMessageRole.User) {
  return {
    role,
    content: [new vscode.LanguageModelTextPart(text)],
  };
}

// Test models for various catalog & routing combinations
const GO_CHAT_MODEL = {
  id: 'deepseek-v4-pro',
  name: 'DeepSeek V4 Pro (OpenCode Go)',
  family: 'deepseek-v4-pro',
};

const MUSE_RESPONSES_MODEL = {
  id: 'muse-spark-1.3-contributor-free',
  name: 'Muse Spark 1.3 Contributor (OpenCode Free)',
  family: 'muse-spark-1.3-contributor-free',
};

// ============================================================================
// 4. Socket Drop (Chaos) Tests
// ============================================================================

test('Provider Chaos [Socket Drop]: catches mid-stream disconnect and reports interruption without crashing', async () => {
  mockServer.setScenario({ mode: 'drop' });

  const context = createMockContext();
  const provider = new OpenCodeChatProvider(context);
  const progress = createMockProgress();
  const token = createMockToken();

  // Must NOT crash or unhandled reject
  await provider.provideLanguageModelChatResponse(
    GO_CHAT_MODEL,
    [createMockMessage('stream interrupted test')],
    {},
    progress,
    token
  );

  assert.ok(progress.parts.length >= 2, `Expected at least 2 parts (partial text + interruption notice), got ${progress.parts.length}`);

  // First part should be the partial text streamed before socket drop
  assert.ok(progress.parts[0] instanceof vscode.LanguageModelTextPart);
  assert.equal(progress.parts[0].value, 'Initial partial response before drop...');

  // The last part should report the interruption gracefully to the user
  const lastPart = progress.parts[progress.parts.length - 1];
  assert.ok(lastPart instanceof vscode.LanguageModelTextPart);
  assert.match(lastPart.value, /Response stream interrupted:/);
});

test('Provider Chaos [Socket Drop on Responses API]: catches disconnect on Responses stream', async () => {
  mockServer.setScenario({ mode: 'drop' });

  const context = createMockContext();
  const provider = new OpenCodeChatProvider(context);
  const progress = createMockProgress();
  const token = createMockToken();

  await provider.provideLanguageModelChatResponse(
    MUSE_RESPONSES_MODEL,
    [createMockMessage('stream drop test')],
    {},
    progress,
    token
  );

  assert.ok(progress.parts.length >= 2);
  assert.equal(progress.parts[0].value, 'Initial partial response before drop...');
  const lastPart = progress.parts[progress.parts.length - 1];
  assert.match(lastPart.value, /Response stream interrupted:/);
});

// ============================================================================
// 8b. Keep-Alive & Cancellation Tests
// ============================================================================

test('Provider Chaos [Keep-Alive Lines]: handles : keep-alive comments before SSE data stream', async () => {
  mockServer.setScenario({
    mode: 'keep-alive',
    keepAliveCount: 3,
    content: 'Data arrived after 3 keep-alive heartbeats.',
  });

  const context = createMockContext();
  const provider = new OpenCodeChatProvider(context);
  const progress = createMockProgress();
  const token = createMockToken();

  await provider.provideLanguageModelChatResponse(
    GO_CHAT_MODEL,
    [createMockMessage('hello with keepalive')],
    {},
    progress,
    token
  );

  const textParts = progress.parts.filter((p) => p instanceof vscode.LanguageModelTextPart);
  assert.ok(textParts.length >= 1);
  assert.equal(textParts[0].value, 'Data arrived after 3 keep-alive heartbeats.');
});

test('Provider Chaos [Cancellation]: aborts in-flight request when token is canceled', async () => {
  mockServer.setScenario({
    mode: 'standard',
    delayMs: 30,
    contentPart1: 'Chunk 1',
    contentPart2: 'Chunk 2',
  });

  const context = createMockContext();
  const provider = new OpenCodeChatProvider(context);
  const progress = createMockProgress();
  const token = createMockToken();

  const promise = provider.provideLanguageModelChatResponse(
    GO_CHAT_MODEL,
    [createMockMessage('cancel me')],
    {},
    progress,
    token
  );

  // Cancel immediately
  setTimeout(() => token.cancel(), 5);

  // Should resolve cleanly without throwing unhandled abort errors to the caller
  await promise;
});
