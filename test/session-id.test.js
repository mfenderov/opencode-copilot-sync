import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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
    if (String(target).includes('/zen/go/v1/') && !new Headers(init?.headers).get('x-opencode-session')) {
      return new Response(JSON.stringify({ error: { message: 'Request is missing x-opencode-session and cannot be routed efficiently.' } }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
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
  // Model-cache isolation: provider tests that call updateModels persist a
  // models_cache.json into the shared storage dir. A leftover cache from a
  // previous run (or an earlier test in this file) would override the
  // VERIFIED catalog default and poison routing assertions. Reset it so every
  // test starts from the default catalog.
  try {
    const cacheFile = path.resolve(process.cwd(), '.test-user-data', 'session-id-storage', 'models_cache.json');
    if (fs.existsSync(cacheFile)) fs.rmSync(cacheFile);
  } catch {}
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

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const GO_RESPONSES_MODEL = {
  id: 'muse-spark-1.3-contributor',
  name: 'Muse Spark 1.3 Contributor (OpenCode Go)',
  family: 'muse-spark-1.3-contributor',
};

test('Go requires a stable UUID session across turns without impersonating the OpenCode client', async () => {
  const context = createMockContext();
  const provider = new OpenCodeChatProvider(context);

  await provider.provideLanguageModelChatResponse(
    GO_CHAT_MODEL,
    [createMockMessage('explain quantum mechanics')],
    {},
    createMockProgress(),
    createMockToken()
  );
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
  assert.equal(requests.length, 2, 'Go must accept both requests with its required routing header');
  assert.equal(requests[0].headers['x-opencode-session'], requests[1].headers['x-opencode-session']);
  for (const req of requests) {
    assert.match(req.headers['x-opencode-session'], UUID_V4, 'session is an ordinary UUID, not an OpenCode ses_ ID');
    assert.equal(req.headers['x-opencode-session-id'], undefined);
    assert.equal(req.headers['x-session-affinity'], undefined);
    assert.equal(req.headers['x-opencode-request'], undefined, 'no fake msg_ request header');
    assert.equal(req.headers['x-opencode-client'], undefined, 'no fake client header');
    assert.ok(String(req.headers['authorization'] ?? '').startsWith('Bearer '), 'honest API-key auth');
  }
});

test('Honest client: User-Agent identifies this extension, not the OpenCode client', async () => {
  const context = createMockContext();
  const provider = new OpenCodeChatProvider(context);

  await provider.provideLanguageModelChatResponse(
    GO_CHAT_MODEL,
    [createMockMessage('identify yourself')],
    {},
    createMockProgress(),
    createMockToken()
  );

  const requests = mockServer.getRequests();
  assert.equal(requests.length, 1);
  const ua = String(requests[0].headers['user-agent'] ?? '');
  assert.ok(!ua.startsWith('opencode/'), `UA must not impersonate OpenCode, got: ${ua}`);
  assert.match(ua, /vscode-opencode-copilot-sync/, 'UA names this extension');
});

test('Go uses the same session for replayed turns', async () => {
  const context = createMockContext();
  const provider = new OpenCodeChatProvider(context);
  const opener = 'identical opener pasted into two different chats';

  for (let i = 0; i < 3; i++) {
    await provider.provideLanguageModelChatResponse(
      GO_CHAT_MODEL,
      [createMockMessage(opener)],
      {},
      createMockProgress(),
      createMockToken()
    );
  }

  const requests = mockServer.getRequests();
  assert.equal(requests.length, 3, 'Expected exactly 3 upstream requests');
  assert.match(requests[0].headers['x-opencode-session'], UUID_V4);
  assert.equal(new Set(requests.map((request) => request.headers['x-opencode-session'])).size, 1);
});

for (const [model, endpoint] of [
  [GO_CHAT_MODEL, '/zen/go/v1/chat/completions'],
  [GO_RESPONSES_MODEL, '/zen/go/v1/responses'],
]) {
  test(`Go accepts ${endpoint} with honest identity and a session header`, async () => {
    const provider = new OpenCodeChatProvider(createMockContext());
    const progress = createMockProgress();
    await provider.provideLanguageModelChatResponse(
      model, [createMockMessage('ping')], {}, progress, createMockToken()
    );

    const [request] = mockServer.getRequests();
    assert.ok(request, 'request must pass Go routing validation');
    assert.equal(request.pathname, endpoint);
    assert.match(request.headers['x-opencode-session'], UUID_V4);
    assert.match(request.headers['user-agent'], /^vscode-opencode-copilot-sync\//);
    assert.equal(request.headers['x-opencode-client'], undefined);
    assert.equal(request.body.tools, undefined, 'no synthetic verification tools');
    assert.ok(progress.parts.some((part) => part instanceof vscode.LanguageModelTextPart));
    assert.doesNotMatch(progress.parts.map((part) => part.value ?? '').join(''), /\u26a0\uFE0F/);
  });
}

test('Distinct conversations use distinct routing sessions', async () => {
  const provider = new OpenCodeChatProvider(createMockContext());
  for (const opener of ['conversation A', 'conversation B']) {
    await provider.provideLanguageModelChatResponse(
      GO_CHAT_MODEL, [createMockMessage(opener)], {}, createMockProgress(), createMockToken()
    );
  }
  const sessions = mockServer.getRequests().map((request) => request.headers['x-opencode-session']);
  assert.equal(sessions.length, 2);
  sessions.forEach((id) => assert.match(id, UUID_V4));
  assert.notEqual(sessions[0], sessions[1]);
});

test('Same-opener conversations fork on divergence and reuse the fork on continuation', async () => {
  const provider = new OpenCodeChatProvider(createMockContext());
  const assistant = vscode.LanguageModelChatMessageRole.Assistant;
  const histories = [
    [createMockMessage('same opener')],
    [createMockMessage('same opener'), createMockMessage('reply A', assistant), createMockMessage('follow-up A')],
    [createMockMessage('same opener'), createMockMessage('reply B', assistant), createMockMessage('follow-up B')],
    [createMockMessage('same opener'), createMockMessage('reply B', assistant), createMockMessage('follow-up B'), createMockMessage('reply B2', assistant), createMockMessage('continue B')],
  ];
  for (const history of histories) {
    await provider.provideLanguageModelChatResponse(
      GO_CHAT_MODEL, history, {}, createMockProgress(), createMockToken()
    );
  }
  const sessions = mockServer.getRequests().map((request) => request.headers['x-opencode-session']);
  assert.equal(sessions.length, 4);
  assert.equal(sessions[0], sessions[1]);
  assert.notEqual(sessions[1], sessions[2]);
  assert.equal(sessions[2], sessions[3]);
});

test('Session ID: bounded cache evicts the least-recently-used conversation once full', async () => {
  const provider = new OpenCodeChatProvider(createMockContext());
  const opener = 'original conversation, will be evicted eventually';
  await provider.provideLanguageModelChatResponse(
    GO_CHAT_MODEL, [createMockMessage(opener)], {}, createMockProgress(), createMockToken()
  );
  const requestsAfterFirst = mockServer.getRequests();
  const originalSession = requestsAfterFirst[0].headers['x-opencode-session'];
  assert.match(originalSession, UUID_V4);

  // Fill the cache past its capacity (50) with distinct conversations so the
  // original entry, being the oldest, gets evicted.
  for (let i = 0; i < 55; i++) {
    await provider.provideLanguageModelChatResponse(
      GO_CHAT_MODEL, [createMockMessage(`filler conversation number ${i}`)], {}, createMockProgress(), createMockToken()
    );
  }

  // Re-send the original conversation's opening message as a fresh "turn 1".
  await provider.provideLanguageModelChatResponse(
    GO_CHAT_MODEL, [createMockMessage(opener)], {}, createMockProgress(), createMockToken()
  );

  const requests = mockServer.getRequests();
  const replaySession = requests[requests.length - 1].headers['x-opencode-session'];
  assert.notEqual(
    replaySession,
    originalSession,
    'Expected the evicted conversation to receive a brand-new session id'
  );
});

test('Go retains the session across transient retries', async () => {
  mockServer.setScenario([{ mode: 'fault', status: 503 }, { mode: 'standard', content: 'Recovered' }]);
  const provider = new OpenCodeChatProvider(createMockContext());
  const progress = createMockProgress();
  await provider.provideLanguageModelChatResponse(
    GO_RESPONSES_MODEL, [createMockMessage('retry me')], {}, progress, createMockToken()
  );
  const requests = mockServer.getRequests();
  assert.equal(requests.length, 2);
  assert.match(requests[0].headers['x-opencode-session'], UUID_V4);
  assert.equal(requests[0].headers['x-opencode-session'], requests[1].headers['x-opencode-session']);
  assert.match(progress.parts.map((part) => part.value ?? '').join(''), /Recovered/);
});

test('Honest client: request log line carries no fake session suffix', async () => {
  const lines = [];
  const context = createMockContext();
  const channel = { appendLine: (m) => lines.push(m), info: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m) => lines.push(m) };
  const provider = new OpenCodeChatProvider(context, channel);

  await provider.provideLanguageModelChatResponse(
    GO_CHAT_MODEL,
    [createMockMessage('log my request')],
    {},
    createMockProgress(),
    createMockToken()
  );

  const requestLines = lines.filter((l) => l.includes('Request: model='));
  assert.ok(requestLines.length >= 1, 'Expected at least one Request: log line');
  assert.doesNotMatch(requestLines[0], /session=ses_/, 'Request line must not carry a fake session id');
});

test('Model catalog: updates and information queries log announced counts', async () => {
  const lines = [];
  const context = createMockContext();
  const provider = new OpenCodeChatProvider(context, { appendLine: (m) => lines.push(m) });

  provider.updateModels([
    { id: 'a', name: 'A', family: 'a', catalog: 'go', contextWindow: 1000, maxOutputTokens: 100 },
    { id: 'b', name: 'B', family: 'b', catalog: 'zen', contextWindow: 1000, maxOutputTokens: 100 },
  ]);
  await provider.provideLanguageModelChatInformation({}, createMockToken());

  assert.ok(
    lines.some((l) => l.includes('Model catalog updated: 2 models announced')),
    `expected update log; got: ${JSON.stringify(lines)}`
  );
  assert.ok(
    lines.some((l) => l.includes('Model information queried: 2 models announced')),
    `expected query log; got: ${JSON.stringify(lines)}`
  );
});

test('Model catalog: identical sync results do not re-announce to the host', async () => {
  const context = createMockContext();
  const provider = new OpenCodeChatProvider(context, { appendLine: () => {} });
  let fires = 0;
  provider.onDidChangeLanguageModelChatInformation(() => {
    fires++;
  });
  const models = [
    { id: 'a', name: 'A', family: 'a', catalog: 'go', contextWindow: 1000, maxOutputTokens: 100 },
  ];
  provider.updateModels(models);
  provider.updateModels(models.map((m) => ({ ...m })));
  assert.equal(fires, 1);
});
