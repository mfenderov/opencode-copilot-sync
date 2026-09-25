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

const MUSE_GO_MODEL = {
  id: 'muse-spark-1.3-contributor',
  name: 'Muse Spark 1.3 Contributor (OpenCode Go)',
  family: 'muse-spark-1.3-contributor',
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

test('Provider Chaos [Responses API]: merges item.arguments on response.output_item.done if deltas were incomplete', async () => {
  mockServer.clearRequests();
  mockServer.setScenario({
    mode: 'standard',
    chunks: [
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { id: 'call_weather_1', type: 'function_call', name: 'get_weather', arguments: '' },
      },
      // Incomplete delta
      {
        type: 'response.function_call_arguments.delta',
        output_index: 0,
        delta: '{"loc',
      },
      // Done provides full arguments
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          id: 'call_weather_1',
          type: 'function_call',
          name: 'get_weather',
          arguments: '{"location":"Berlin"}',
        },
      },
      {
        type: 'response.completed',
        response: { id: 'resp_1', status: 'completed' },
      },
    ],
  });

  const context = createMockContext();
  const provider = new OpenCodeChatProvider(context);
  const progress = createMockProgress();
  const token = createMockToken();

  await provider.provideLanguageModelChatResponse(
    MUSE_RESPONSES_MODEL,
    [createMockMessage('weather in Berlin')],
    {},
    progress,
    token
  );

  const toolParts = progress.parts.filter((p) => p instanceof vscode.LanguageModelToolCallPart);
  assert.equal(toolParts.length, 1);
  assert.equal(toolParts[0].callId, 'call_weather_1');
  assert.equal(toolParts[0].name, 'get_weather');
  assert.deepEqual(toolParts[0].input, { location: 'Berlin' });
});

test('Provider Chaos [Responses API]: uses item.arguments on response.output_item.done when deltas were completely missing', async () => {
  mockServer.clearRequests();
  mockServer.setScenario({
    mode: 'standard',
    chunks: [
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { id: 'call_stock_1', type: 'function_call', name: 'get_stock', arguments: '' },
      },
      // No deltas at all
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          id: 'call_stock_1',
          type: 'function_call',
          name: 'get_stock',
          arguments: '{"symbol":"AAPL"}',
        },
      },
      {
        type: 'response.completed',
        response: { id: 'resp_2', status: 'completed' },
      },
    ],
  });

  const context = createMockContext();
  const provider = new OpenCodeChatProvider(context);
  const progress = createMockProgress();
  const token = createMockToken();

  await provider.provideLanguageModelChatResponse(
    MUSE_RESPONSES_MODEL,
    [createMockMessage('stock price of AAPL')],
    {},
    progress,
    token
  );

  const toolParts = progress.parts.filter((p) => p instanceof vscode.LanguageModelToolCallPart);
  assert.equal(toolParts.length, 1);
  assert.equal(toolParts[0].callId, 'call_stock_1');
  assert.equal(toolParts[0].name, 'get_stock');
  assert.deepEqual(toolParts[0].input, { symbol: 'AAPL' });
});

test('Provider Chaos [Responses API]: flushes pending tool calls on response.completed when output_item.done is omitted', async () => {
  mockServer.clearRequests();
  mockServer.setScenario({
    mode: 'standard',
    chunks: [
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { id: 'call_calc_1', type: 'function_call', name: 'calculate', arguments: '' },
      },
      {
        type: 'response.function_call_arguments.delta',
        output_index: 0,
        delta: '{"expr":"42 * 2"}',
      },
      // Note: response.output_item.done is NOT sent!
      {
        type: 'response.completed',
        response: { id: 'resp_3', status: 'completed' },
      },
    ],
  });

  const context = createMockContext();
  const provider = new OpenCodeChatProvider(context);
  const progress = createMockProgress();
  const token = createMockToken();

  await provider.provideLanguageModelChatResponse(
    MUSE_RESPONSES_MODEL,
    [createMockMessage('calculate 42 * 2')],
    {},
    progress,
    token
  );

  const toolParts = progress.parts.filter((p) => p instanceof vscode.LanguageModelToolCallPart);
  assert.equal(toolParts.length, 1);
  assert.equal(toolParts[0].callId, 'call_calc_1');
  assert.equal(toolParts[0].name, 'calculate');
  assert.deepEqual(toolParts[0].input, { expr: '42 * 2' });
});

