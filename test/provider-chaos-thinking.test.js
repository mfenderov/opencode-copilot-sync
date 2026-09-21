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
// 5. Thinking / Reasoning Streaming Tests
// ============================================================================

test('Provider Chaos [Thinking Streaming]: reports reasoning via LanguageModelThinkingPart without empty-string suppression', async () => {
  mockServer.setScenario({
    mode: 'thinking',
    reasoning: 'Analyzing algorithm step 1: initialize pointers.\nStep 2: binary search.',
    content: 'The optimized algorithm achieves O(log n) time complexity.',
  });

  const context = createMockContext();
  const provider = new OpenCodeChatProvider(context);
  const progress = createMockProgress();
  const token = createMockToken();

  await provider.provideLanguageModelChatResponse(
    GO_CHAT_MODEL,
    [createMockMessage('analyze complexity')],
    { modelConfiguration: { reasoningEffort: 'high' } },
    progress,
    token
  );

  const thinkingParts = progress.parts.filter((p) => p instanceof vscode.LanguageModelThinkingPart);
  const textParts = progress.parts.filter((p) => p instanceof vscode.LanguageModelTextPart);

  assert.ok(thinkingParts.length >= 1, 'Expected at least 1 LanguageModelThinkingPart');
  assert.equal(
    thinkingParts[0].value,
    'Analyzing algorithm step 1: initialize pointers.\nStep 2: binary search.'
  );
  assert.ok(thinkingParts[0].value.length > 0, 'Reasoning text must not be empty');

  assert.ok(textParts.length >= 1, 'Expected at least 1 LanguageModelTextPart');
  assert.equal(
    textParts[0].value,
    'The optimized algorithm achieves O(log n) time complexity.'
  );
});

test('Provider Chaos [Thinking Streaming]: handles inline <think> tags correctly', async () => {
  mockServer.setScenario({
    mode: 'standard',
    chunks: [
      {
        id: 'chatcmpl-think-inline',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'deepseek-v4-pro',
        choices: [{
          index: 0,
          delta: { role: 'assistant', content: '<think>Exploring mathematical axioms...</think>Theorem is proven.' },
          finish_reason: null,
        }],
      },
      {
        id: 'chatcmpl-think-inline',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'deepseek-v4-pro',
        choices: [{
          index: 0,
          delta: {},
          finish_reason: 'stop',
        }],
      },
    ],
  });

  const context = createMockContext();
  const provider = new OpenCodeChatProvider(context);
  const progress = createMockProgress();
  const token = createMockToken();

  await provider.provideLanguageModelChatResponse(
    GO_CHAT_MODEL,
    [createMockMessage('prove theorem')],
    {},
    progress,
    token
  );

  const thinkingParts = progress.parts.filter((p) => p instanceof vscode.LanguageModelThinkingPart);
  const textParts = progress.parts.filter((p) => p instanceof vscode.LanguageModelTextPart);

  assert.equal(thinkingParts.length, 1);
  assert.equal(thinkingParts[0].value, 'Exploring mathematical axioms...');

  assert.equal(textParts.length, 1);
  assert.equal(textParts[0].value, 'Theorem is proven.');
});

test('Provider Chaos [Thinking Streaming on Responses API (Muse)]: emits LanguageModelThinkingPart on response.reasoning_text.delta', async () => {
  mockServer.clearRequests();
  mockServer.setScenario({
    mode: 'thinking',
    reasoning: 'Muse deep thinking: step 1 theorem proof.',
    content: 'The proof concludes here.',
  });

  const context = createMockContext();
  const provider = new OpenCodeChatProvider(context);
  const progress = createMockProgress();
  const token = createMockToken();

  await provider.provideLanguageModelChatResponse(
    MUSE_RESPONSES_MODEL,
    [createMockMessage('prove theorem')],
    { modelConfiguration: { reasoningEffort: 'high' } },
    progress,
    token
  );

  const thinkingParts = progress.parts.filter((p) => p instanceof vscode.LanguageModelThinkingPart);
  const textParts = progress.parts.filter((p) => p instanceof vscode.LanguageModelTextPart);

  assert.ok(thinkingParts.length >= 1, 'Expected at least 1 LanguageModelThinkingPart for Muse');
  assert.ok(
    thinkingParts.some((p) => p.value === 'Muse deep thinking: step 1 theorem proof.'),
    'Expected reasoning text delta in thinking parts'
  );
  assert.ok(textParts.length >= 1, 'Expected at least 1 LanguageModelTextPart');
  assert.equal(textParts[0].value, 'The proof concludes here.');
});

test('Provider Chaos [Thinking Effort: "max" on Responses API (Muse)]: normalizes "max" to "high" to prevent 400', async () => {
  mockServer.clearRequests();
  mockServer.setScenario({ mode: 'standard', content: 'Muse response with high thinking' });

  const context = createMockContext();
  const provider = new OpenCodeChatProvider(context);
  const progress = createMockProgress();
  const token = createMockToken();

  await provider.provideLanguageModelChatResponse(
    MUSE_RESPONSES_MODEL,
    [createMockMessage('hello muse')],
    { modelConfiguration: { reasoningEffort: 'max' } },
    progress,
    token
  );

  const reqs = mockServer.getRequests();
  assert.equal(reqs.length, 1);
  assert.deepEqual(reqs[0].body.reasoning, { effort: 'high' });
  assert.strictEqual(reqs[0].body.reasoning_effort, undefined);

  // Must stream cleanly without error alert
  const alert = progress.parts.find(p => p.value?.includes('OpenCode Model Alert'));
  assert.strictEqual(alert, undefined, 'Must not emit OpenCode Model Alert');
});

