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

const ZEN_FREE_CHAT_MODEL = {
  id: 'mimo-v2.5-free',
  name: 'MiMo V2.5 (OpenCode Free)',
  family: 'mimo-v2.5-free',
};

const MUSE_RESPONSES_MODEL = {
  id: 'muse-spark-1.3-contributor-free',
  name: 'Muse Spark 1.3 Contributor (OpenCode Free)',
  family: 'muse-spark-1.3-contributor-free',
};

const GPT_RESPONSES_MODEL = {
  id: 'gpt-5.5',
  name: 'GPT 5.5 (OpenCode Go)',
  family: 'gpt-5.5',
};

// ============================================================================
// 1. 500 / 502 / 503 Server Fault Tests
// ============================================================================

test('Provider Chaos [500 Fault]: does NOT throw and emits OpenCode Model Alert text part', async () => {
  mockServer.setScenario({ mode: 'fault', status: 500 });

  const context = createMockContext();
  const provider = new OpenCodeChatProvider(context);
  const progress = createMockProgress();
  const token = createMockToken();

  const startTime = Date.now();
  // Must NOT throw: clean resolution bypasses Copilot's 32.4s 5-retry loop
  await provider.provideLanguageModelChatResponse(
    GO_CHAT_MODEL,
    [createMockMessage('explain quantum mechanics')],
    {},
    progress,
    token
  );
  const duration = Date.now() - startTime;

  assert.ok(duration < 1500, `Expected fail-fast resolution (<1500ms), took ${duration}ms`);
  assert.equal(progress.parts.length, 1, 'Expected exactly 1 alert part emitted');
  assert.ok(progress.parts[0] instanceof vscode.LanguageModelTextPart);

  const alertText = progress.parts[0].value;
  assert.match(alertText, /⚠️ \*\*OpenCode Model Alert \(500 Internal Server Error\)\*\*/);
  assert.match(alertText, /Unable to reach \*\*DeepSeek V4 Pro \(OpenCode Go\)\*\*/);
  assert.match(alertText, /upstream server error/);
  assert.match(alertText, /Internal Server Error: OpenCode upstream cluster failed/);
  assert.match(alertText, /Suggestions:/);
});

test('Provider Chaos [502 Bad Gateway Fault]: does NOT throw and emits OpenCode Model Alert', async () => {
  mockServer.setScenario({ mode: 'fault', status: 502 });

  const context = createMockContext();
  const provider = new OpenCodeChatProvider(context);
  const progress = createMockProgress();
  const token = createMockToken();

  await provider.provideLanguageModelChatResponse(
    ZEN_FREE_CHAT_MODEL,
    [createMockMessage('hello')],
    {},
    progress,
    token
  );

  assert.equal(progress.parts.length, 1);
  const alertText = progress.parts[0].value;
  assert.match(alertText, /OpenCode Model Alert \(502 Bad Gateway\)/);
  assert.match(alertText, /Bad Gateway: Upstream OpenCode service unreachable/);
});

test('Provider Chaos [503 Service Unavailable Fault]: does NOT throw and emits OpenCode Model Alert', async () => {
  mockServer.setScenario({ mode: 'fault', status: 503 });

  const context = createMockContext();
  const provider = new OpenCodeChatProvider(context);
  const progress = createMockProgress();
  const token = createMockToken();

  await provider.provideLanguageModelChatResponse(
    GO_CHAT_MODEL,
    [createMockMessage('hello')],
    {},
    progress,
    token
  );

  assert.equal(progress.parts.length, 1);
  const alertText = progress.parts[0].value;
  assert.match(alertText, /OpenCode Model Alert \(503 Service Unavailable\)/);
  assert.match(alertText, /Service Unavailable: OpenCode is temporarily overloaded/);
});

// ============================================================================
// 2. 401 / 403 Auth Fault Tests
// ============================================================================

test('Provider Chaos [401 Auth Fault]: throws LanguageModelError.NoPermissions', async () => {
  mockServer.setScenario({ mode: 'fault', status: 401 });

  const context = createMockContext();
  const provider = new OpenCodeChatProvider(context);
  const progress = createMockProgress();
  const token = createMockToken();

  await assert.rejects(
    async () => {
      await provider.provideLanguageModelChatResponse(
        GO_CHAT_MODEL,
        [createMockMessage('hello')],
        {},
        progress,
        token
      );
    },
    (err) => {
      assert.ok(err instanceof Error);
      assert.equal(err.name, 'LanguageModelError');
      assert.equal(err.code, 'NoPermissions');
      assert.match(err.message, /OpenCode authentication failed: Invalid or expired API key/);
      return true;
    }
  );

  assert.equal(progress.parts.length, 0, 'No progress parts should be emitted on auth rejection');
});

test('Provider Chaos [403 Forbidden Fault]: throws LanguageModelError.NoPermissions', async () => {
  mockServer.setScenario({ mode: 'fault', status: 403, message: 'Forbidden: API key has insufficient permissions' });

  const context = createMockContext();
  const provider = new OpenCodeChatProvider(context);
  const progress = createMockProgress();
  const token = createMockToken();

  await assert.rejects(
    async () => {
      await provider.provideLanguageModelChatResponse(
        GO_CHAT_MODEL,
        [createMockMessage('hello')],
        {},
        progress,
        token
      );
    },
    (err) => {
      assert.equal(err.code, 'NoPermissions');
      return true;
    }
  );
});

// ============================================================================
// 3. 404 Model Fault Tests
// ============================================================================

test('Provider Chaos [404 Model Fault]: throws LanguageModelError.NotFound', async () => {
  mockServer.setScenario({ mode: 'fault', status: 404 });

  const context = createMockContext();
  const provider = new OpenCodeChatProvider(context);
  const progress = createMockProgress();
  const token = createMockToken();

  const unknownModel = { id: 'unknown-deprecated-model-xyz', name: 'Unknown Model' };

  await assert.rejects(
    async () => {
      await provider.provideLanguageModelChatResponse(
        unknownModel,
        [createMockMessage('hello')],
        {},
        progress,
        token
      );
    },
    (err) => {
      assert.ok(err instanceof Error);
      assert.equal(err.name, 'LanguageModelError');
      assert.equal(err.code, 'NotFound');
      assert.match(err.message, /OpenCode model 'unknown-deprecated-model-xyz' was not found in the remote catalog/);
      return true;
    }
  );
});

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
  assert.equal(thinkingParts[0].value, 'Muse deep thinking: step 1 theorem proof.');
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
// 8. Additional Edge Case Tests: Keep-alive, Cancellation, Token Count
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
