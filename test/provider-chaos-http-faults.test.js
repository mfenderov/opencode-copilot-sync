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
// 4. 429 Rate Limit Fault Tests
//
// 429 gets its own much more patient budget than 5xx (10 retries vs. 1) —
// see the config comment in src/provider.ts. These tests confirm that
// patient schedule is actually wired up end-to-end, not just theoretically
// supported by network.ts (already covered at the unit level in
// test/network.test.js).
// ============================================================================

test('Provider Chaos [429 Rate Limit Fault]: recovers after a few 429s and resolves silently, without an alert card', async () => {
  // Queue 3 back-to-back 429s (all within rateLimitImmediateAttempts=3, so
  // each retry waits only a near-instant jittered delay); once the queue is
  // exhausted the mock server falls back to a normal successful response.
  // A 5xx would have given up after just 1 retry (2 total requests) — 4
  // total requests here proves the wiring actually uses the 10-retry 429
  // budget, not the 1-retry 5xx budget.
  mockServer.setScenario([
    { mode: 'fault', status: 429 },
    { mode: 'fault', status: 429 },
    { mode: 'fault', status: 429 },
  ]);

  const context = createMockContext();
  const provider = new OpenCodeChatProvider(context);
  const progress = createMockProgress();
  const token = createMockToken();

  const startTime = Date.now();
  await provider.provideLanguageModelChatResponse(
    ZEN_FREE_CHAT_MODEL,
    [createMockMessage('hello')],
    {},
    progress,
    token
  );
  const duration = Date.now() - startTime;

  assert.ok(duration < 2000, `expected fast recovery via immediate 429 retries, took ${duration}ms`);
  assert.equal(mockServer.getRequests().length, 4, 'expected 3 failed attempts + 1 successful attempt');

  const textParts = progress.parts.filter((p) => p instanceof vscode.LanguageModelTextPart);
  assert.ok(textParts.length >= 1, 'expected streamed success content, not just an alert card');
  assert.ok(
    !progress.parts.some((p) => p instanceof vscode.LanguageModelTextPart && /OpenCode Model Alert/.test(p.value)),
    'no alert card should be emitted once the request recovers'
  );
});

test('Provider Chaos [429 Rate Limit Fault]: exhausts the full 10-retry budget and emits OpenCode Model Alert', async () => {
  // Every request returns 429 — forces the full patient schedule to run out
  // (1 initial attempt + 10 retries = 11 total requests) before the alert
  // card is shown. This exercises the real production schedule end-to-end,
  // so it necessarily takes several seconds (7 of the 10 retries are spaced
  // ~1s apart) rather than being sped up with test-scaled delays.
  mockServer.setScenario({ mode: 'fault', status: 429 });

  const context = createMockContext();
  const provider = new OpenCodeChatProvider(context);
  const progress = createMockProgress();
  const token = createMockToken();

  const startTime = Date.now();
  await provider.provideLanguageModelChatResponse(
    GO_CHAT_MODEL,
    [createMockMessage('hello')],
    {},
    progress,
    token
  );
  const duration = Date.now() - startTime;

  assert.ok(duration < 10_000, `expected the 429 budget to exhaust within ~7-8s, took ${duration}ms`);
  assert.equal(
    mockServer.getRequests().length,
    11,
    'expected 1 initial attempt + all 10 rate-limit retries before giving up'
  );
  assert.equal(progress.parts.length, 1, 'Expected exactly 1 alert part emitted');
  const alertText = progress.parts[0].value;
  assert.match(alertText, /OpenCode Model Alert \(429 Too Many Requests\)/);
  assert.match(alertText, /Rate limit exceeded\. Please try again later\./);
});