test('Provider Chaos [Responses API]: parses all remaining buffer lines and flushes tool calls on response.completed', async () => {
  mockServer.clearRequests();
  mockServer.setScenario({
    mode: 'standard',
    chunks: [
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { id: 'call_buf_1', type: 'function_call', name: 'buf_tool', arguments: '' },
      },
      // In this chunk or batch, response.completed arrives, followed by output_item.done
      {
        type: 'response.completed',
        response: { id: 'resp_buf_1', status: 'completed' },
      },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          id: 'call_buf_1',
          type: 'function_call',
          name: 'buf_tool',
          arguments: '{"from_done":true}',
        },
      },
    ],
  });

  const context = createMockContext();
  const provider = new OpenCodeChatProvider(context);
  const progress = createMockProgress();
  const token = createMockToken();

  await provider.provideLanguageModelChatResponse(
    MUSE_RESPONSES_MODEL,
    [createMockMessage('call buffer tool')],
    {},
    progress,
    token
  );

  const toolParts = progress.parts.filter((p) => p instanceof vscode.LanguageModelToolCallPart);
  assert.equal(toolParts.length, 1);
  assert.equal(toolParts[0].callId, 'call_buf_1');
  assert.deepEqual(toolParts[0].input, { from_done: true });
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
      family: 'muse-spark-1.3',
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

test('Provider [model information]: caps stale output metadata before Agent Mode budgeting', async () => {
  const context = createMockContext();
  const provider = new OpenCodeChatProvider(context);

  provider.updateModels([
    {
      id: 'muse-spark-1.3-contributor',
      name: 'Muse Spark 1.3 Contributor (OpenCode Go)',
      family: 'muse-spark-1.3-contributor',
      contextWindow: 1048576,
      maxOutputTokens: 943718,
      vision: true,
      thinking: true,
    },
  ]);

  const [info] = await provider.provideLanguageModelChatInformation({}, createMockToken());
  assert.equal(info.maxOutputTokens, 262144);
  assert.equal(info.maxInputTokens, 786432);
});

// ============================================================================
// 9. Muse Multi-Turn Tool Calling & Go Tool Isolation Tests
// ============================================================================

