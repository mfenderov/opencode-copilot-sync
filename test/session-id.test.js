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

test('Session ID: same-opener conversations fork to distinct sessions on divergence', async () => {
  const context = createMockContext();
  const provider = new OpenCodeChatProvider(context);
  const opener = 'identical opener pasted into two different chats';
  const assistant = vscode.LanguageModelChatMessageRole.Assistant;

  // Turn 1 in chat A and chat B: byte-identical single message (shares a session — unavoidable).
  await provider.provideLanguageModelChatResponse(
    GO_CHAT_MODEL,
    [createMockMessage(opener)],
    {},
    createMockProgress(),
    createMockToken()
  );
  await provider.provideLanguageModelChatResponse(
    GO_CHAT_MODEL,
    [createMockMessage(opener)],
    {},
    createMockProgress(),
    createMockToken()
  );

  // Turn 2 diverges: same opener, different replies and follow-ups.
  await provider.provideLanguageModelChatResponse(
    GO_CHAT_MODEL,
    [
      createMockMessage(opener),
      createMockMessage('reply A', assistant),
      createMockMessage('follow-up A'),
    ],
    {},
    createMockProgress(),
    createMockToken()
  );
  await provider.provideLanguageModelChatResponse(
    GO_CHAT_MODEL,
    [
      createMockMessage(opener),
      createMockMessage('reply B', assistant),
      createMockMessage('follow-up B'),
    ],
    {},
    createMockProgress(),
    createMockToken()
  );

  // Turn 3 continues chat A (must stay on A's forked session).
  await provider.provideLanguageModelChatResponse(
    GO_CHAT_MODEL,
    [
      createMockMessage(opener),
      createMockMessage('reply A', assistant),
      createMockMessage('follow-up A'),
      createMockMessage('reply A2', assistant),
      createMockMessage('follow-up A2'),
    ],
    {},
    createMockProgress(),
    createMockToken()
  );

  const sessions = mockServer.getRequests().map(sessionHeaderOf);
  assert.equal(sessions.length, 5, 'Expected exactly 5 upstream requests');
  assert.notEqual(
    sessions[2],
    sessions[3],
    'Diverged same-opener turns must NOT share one upstream session (context bleed)'
  );
  assert.equal(
    sessions[2],
    sessions[4],
    "Continuation of chat A must stay on A's session"
  );
});

test('Session ID: upstream session id is logged on every request line', async () => {
  const lines = [];
  const context = createMockContext();
  const provider = new OpenCodeChatProvider(context, { appendLine: (m) => lines.push(m) });

  await provider.provideLanguageModelChatResponse(
    GO_CHAT_MODEL,
    [createMockMessage('log my session id')],
    {},
    createMockProgress(),
    createMockToken()
  );

  const requestLines = lines.filter((l) => l.includes('Request: model='));
  assert.ok(requestLines.length >= 1, 'Expected at least one Request: log line');
  assert.match(requestLines[0], /session=ses_/, 'Request line must carry the upstream session id');
});

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

test('Session ID format matches OpenCode client descending pattern', async () => {
  const context = createMockContext();
  const provider = new OpenCodeChatProvider(context);

  await provider.provideLanguageModelChatResponse(
    GO_CHAT_MODEL,
    [createMockMessage('test session format')],
    {},
    createMockProgress(),
    createMockToken()
  );

  const requests = mockServer.getRequests();
  assert.equal(requests.length, 1);
  const sessionHeader = sessionHeaderOf(requests[0]);
  const re = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
  assert.match(
    sessionHeader,
    re,
    `Session ID ${sessionHeader} must match ^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$`
  );
});

test('Request headers mirror OpenCode client fingerprint', async () => {
  const context = createMockContext();
  const provider = new OpenCodeChatProvider(context);

  await provider.provideLanguageModelChatResponse(
    GO_CHAT_MODEL,
    [createMockMessage('test client headers')],
    {},
    createMockProgress(),
    createMockToken()
  );

  const requests = mockServer.getRequests();
  assert.equal(requests.length, 1);
  const headers = requests[0].headers;

  assert.equal(headers['x-opencode-client'], 'cli', 'Expected x-opencode-client: cli');
  assert.equal(headers['user-agent'], 'opencode/1.18.31', 'Expected User-Agent: opencode/1.18.31');
  const reqHeader = headers['x-opencode-request'];
  assert.ok(reqHeader, 'Expected x-opencode-request header');
  const re = /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
  assert.match(
    reqHeader,
    re,
    `Request ID ${reqHeader} must match ^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$`
  );
});

