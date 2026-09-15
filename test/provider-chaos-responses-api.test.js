import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import * as vscode from 'vscode';
import { OpenCodeChatProvider } from '../out/provider.js';
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
// 7. Responses API (Muse) Tests
// ============================================================================

test('Provider Chaos [Responses API (Muse)]: streams response.output_text.delta and emits LanguageModelTextPart', async () => {
  mockServer.setScenario({
    mode: 'standard',
    contentPart1: 'The river bends beneath the silent moon,\n',
    contentPart2: 'Night whispers secrets to the rising dawn.',
  });

  const context = createMockContext();
  const provider = new OpenCodeChatProvider(context);
  const progress = createMockProgress();
  const token = createMockToken();

  await provider.provideLanguageModelChatResponse(
    MUSE_RESPONSES_MODEL,
    [createMockMessage('compose a haiku')],
    {},
    progress,
    token
  );

  // Verify URL routing to /zen/v1/responses
  const requests = mockServer.getRequests();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].pathname, '/zen/v1/responses');
  assert.equal(requests[0].body.model, 'muse-spark-1.3-contributor-free');

  // Verify text parts emitted
  const textParts = progress.parts.filter((p) => p instanceof vscode.LanguageModelTextPart);
  assert.equal(textParts.length, 2);
  assert.equal(textParts[0].value, 'The river bends beneath the silent moon,\n');
  assert.equal(textParts[1].value, 'Night whispers secrets to the rising dawn.');
});

// ============================================================================
// 8. Additional Edge Case Tests: Token Count & Model Information
// ============================================================================

test('Provider [provideTokenCount]: estimates token count from text or message', async () => {
  const context = createMockContext();
  const provider = new OpenCodeChatProvider(context);
  const token = createMockToken();

  const count1 = await provider.provideTokenCount(GO_CHAT_MODEL, 'Hello world from Copilot OpenCode sync!', token);
  assert.equal(count1, Math.ceil('Hello world from Copilot OpenCode sync!'.length / 4));

  const count2 = await provider.provideTokenCount(
    GO_CHAT_MODEL,
    createMockMessage('Test token count on message structure'),
    token
  );
  assert.ok(count2 > 0);
});

test('Provider [provideLanguageModelChatInformation]: dynamically sets reasoningEffort enum strictly to supported levels', async () => {
  const context = createMockContext();
  const provider = new OpenCodeChatProvider(context);

  provider.updateModels([
    {
      id: 'muse-spark-1.3',
      name: 'Muse Spark 1.3',
      family: 'gpt-5-5',
      contextWindow: 1048576,
      maxOutputTokens: 65536,
      vision: true,
      thinking: true,
      supportsReasoningEffort: ['minimal', 'low', 'medium', 'high', 'xhigh'],
    },
    {
      id: 'minimax-m2.5',
      name: 'MiniMax M2.5',
      family: 'minimax-m2.5',
      contextWindow: 1048576,
      maxOutputTokens: 65536,
      vision: false,
      thinking: true,
    },
    {
      id: 'qwen3.7-max',
      name: 'Qwen 3.7 Max',
      family: 'qwen3.7-max',
      contextWindow: 1000000,
      maxOutputTokens: 131072,
      vision: true,
      thinking: false,
    },
  ]);

  const token = createMockToken();
  const info = await provider.provideLanguageModelChatInformation({}, token);

  const museInfo = info.find((m) => m.id === 'muse-spark-1.3');
  assert.ok(museInfo);
  assert.equal(museInfo.capabilities.thinking, true);
  assert.deepEqual(museInfo.supportsReasoningEffort, ['minimal', 'low', 'medium', 'high', 'xhigh']);
  assert.ok(!museInfo.supportsReasoningEffort.includes('max'), 'Muse must not advertise max');
  const museSchema = museInfo.configurationSchema?.properties?.reasoningEffort;
  assert.ok(museSchema);
  assert.deepEqual(museSchema.enum, ['minimal', 'low', 'medium', 'high', 'xhigh']);
  assert.deepEqual(museSchema.enumItemLabels, ['Minimal', 'Low', 'Medium', 'High', 'Extra High']);

  const minimaxInfo = info.find((m) => m.id === 'minimax-m2.5');
  assert.ok(minimaxInfo);
  assert.equal(minimaxInfo.capabilities.thinking, true);
  assert.strictEqual(minimaxInfo.supportsReasoningEffort, undefined);
  assert.strictEqual(minimaxInfo.configurationSchema?.properties?.reasoningEffort, undefined, 'Boolean reasoning must have no effort property');

  const qwenInfo = info.find((m) => m.id === 'qwen3.7-max');
  assert.ok(qwenInfo);
  assert.equal(qwenInfo.capabilities.thinking, false);
  assert.strictEqual(qwenInfo.supportsReasoningEffort, undefined);
  assert.strictEqual(qwenInfo.configurationSchema?.properties?.reasoningEffort, undefined);
});