test('Provider [Muse Multi-turn Tools]: serializes multi-turn tool calls and outputs properly to /zen/go/v1/responses', async () => {
  mockServer.clearRequests();
  mockServer.setScenario({
    mode: 'standard',
    content: 'All done with calculations and lookups!',
  });

  const context = createMockContext();
  const provider = new OpenCodeChatProvider(context);
  const progress = createMockProgress();
  const token = createMockToken();

  // Multi-turn conversation:
  // Turn 0: User requests action
  // Turn 1: Assistant emits 2 tool calls
  // Turn 2: Tool result 1 (JSON object)
  // Turn 3: Tool result 2 (plain string)
  // Turn 4: Assistant provides answer
  // Turn 5: User follow-up
  const messages = [
    {
      role: vscode.LanguageModelChatMessageRole.User,
      content: [new vscode.LanguageModelTextPart('Calculate 10+20 and fetch readme')],
    },
    {
      role: vscode.LanguageModelChatMessageRole.Assistant,
      content: [
        new vscode.LanguageModelTextPart('Executing calculation and file read.'),
        new vscode.LanguageModelToolCallPart('call_calc_42', 'calculator', { expr: '10+20' }),
        new vscode.LanguageModelToolCallPart('call_read_43', 'read_file', { path: 'README.md' }),
      ],
    },
    {
      role: vscode.LanguageModelChatMessageRole.User,
      content: [
        new vscode.LanguageModelToolResultPart('call_calc_42', { result: 30 }),
      ],
    },
    {
      role: vscode.LanguageModelChatMessageRole.User,
      content: [
        new vscode.LanguageModelToolResultPart('call_read_43', '# Readme Content'),
      ],
    },
    {
      role: vscode.LanguageModelChatMessageRole.Assistant,
      content: [
        new vscode.LanguageModelTextPart('The sum is 30, and the README starts with "# Readme Content".'),
      ],
    },
    {
      role: vscode.LanguageModelChatMessageRole.User,
      content: [new vscode.LanguageModelTextPart('Can you now summarize it?')],
    },
  ];

  const tools = [
    {
      name: 'calculator',
      description: 'Performs math calculations',
      inputSchema: { type: 'object', properties: { expr: { type: 'string' } } },
    },
    {
      name: 'read_file',
      description: 'Reads local file contents',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    },
  ];

  await provider.provideLanguageModelChatResponse(
    MUSE_GO_MODEL,
    messages,
    { tools },
    progress,
    token
  );

  const reqs = mockServer.getRequests();
  assert.equal(reqs.length, 1);
  const req = reqs[0];

  // 1. Verify routing to /zen/go/v1/responses (Go gateway, NOT /zen/v1)
  assert.equal(req.pathname, '/zen/go/v1/responses');
  assert.equal(req.body.model, 'muse-spark-1.3-contributor');

  // 2. Inspect input array items in responsesInput
  const input = req.body.input;
  assert.ok(Array.isArray(input), 'input must be an array in Responses API');

  // Turn 0: User message
  assert.deepEqual(input[0], { role: 'user', content: 'Calculate 10+20 and fetch readme' });

  // Turn 1: Assistant message (output_text) + 2 tool calls
  assert.deepEqual(input[1], {
    role: 'assistant',
    content: [{ type: 'output_text', text: 'Executing calculation and file read.' }],
  });
  assert.equal(input[2].type, 'function_call');
  assert.equal(input[2].id, 'call_calc_42');
  assert.equal(input[2].call_id, 'call_calc_42');
  assert.equal(input[2].name, 'calculator');
  assert.equal(input[2].arguments, '{"expr":"10+20"}');

  assert.equal(input[3].type, 'function_call');
  assert.equal(input[3].id, 'call_read_43');
  assert.equal(input[3].call_id, 'call_read_43');
  assert.equal(input[3].name, 'read_file');
  assert.equal(input[3].arguments, '{"path":"README.md"}');

  // Turn 2: Tool result 1 -> function_call_output
  assert.equal(input[4].type, 'function_call_output');
  assert.equal(input[4].call_id, 'call_calc_42');
  assert.equal(typeof input[4].output, 'string', 'output must strictly be a string');
  assert.equal(input[4].output, '{"result":30}');

  // Turn 3: Tool result 2 -> function_call_output
  assert.equal(input[5].type, 'function_call_output');
  assert.equal(input[5].call_id, 'call_read_43');
  assert.equal(typeof input[5].output, 'string', 'output must strictly be a string');
  assert.equal(input[5].output, '# Readme Content');

  // Turn 4: Assistant message
  assert.deepEqual(input[6], {
    role: 'assistant',
    content: [{ type: 'output_text', text: 'The sum is 30, and the README starts with "# Readme Content".' }],
  });

  // Turn 5: User follow-up
  assert.deepEqual(input[7], { role: 'user', content: 'Can you now summarize it?' });

  // 3. Verify tool isolation: Go contributor model NEVER gets bash or read injected!
  assert.ok(Array.isArray(req.body.tools));
  assert.equal(req.body.tools.length, 2, 'Must contain only caller-defined tools');
  const toolNames = req.body.tools.map((t) => t.name);
  assert.deepEqual(toolNames, ['calculator', 'read_file']);
  assert.ok(!toolNames.includes('bash'), 'Go contributor model must NEVER have synthetic bash tool');
  assert.ok(!toolNames.includes('read'), 'Go contributor model must NEVER have synthetic read tool');
});

test('Provider [Go Contributor Isolation]: muse-spark-1.3-contributor never injects synthetic verification tools with or without caller tools', async () => {
  const context = createMockContext();
  const provider = new OpenCodeChatProvider(context);

  // Case A: With caller tools on Go contributor model
  mockServer.clearRequests();
  mockServer.setScenario({ mode: 'standard', content: 'test with tools' });
  const progress1 = createMockProgress();
  const token1 = createMockToken();

  await provider.provideLanguageModelChatResponse(
    MUSE_GO_MODEL,
    [createMockMessage('use custom tool')],
    {
      tools: [
        {
          name: 'my_custom_tool',
          description: 'A custom tool',
          inputSchema: { type: 'object' },
        },
      ],
    },
    progress1,
    token1
  );

  const reqs1 = mockServer.getRequests();
  assert.equal(reqs1.length, 1);
  assert.equal(reqs1[0].pathname, '/zen/go/v1/responses');
  assert.equal(reqs1[0].body.tools.length, 1);
  assert.equal(reqs1[0].body.tools[0].name, 'my_custom_tool');

  // Case B: Without caller tools on Go contributor model -> tools must be undefined!
  mockServer.clearRequests();
  mockServer.setScenario({ mode: 'standard', content: 'test without tools' });
  const progress2 = createMockProgress();
  const token2 = createMockToken();

  await provider.provideLanguageModelChatResponse(
    MUSE_GO_MODEL,
    [createMockMessage('no tools needed')],
    {},
    progress2,
    token2
  );

  const reqs2 = mockServer.getRequests();
  assert.equal(reqs2.length, 1);
  assert.equal(reqs2[0].pathname, '/zen/go/v1/responses');
  assert.strictEqual(reqs2[0].body.tools, undefined, 'tools must be undefined when no caller tools on Go model');

  // Case C: Contrast with Free/Zen tier model muse-spark-1.3-contributor-free -> DOES inject verification tools
  mockServer.clearRequests();
  mockServer.setScenario({ mode: 'standard', content: 'free model response' });
  const progress3 = createMockProgress();
  const token3 = createMockToken();

  await provider.provideLanguageModelChatResponse(
    MUSE_RESPONSES_MODEL,
    [createMockMessage('free model request')],
    {},
    progress3,
    token3
  );

  const reqs3 = mockServer.getRequests();
  assert.equal(reqs3.length, 1);
  assert.equal(reqs3[0].pathname, '/zen/v1/responses');
  assert.ok(Array.isArray(reqs3[0].body.tools), 'Free model must inject verification tools');
  const freeToolNames = reqs3[0].body.tools.map((t) => t.name);
  assert.ok(freeToolNames.includes('bash'), 'Free tier must have bash injected');
  assert.ok(freeToolNames.includes('read'), 'Free tier must have read injected');
});