test('Session ID: three same-opener chats get stable distinct sessions', async () => {
  const context = createMockContext();
  const provider = new OpenCodeChatProvider(context);
  const opener = 'shared opener for three chats';
  const assistant = vscode.LanguageModelChatMessageRole.Assistant;

  await provider.provideLanguageModelChatResponse(
    GO_CHAT_MODEL,
    [createMockMessage(opener)],
    {},
    createMockProgress(),
    createMockToken()
  );
  await provider.provideLanguageModelChatResponse(
    GO_CHAT_MODEL,
    [createMockMessage(opener), createMockMessage('reply A', assistant), createMockMessage('follow-up A')],
    {},
    createMockProgress(),
    createMockToken()
  );
  await provider.provideLanguageModelChatResponse(
    GO_CHAT_MODEL,
    [createMockMessage(opener), createMockMessage('reply B', assistant), createMockMessage('follow-up B')],
    {},
    createMockProgress(),
    createMockToken()
  );
  await provider.provideLanguageModelChatResponse(
    GO_CHAT_MODEL,
    [createMockMessage(opener), createMockMessage('reply C', assistant), createMockMessage('follow-up C')],
    {},
    createMockProgress(),
    createMockToken()
  );
  // Continuations must stay on their own forks.
  await provider.provideLanguageModelChatResponse(
    GO_CHAT_MODEL,
    [createMockMessage(opener), createMockMessage('reply B', assistant), createMockMessage('follow-up B'), createMockMessage('reply B2', assistant), createMockMessage('follow-up B2')],
    {},
    createMockProgress(),
    createMockToken()
  );

  const sessions = mockServer.getRequests().map(sessionHeaderOf);
  assert.equal(sessions.length, 5, 'Expected exactly 5 upstream requests');
  assert.equal(sessions[1], sessions[0], 'Chat A turn 2 continues the root session');
  assert.equal(new Set(sessions.slice(0, 4)).size, 3, 'Root plus two forks must be three distinct sessions');
  assert.notEqual(sessions[2], sessions[3], 'Forks B and C must not share one session');
  assert.equal(sessions[4], sessions[2], 'Continuation of chat B must stay on its fork');
});

test('Session ID: divergence from a forked line forks again without bleed', async () => {
  const context = createMockContext();
  const provider = new OpenCodeChatProvider(context);
  const opener = 'opener for fork-of-fork';
  const assistant = vscode.LanguageModelChatMessageRole.Assistant;

  await provider.provideLanguageModelChatResponse(
    GO_CHAT_MODEL,
    [createMockMessage(opener)],
    {},
    createMockProgress(),
    createMockToken()
  );
  await provider.provideLanguageModelChatResponse(
    GO_CHAT_MODEL,
    [createMockMessage(opener), createMockMessage('reply A', assistant), createMockMessage('follow-up A')],
    {},
    createMockProgress(),
    createMockToken()
  );
  await provider.provideLanguageModelChatResponse(
    GO_CHAT_MODEL,
    [createMockMessage(opener), createMockMessage('reply B', assistant), createMockMessage('follow-up B')],
    {},
    createMockProgress(),
    createMockToken()
  );
  await provider.provideLanguageModelChatResponse(
    GO_CHAT_MODEL,
    [createMockMessage(opener), createMockMessage('reply B', assistant), createMockMessage('follow-up B'), createMockMessage('reply B2', assistant), createMockMessage('follow-up B2')],
    {},
    createMockProgress(),
    createMockToken()
  );
  // Two chats diverge from the forked B line at turn 4.
  await provider.provideLanguageModelChatResponse(
    GO_CHAT_MODEL,
    [createMockMessage(opener), createMockMessage('reply B', assistant), createMockMessage('follow-up B'), createMockMessage('reply B2a', assistant), createMockMessage('follow-up B2a')],
    {},
    createMockProgress(),
    createMockToken()
  );
  await provider.provideLanguageModelChatResponse(
    GO_CHAT_MODEL,
    [createMockMessage(opener), createMockMessage('reply B', assistant), createMockMessage('follow-up B'), createMockMessage('reply B2b', assistant), createMockMessage('follow-up B2b')],
    {},
    createMockProgress(),
    createMockToken()
  );
  // Continuation of the B2a line must stay on its own session.
  await provider.provideLanguageModelChatResponse(
    GO_CHAT_MODEL,
    [createMockMessage(opener), createMockMessage('reply B', assistant), createMockMessage('follow-up B'), createMockMessage('reply B2a', assistant), createMockMessage('follow-up B2a'), createMockMessage('reply B3a', assistant), createMockMessage('follow-up B3a')],
    {},
    createMockProgress(),
    createMockToken()
  );

  const sessions = mockServer.getRequests().map(sessionHeaderOf);
  assert.equal(sessions.length, 7, 'Expected exactly 7 upstream requests');
  assert.notEqual(sessions[4], sessions[5], 'Fork-of-fork lines must NOT share one session');
  assert.equal(sessions[4], sessions[6], 'Continuation of the B2a line must stay on its session');
  assert.notEqual(sessions[3], sessions[4], 'Fork-of-fork must not reuse the parent fork session');
});

