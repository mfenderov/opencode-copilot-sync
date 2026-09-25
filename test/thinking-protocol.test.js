import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMockServer } from './helpers/mock-opencode-server.js';
import { OpenCodeChatProvider } from '../out/provider.js';

let mockServer;
let mockContext;
let originalFetch;

const MUSE_MODEL = {
  id: 'muse-spark-1.3-contributor-free',
  name: 'Muse Spark 1.3 Contributor Free',
  family: 'muse-spark-1.3-contributor-free',
};

const DEEPSEEK_MODEL = {
  id: 'deepseek-v4.1-flash',
  name: 'DeepSeek V4.1 Flash',
  family: 'deepseek-v4.1-flash',
};

function createMockContext() {
  return {
    secrets: {
      get: async () => 'sk-mock-test-key-12345',
      store: async () => {},
      delete: async () => {},
    },
    globalStorageUri: { fsPath: '/tmp/opencode-test-storage' },
  };
}

function createMockProgress() {
  const parts = [];
  return {
    parts,
    report: (p) => parts.push(p),
  };
}

function createMockToken() {
  let isCancelled = false;
  const listeners = [];
  return {
    get isCancellationRequested() {
      return isCancelled;
    },
    onCancellationRequested: (fn) => {
      listeners.push(fn);
      return { dispose: () => {} };
    },
    cancel: () => {
      isCancelled = true;
      listeners.forEach((fn) => fn());
    },
  };
}

function createMockMessage(text = 'Hello') {
  return {
    role: 1, // User
    content: [{ value: text }],
  };
}