test('Provider [Reasoning Replay Prevention]: never replays LanguageModelThinkingPart from prior turns into message text or responsesInput', async () => {
  mockServer.clearRequests();
  mockServer.setScenario({ mode: 'standard', content: 'Follow-up answer' });

  const context = createMockContext();
  const provider = new OpenCodeChatProvider(context);
  const progress = createMockProgress();
  const token = createMockToken();

  // Multi-turn where assistant message contains a LanguageModelThinkingPart from Turn 1
  const messages = [
    {
      role: vscode.LanguageModelChatMessageRole.User,
      content: [new vscode.LanguageModelTextPart('Think deeply and answer')],
    },
    {
      role: vscode.LanguageModelChatMessageRole.Assistant,
      content: [
        new vscode.LanguageModelThinkingPart('Internal chain of thought: step 1, step 2...', 'think_999'),
        new vscode.LanguageModelTextPart('The answer is 42.'),
      ],
    },
    {
      role: vscode.LanguageModelChatMessageRole.User,
      content: [new vscode.LanguageModelTextPart('Are you sure?')],
    },
  ];

  await provider.provideLanguageModelChatResponse(
    MUSE_GO_MODEL,
    messages,
    {},
    progress,
    token
  );

  const reqs = mockServer.getRequests();
  assert.equal(reqs.length, 1);
  const input = reqs[0].body.input;

  // Assistant message in input must ONLY have 'The answer is 42.' and NEVER the thinking part!
  assert.deepEqual(input[1], {
    role: 'assistant',
    content: [{ type: 'output_text', text: 'The answer is 42.' }],
  });

  // Verify none of the input items contain stale reasoning
  assert.ok(!JSON.stringify(input).includes('Internal chain of thought'));
});

test('Provider [ThinkingLevel Normalization]: maps thinkingLevel "max" to "high" on Responses API without throwing', async () => {
  mockServer.clearRequests();
  mockServer.setScenario({ mode: 'standard', content: 'max reasoning response' });

  const context = createMockContext();
  const provider = new OpenCodeChatProvider(context);
  const progress = createMockProgress();
  const token = createMockToken();

  // Test with thinkingLevel in modelConfiguration
  await provider.provideLanguageModelChatResponse(
    MUSE_GO_MODEL,
    [createMockMessage('deep reasoning task')],
    { modelConfiguration: { thinkingLevel: 'max' } },
    progress,
    token
  );

  const reqs = mockServer.getRequests();
  assert.equal(reqs.length, 1);
  assert.deepEqual(reqs[0].body.reasoning, { effort: 'high' });
  assert.strictEqual(reqs[0].body.reasoning_effort, undefined);

  // Test with thinkingLevel at top-level options
  mockServer.clearRequests();
  mockServer.setScenario({ mode: 'standard', content: 'top-level thinkingLevel response' });

  await provider.provideLanguageModelChatResponse(
    MUSE_GO_MODEL,
    [createMockMessage('another reasoning query')],
    { thinkingLevel: 'max' },
    progress,
    token
  );

  const reqs2 = mockServer.getRequests();
  assert.equal(reqs2.length, 1);
  assert.deepEqual(reqs2[0].body.reasoning, { effort: 'high' });
});