test('Session ID: expired entries get fresh sessions after the TTL', async () => {
  const realNow = Date.now;
  const start = 1_700_000_000_000;
  let now = start;
  Date.now = () => now;
  try {
    const context = createMockContext();
    const provider = new OpenCodeChatProvider(context);

    await provider.provideLanguageModelChatResponse(
      GO_CHAT_MODEL,
      [createMockMessage('ttl opener')],
      {},
      createMockProgress(),
      createMockToken()
    );
    const first = sessionHeaderOf(mockServer.getRequests()[0]);

    now = start + 4 * 60 * 60 * 1000 + 1;
    await provider.provideLanguageModelChatResponse(
      GO_CHAT_MODEL,
      [createMockMessage('ttl opener')],
      {},
      createMockProgress(),
      createMockToken()
    );
    const second = sessionHeaderOf(mockServer.getRequests()[1]);

    assert.notEqual(second, first, 'Expired session must not be reused after the TTL');
  } finally {
    Date.now = realNow;
  }
});

test('Session ID: expired forks are never reused', async () => {
  const realNow = Date.now;
  const start = 1_700_000_000_000;
  let now = start;
  Date.now = () => now;
  try {
    const context = createMockContext();
    const provider = new OpenCodeChatProvider(context);
    const opener = 'ttl fork opener';
    const assistant = vscode.LanguageModelChatMessageRole.Assistant;

    await provider.provideLanguageModelChatResponse(
      GO_CHAT_MODEL,
      [createMockMessage(opener)],
      {},
      createMockProgress(),
      createMockToken()
    );
    await provider.provideLanguageModelChatResponse(
      GO_CHAT_MODEL,
      [createMockMessage(opener), createMockMessage('reply A', assistant), createMockMessage('follow-up A')],
      {},
      createMockProgress(),
      createMockToken()
    );
    await provider.provideLanguageModelChatResponse(
      GO_CHAT_MODEL,
      [createMockMessage(opener), createMockMessage('reply B', assistant), createMockMessage('follow-up B')],
      {},
      createMockProgress(),
      createMockToken()
    );
    const forkSession = sessionHeaderOf(mockServer.getRequests()[2]);

    // Touch the root line so only the fork expires.
    now = start + 4 * 60 * 60 * 1000 - 60_000;
    await provider.provideLanguageModelChatResponse(
      GO_CHAT_MODEL,
      [createMockMessage(opener), createMockMessage('reply A', assistant), createMockMessage('follow-up A'), createMockMessage('reply A2', assistant), createMockMessage('follow-up A2')],
      {},
      createMockProgress(),
      createMockToken()
    );

    now = start + 4 * 60 * 60 * 1000 + 1;
    await provider.provideLanguageModelChatResponse(
      GO_CHAT_MODEL,
      [createMockMessage(opener), createMockMessage('reply B', assistant), createMockMessage('follow-up B')],
      {},
      createMockProgress(),
      createMockToken()
    );
    const requests = mockServer.getRequests();
    const freshForkSession = sessionHeaderOf(requests[requests.length - 1]);
    assert.notEqual(freshForkSession, forkSession, 'Expired fork must not be reused');

    // The fresh fork stays stable on continuation.
    await provider.provideLanguageModelChatResponse(
      GO_CHAT_MODEL,
      [createMockMessage(opener), createMockMessage('reply B', assistant), createMockMessage('follow-up B'), createMockMessage('reply B2', assistant), createMockMessage('follow-up B2')],
      {},
      createMockProgress(),
      createMockToken()
    );
    const continued = sessionHeaderOf(mockServer.getRequests()[mockServer.getRequests().length - 1]);
    assert.equal(continued, freshForkSession, 'Continuation must stay on the fresh fork session');
  } finally {
    Date.now = realNow;
  }
});

test('Session ID: empty message history resolves with a session and does not crash', async () => {
  const context = createMockContext();
  const provider = new OpenCodeChatProvider(context);

  await provider.provideLanguageModelChatResponse(
    GO_CHAT_MODEL,
    [],
    {},
    createMockProgress(),
    createMockToken()
  );
  await provider.provideLanguageModelChatResponse(
    GO_CHAT_MODEL,
    [],
    {},
    createMockProgress(),
    createMockToken()
  );

  const requests = mockServer.getRequests();
  assert.equal(requests.length, 2, 'Expected exactly 2 upstream requests');
  assert.ok(sessionHeaderOf(requests[0]), 'Expected a session header on empty-history requests');
  assert.equal(
    sessionHeaderOf(requests[0]),
    sessionHeaderOf(requests[1]),
    'Empty histories share one root and must reuse the session'
  );
});

