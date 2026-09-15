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
      fsPath: path.resolve(process.cwd(), '.test-user-data', 'session-id-storage'),
    },
  };
}

function createMockProgress() {
  const parts = [];
  return {
    parts,
    report(part) {
      parts.push(part);
    },
  };
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
  return {
    role,
    content: [new vscode.LanguageModelTextPart(text)],
  };
}

const GO_CHAT_MODEL = {
  id: 'deepseek-v4-pro',
  name: 'DeepSeek V4 Pro (OpenCode Go)',
  family: 'deepseek-v4-pro',
};

function sessionHeaderOf(requestRecord) {
  return requestRecord.headers['x-opencode-session'];
}

test('Session ID: reused across turns of the same conversation', async () => {
  const context = createMockContext();
  const provider = new OpenCodeChatProvider(context);

  // Turn 1: a single opening user message.
  await provider.provideLanguageModelChatResponse(
    GO_CHAT_MODEL,
    [createMockMessage('explain quantum mechanics')],
    {},
    createMockProgress(),
    createMockToken()
  );

  // Turn 2: Copilot resends the full history (same first message) plus new turns.
  await provider.provideLanguageModelChatResponse(
    GO_CHAT_MODEL,
    [
      createMockMessage('explain quantum mechanics'),
      createMockMessage('Quantum mechanics is...', vscode.LanguageModelChatMessageRole.Assistant),
      createMockMessage('now explain it like I am five'),
    ],
    {},
    createMockProgress(),
    createMockToken()
  );

  const requests = mockServer.getRequests();
  assert.equal(requests.length, 2, 'Expected exactly 2 upstream requests');

  const [first, second] = requests;
  assert.ok(sessionHeaderOf(first), 'Expected x-opencode-session header on first request');
  assert.equal(
    sessionHeaderOf(first),
    sessionHeaderOf(second),
    'Expected the same x-opencode-session id reused across turns of one conversation'
  );
});

test('Session ID: different conversations (different first messages) get different ids', async () => {
  const context = createMockContext();
  const provider = new OpenCodeChatProvider(context);

  await provider.provideLanguageModelChatResponse(
    GO_CHAT_MODEL,
    [createMockMessage('conversation A opening message')],
    {},
    createMockProgress(),
    createMockToken()
  );

  await provider.provideLanguageModelChatResponse(
    GO_CHAT_MODEL,
    [createMockMessage('conversation B opening message')],
    {},
    createMockProgress(),
    createMockToken()
  );

  const requests = mockServer.getRequests();
  assert.equal(requests.length, 2);

  const [first, second] = requests;
  assert.ok(sessionHeaderOf(first));
  assert.ok(sessionHeaderOf(second));
  assert.notEqual(
    sessionHeaderOf(first),
    sessionHeaderOf(second),
    'Expected different conversations to get different session ids'
  );
});

test('Session ID: reused across turns even when the same provider instance juggles multiple concurrent conversations', async () => {
  const context = createMockContext();
  const provider = new OpenCodeChatProvider(context);

  // Interleave two conversations, as would happen with two open chat tabs.
  await provider.provideLanguageModelChatResponse(
    GO_CHAT_MODEL,
    [createMockMessage('conversation A opening message')],
    {},
    createMockProgress(),
    createMockToken()
  );
  await provider.provideLanguageModelChatResponse(
    GO_CHAT_MODEL,
    [createMockMessage('conversation B opening message')],
    {},
    createMockProgress(),
    createMockToken()
  );
  await provider.provideLanguageModelChatResponse(
    GO_CHAT_MODEL,
    [
      createMockMessage('conversation A opening message'),
      createMockMessage('reply A', vscode.LanguageModelChatMessageRole.Assistant),
      createMockMessage('follow-up A'),
    ],
    {},
    createMockProgress(),
    createMockToken()
  );
  await provider.provideLanguageModelChatResponse(
    GO_CHAT_MODEL,
    [
      createMockMessage('conversation B opening message'),
      createMockMessage('reply B', vscode.LanguageModelChatMessageRole.Assistant),
      createMockMessage('follow-up B'),
    ],
    {},
    createMockProgress(),
    createMockToken()
  );

  const [reqA1, reqB1, reqA2, reqB2] = mockServer.getRequests();
  assert.equal(sessionHeaderOf(reqA1), sessionHeaderOf(reqA2), 'Conversation A should keep its session id');
  assert.equal(sessionHeaderOf(reqB1), sessionHeaderOf(reqB2), 'Conversation B should keep its session id');
  assert.notEqual(sessionHeaderOf(reqA1), sessionHeaderOf(reqB1), 'Distinct conversations should not share a session id');
});

test('Session ID: bounded cache evicts the least-recently-used conversation once full', async () => {
  const context = createMockContext();
  const provider = new OpenCodeChatProvider(context);

  await provider.provideLanguageModelChatResponse(
    GO_CHAT_MODEL,
    [createMockMessage('original conversation, will be evicted eventually')],
    {},
    createMockProgress(),
    createMockToken()
  );
  const originalSessionId = sessionHeaderOf(mockServer.getRequests()[0]);

  // Fill the cache past its capacity (50) with distinct conversations so the
  // original entry, being the oldest, gets evicted.
  for (let i = 0; i < 55; i++) {
    await provider.provideLanguageModelChatResponse(
      GO_CHAT_MODEL,
      [createMockMessage(`filler conversation number ${i}`)],
      {},
      createMockProgress(),
      createMockToken()
    );
  }

  // Re-send the original conversation's opening message as a fresh "turn 1".
  await provider.provideLanguageModelChatResponse(
    GO_CHAT_MODEL,
    [createMockMessage('original conversation, will be evicted eventually')],
    {},
    createMockProgress(),
    createMockToken()
  );

  const requests = mockServer.getRequests();
  const replaySessionId = sessionHeaderOf(requests[requests.length - 1]);

  assert.notEqual(
    replaySessionId,
    originalSessionId,
    'Expected the evicted conversation to receive a brand-new session id'
  );
});