test('Provider Chaos [Thinking Effort: "max" on Chat Completions]: normalizes "max" to "high" to prevent 400', async () => {
  mockServer.clearRequests();
  mockServer.setScenario({ mode: 'standard', content: 'Chat response with high thinking' });

  const context = createMockContext();
  const provider = new OpenCodeChatProvider(context);
  const progress = createMockProgress();
  const token = createMockToken();

  await provider.provideLanguageModelChatResponse(
    GO_CHAT_MODEL,
    [createMockMessage('hello chat')],
    { modelConfiguration: { reasoningEffort: 'max' } },
    progress,
    token
  );

  const reqs = mockServer.getRequests();
  assert.equal(reqs.length, 1);
  assert.strictEqual(reqs[0].body.reasoning_effort, 'high');
  assert.strictEqual(reqs[0].body.reasoning, undefined);
});

test('Provider Chaos [Thinking Effort: "none" or "off"]: omits reasoning fields', async () => {
  mockServer.clearRequests();
  mockServer.setScenario({ mode: 'standard', content: 'No thinking' });

  const context = createMockContext();
  const provider = new OpenCodeChatProvider(context);
  const progress = createMockProgress();
  const token = createMockToken();

  await provider.provideLanguageModelChatResponse(
    MUSE_RESPONSES_MODEL,
    [createMockMessage('hello muse')],
    { modelConfiguration: { reasoningEffort: 'none' } },
    progress,
    token
  );

  const reqs = mockServer.getRequests();
  assert.equal(reqs.length, 1);
  assert.strictEqual(reqs[0].body.reasoning, undefined);
  assert.strictEqual(reqs[0].body.reasoning_effort, undefined);
});

test('Provider Chaos [Reasoning Lifecycle on Responses API (Muse)]: emits LanguageModelThinkingPart on response.output_item.added reasoning even without text deltas', async () => {
  mockServer.clearRequests();
  mockServer.setScenario({
    mode: 'standard',
    chunks: [
      { type: 'response.created', response: { id: 'resp_muse_1', status: 'in_progress' } },
      { type: 'response.in_progress', response: { id: 'resp_muse_1', status: 'in_progress' } },
      { type: 'response.output_item.added', output_index: 0, item: { id: 'reason_1', type: 'reasoning' } },
      // Silence while Meta computes reasoning - no reasoning text deltas
      { type: 'response.output_item.done', output_index: 0, item: { id: 'reason_1', type: 'reasoning' } },
      { type: 'response.output_item.added', output_index: 1, item: { id: 'msg_1', type: 'message' } },
      { type: 'response.output_text.delta', output_index: 1, delta: 'Hello from Muse!' },
      { type: 'response.completed', response: { id: 'resp_muse_1', status: 'completed' } },
    ],
  });

  const context = createMockContext();
  const provider = new OpenCodeChatProvider(context);
  const progress = createMockProgress();
  const token = createMockToken();

  await provider.provideLanguageModelChatResponse(
    MUSE_RESPONSES_MODEL,
    [createMockMessage('hello muse with reasoning')],
    { modelConfiguration: { reasoningEffort: 'high' } },
    progress,
    token
  );

  const thinkingParts = progress.parts.filter((p) => p instanceof vscode.LanguageModelThinkingPart);
  const textParts = progress.parts.filter((p) => p instanceof vscode.LanguageModelTextPart);

  assert.ok(thinkingParts.length >= 1, 'Expected at least 1 LanguageModelThinkingPart emitted when reasoning starts');
  assert.equal(textParts.length, 1);
  assert.equal(textParts[0].value, 'Hello from Muse!');
});

test('Provider Chaos [Reasoning Lifecycle on Responses API (Muse)]: does not trigger false stall retry during reasoning silence', async () => {
  mockServer.clearRequests();
  mockServer.setScenario({
    mode: 'stall',
    chunks: [
      { type: 'response.created', response: { id: 'resp_muse_stall', status: 'in_progress' } },
      { type: 'response.output_item.added', output_index: 0, item: { id: 'reason_1', type: 'reasoning' } },
    ],
  });

  const prevTimeout = process.env.OPENCODE_STREAM_IDLE_TIMEOUT_MS;
  process.env.OPENCODE_STREAM_IDLE_TIMEOUT_MS = '100'; // short timeout for testing

  try {
    const context = createMockContext();
    const provider = new OpenCodeChatProvider(context);
    const progress = createMockProgress();
    const token = createMockToken();

    await provider.provideLanguageModelChatResponse(
      MUSE_RESPONSES_MODEL,
      [createMockMessage('prove theorem with long thinking')],
      { modelConfiguration: { reasoningEffort: 'high' } },
      progress,
      token
    );

    const reqs = mockServer.getRequests();
    // Must NOT trigger auto-recovery retry (false stall) because reasoning was active and thinking part was emitted!
    assert.equal(reqs.length, 1, 'must not trigger false stall retry when reasoning was started');
  } finally {
    if (prevTimeout !== undefined) {
      process.env.OPENCODE_STREAM_IDLE_TIMEOUT_MS = prevTimeout;
    } else {
      delete process.env.OPENCODE_STREAM_IDLE_TIMEOUT_MS;
    }
  }
});