before(async () => {
  mockServer = await startMockServer(0);
  process.env.OPENCODE_API_KEY = 'sk-mock-key';
  mockContext = createMockContext();

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

// ============================================================================
// 1. Responses API (Muse, GPT, Grok) Reasoning Serialization Matrix
// ============================================================================

const RESPONSES_EFFORT_CASES = [
  { input: 'minimal', expected: { effort: 'minimal' }, desc: 'minimal effort' },
  { input: 'low', expected: { effort: 'low' }, desc: 'low effort' },
  { input: 'medium', expected: { effort: 'medium' }, desc: 'medium effort' },
  { input: 'high', expected: { effort: 'high' }, desc: 'high effort' },
  { input: 'xhigh', expected: { effort: 'xhigh' }, desc: 'xhigh effort' },
  { input: 'max', expected: { effort: 'high' }, desc: 'max normalized to high to prevent 400' },
  { input: 'none', expected: undefined, desc: 'none omits reasoning object' },
  { input: 'off', expected: undefined, desc: 'off omits reasoning object' },
  { input: undefined, expected: undefined, desc: 'omitted reasoning effort' },
];

for (const { input, expected, desc } of RESPONSES_EFFORT_CASES) {
  test(`Responses API (Muse): thinking effort "${input}" correctly serialized (${desc})`, async () => {
    mockServer.clearRequests();
    mockServer.setScenario({ mode: 'standard', content: 'test response' });

    const provider = new OpenCodeChatProvider(mockContext);
    const progress = createMockProgress();
    const token = createMockToken();

    const options = input ? { modelConfiguration: { reasoningEffort: input } } : {};

    await provider.provideLanguageModelChatResponse(
      MUSE_MODEL,
      [createMockMessage('test query')],
      options,
      progress,
      token
    );

    const reqs = mockServer.getRequests();
    assert.equal(reqs.length, 1, 'Must record exactly 1 HTTP request');
    assert.equal(reqs[0].pathname, '/zen/v1/responses', 'Must route to /zen/v1/responses');

    if (expected) {
      assert.deepEqual(
        reqs[0].body.reasoning,
        expected,
        `Expected reasoning object ${JSON.stringify(expected)}, got ${JSON.stringify(reqs[0].body.reasoning)}`
      );
    } else {
      assert.strictEqual(
        reqs[0].body.reasoning,
        undefined,
        `Reasoning field must be omitted for "${input}", but got ${JSON.stringify(reqs[0].body.reasoning)}`
      );
    }
    assert.strictEqual(reqs[0].body.reasoning_effort, undefined, 'Must never send top-level reasoning_effort to Responses API');
  });
}

// ============================================================================
// 2. Chat Completions API (DeepSeek, Kimi, GLM) Reasoning Serialization Matrix
// ============================================================================

const CHAT_EFFORT_CASES = [
  { input: 'low', expected: 'low', desc: 'low reasoning_effort' },
  { input: 'medium', expected: 'medium', desc: 'medium reasoning_effort' },
  { input: 'high', expected: 'high', desc: 'high reasoning_effort' },
  { input: 'max', expected: 'high', desc: 'max normalized to high to prevent 400 on MiMo/standard APIs' },
  { input: 'none', expected: undefined, desc: 'none omits reasoning_effort' },
  { input: 'off', expected: undefined, desc: 'off omits reasoning_effort' },
  { input: undefined, expected: undefined, desc: 'omitted reasoning effort' },
];

for (const { input, expected, desc } of CHAT_EFFORT_CASES) {
  test(`Chat Completions (DeepSeek): thinking effort "${input}" correctly serialized (${desc})`, async () => {
    mockServer.clearRequests();
    mockServer.setScenario({ mode: 'standard', content: 'test response' });

    const provider = new OpenCodeChatProvider(mockContext);
    const progress = createMockProgress();
    const token = createMockToken();

    const options = input ? { modelConfiguration: { reasoningEffort: input } } : {};

    await provider.provideLanguageModelChatResponse(
      DEEPSEEK_MODEL,
      [createMockMessage('test query')],
      options,
      progress,
      token
    );

    const reqs = mockServer.getRequests();
    assert.equal(reqs.length, 1, 'Must record exactly 1 HTTP request');
    assert.equal(reqs[0].pathname, '/zen/go/v1/chat/completions', 'Must route to /zen/go/v1/chat/completions');

    if (expected) {
      assert.strictEqual(
        reqs[0].body.reasoning_effort,
        expected,
        `Expected reasoning_effort "${expected}", got "${reqs[0].body.reasoning_effort}"`
      );
    } else {
      assert.strictEqual(
        reqs[0].body.reasoning_effort,
        undefined,
        `reasoning_effort must be omitted for "${input}", but got ${reqs[0].body.reasoning_effort}`
      );
    }
    assert.strictEqual(reqs[0].body.reason, undefined, 'Must not send reasoning object to Chat Completions');
  });
}

// ============================================================================
// 3. Option Property Location Resiliency Tests
// ============================================================================

test('Reasoning effort is detected from options.modelConfiguration.reasoningEffort', async () => {
  mockServer.clearRequests();
  mockServer.setScenario({ mode: 'standard', content: 'test' });
  const provider = new OpenCodeChatProvider(mockContext);

  await provider.provideLanguageModelChatResponse(
    MUSE_MODEL,
    [createMockMessage('test')],
    { modelConfiguration: { reasoningEffort: 'medium' } },
    createMockProgress(),
    createMockToken()
  );

  const req = mockServer.getRequests()[0];
  assert.deepEqual(req.body.reasoning, { effort: 'medium' });
});

test('Reasoning effort is detected from options.configuration.reasoningEffort', async () => {
  mockServer.clearRequests();
  mockServer.setScenario({ mode: 'standard', content: 'test' });
  const provider = new OpenCodeChatProvider(mockContext);

  await provider.provideLanguageModelChatResponse(
    MUSE_MODEL,
    [createMockMessage('test')],
    { configuration: { reasoningEffort: 'high' } },
    createMockProgress(),
    createMockToken()
  );

  const req = mockServer.getRequests()[0];
  assert.deepEqual(req.body.reasoning, { effort: 'high' });
});

test('Reasoning effort is detected from root options.reasoningEffort', async () => {
  mockServer.clearRequests();
  mockServer.setScenario({ mode: 'standard', content: 'test' });
  const provider = new OpenCodeChatProvider(mockContext);

  await provider.provideLanguageModelChatResponse(
    MUSE_MODEL,
    [createMockMessage('test')],
    { reasoningEffort: 'low' },
    createMockProgress(),
    createMockToken()
  );

  const req = mockServer.getRequests()[0];
  assert.deepEqual(req.body.reasoning, { effort: 'low' });
});
