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

const GPT_RESPONSES_MODEL = {
  id: 'gpt-5.5',
  name: 'GPT 5.5 (OpenCode Go)',
  family: 'gpt-5.5',
};

// ============================================================================
// 6. Tool Calling Tests
// ============================================================================

test('Provider Chaos [Tool Calling on Chat Completions]: emits LanguageModelToolCallPart with parsed arguments', async () => {
  mockServer.setScenario({
    mode: 'tool-call',
    toolName: 'calculator',
    toolCallId: 'call_calc_999',
    toolArgsPart1: '{"expression":',
    toolArgsPart2: ' "sqrt(144)"}',
  });

  const context = createMockContext();
  const provider = new OpenCodeChatProvider(context);
  const progress = createMockProgress();
  const token = createMockToken();

  const options = {
    tools: [
      {
        name: 'calculator',
        description: 'Calculate mathematical expressions',
        inputSchema: {
          type: 'object',
          properties: { expression: { type: 'string' } },
        },
      },
    ],
  };

  await provider.provideLanguageModelChatResponse(
    GO_CHAT_MODEL,
    [createMockMessage('calculate sqrt(144)')],
    options,
    progress,
    token
  );

  const toolParts = progress.parts.filter((p) => p instanceof vscode.LanguageModelToolCallPart);
  assert.equal(toolParts.length, 1, 'Expected exactly 1 LanguageModelToolCallPart');

  const toolCall = toolParts[0];
  assert.equal(toolCall.callId, 'call_calc_999');
  assert.equal(toolCall.name, 'calculator');
  assert.deepEqual(toolCall.input, { expression: 'sqrt(144)' });
});

test('Provider Chaos [Tool Calling]: two parallel tool calls missing an explicit "index" field do not collide', async () => {
  // Some non-conformant OpenAI-compatible servers omit `tool_calls[].index`.
  // The accumulator must fall back to each delta's array position rather
  // than always defaulting to 0, or parallel tool calls would collapse
  // into a single, corrupted entry.
  mockServer.setScenario({
    mode: 'standard',
    chunks: [
      {
        id: 'chatcmpl-parallel-tools',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'deepseek-v4-pro',
        choices: [{
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [
              { id: 'call_a', type: 'function', function: { name: 'toolA', arguments: '' } },
              { id: 'call_b', type: 'function', function: { name: 'toolB', arguments: '' } },
            ],
          },
          finish_reason: null,
        }],
      },
      {
        id: 'chatcmpl-parallel-tools',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'deepseek-v4-pro',
        choices: [{
          index: 0,
          delta: {
            tool_calls: [
              { function: { arguments: '{"x":1}' } },
              { function: { arguments: '{"y":2}' } },
            ],
          },
          finish_reason: null,
        }],
      },
      {
        id: 'chatcmpl-parallel-tools',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'deepseek-v4-pro',
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      },
    ],
  });

  const context = createMockContext();
  const provider = new OpenCodeChatProvider(context);
  const progress = createMockProgress();
  const token = createMockToken();

  const options = {
    tools: [
      { name: 'toolA', description: 'Tool A', inputSchema: { type: 'object' } },
      { name: 'toolB', description: 'Tool B', inputSchema: { type: 'object' } },
    ],
  };

  await provider.provideLanguageModelChatResponse(
    GO_CHAT_MODEL,
    [createMockMessage('call both tools')],
    options,
    progress,
    token
  );

  const toolParts = progress.parts.filter((p) => p instanceof vscode.LanguageModelToolCallPart);
  assert.equal(toolParts.length, 2, 'Expected exactly 2 distinct LanguageModelToolCallPart entries');

  const byName = Object.fromEntries(toolParts.map((p) => [p.name, p]));
  assert.equal(byName.toolA.callId, 'call_a');
  assert.deepEqual(byName.toolA.input, { x: 1 });
  assert.equal(byName.toolB.callId, 'call_b');
  assert.deepEqual(byName.toolB.input, { y: 2 });
});

test('Provider Chaos [Tool Calling on Responses API]: emits LanguageModelToolCallPart with parsed arguments', async () => {
  mockServer.setScenario({
    mode: 'tool-call',
    toolName: 'web_search',
    toolCallId: 'call_search_888',
    toolArgsPart1: '{"query": "OpenCode',
    toolArgsPart2: ' architecture"}',
  });

  const context = createMockContext();
  const provider = new OpenCodeChatProvider(context);
  const progress = createMockProgress();
  const token = createMockToken();

  const options = {
    tools: [
      {
        name: 'web_search',
        description: 'Search the web',
        inputSchema: { type: 'object' },
      },
    ],
  };

  await provider.provideLanguageModelChatResponse(
    GPT_RESPONSES_MODEL,
    [createMockMessage('search web')],
    options,
    progress,
    token
  );

  const toolParts = progress.parts.filter((p) => p instanceof vscode.LanguageModelToolCallPart);
  assert.equal(toolParts.length, 1);

  const toolCall = toolParts[0];
  assert.equal(toolCall.callId, 'call_search_888');
  assert.equal(toolCall.name, 'web_search');
  assert.deepEqual(toolCall.input, { query: 'OpenCode architecture' });

  // Verify request was sent to /zen/go/v1/responses
  const requests = mockServer.getRequests();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].pathname, '/zen/go/v1/responses');
});
