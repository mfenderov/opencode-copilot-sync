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

const MUSE_FREE_MODEL = {
  id: 'muse-spark-1.3-contributor-free',
  name: 'Muse Spark 1.3 Contributor (OpenCode Free)',
  family: 'muse-spark-1.3-contributor-free',
};

const MIMO_FREE_MODEL = {
  id: 'mimo-v2.5-free',
  name: 'MiMo V2.5 (OpenCode Free)',
  family: 'mimo-v2.5-free',
};

const GO_MODEL = {
  id: 'deepseek-v4-pro',
  name: 'DeepSeek V4 Pro (OpenCode Go)',
  family: 'deepseek-v4-pro',
};

test('Free Tier Verification: injects bash and read tools into Responses payload when caller passes no tools', async () => {
  const context = createMockContext();
  const provider = new OpenCodeChatProvider(context);
  const progress = createMockProgress();
  const token = createMockToken();

  await provider.provideLanguageModelChatResponse(
    MUSE_FREE_MODEL,
    [createMockMessage('hello')],
    {},
    progress,
    token
  );

  assert.equal(mockServer.requests.length, 1);
  const req = mockServer.requests[0];
  assert.equal(req.pathname, '/zen/v1/responses');
  assert.ok(Array.isArray(req.body.tools), 'Expected tools array to be present in body');

  const toolNames = req.body.tools.map((t) => t.name);
  assert.ok(toolNames.includes('bash'), 'Expected bash tool in verification tools');
  assert.ok(toolNames.includes('read'), 'Expected read tool in verification tools');
});

test('Free Tier Verification: injects bash and read tools into Chat Completions payload when caller passes no tools', async () => {
  const context = createMockContext();
  const provider = new OpenCodeChatProvider(context);
  const progress = createMockProgress();
  const token = createMockToken();

  await provider.provideLanguageModelChatResponse(
    MIMO_FREE_MODEL,
    [createMockMessage('hello')],
    {},
    progress,
    token
  );

  assert.equal(mockServer.requests.length, 1);
  const req = mockServer.requests[0];
  assert.equal(req.pathname, '/zen/v1/chat/completions');
  assert.ok(Array.isArray(req.body.tools), 'Expected tools array to be present in body');

  const toolNames = req.body.tools.map((t) => t.function?.name);
  assert.ok(toolNames.includes('bash'), 'Expected bash tool in verification tools');
  assert.ok(toolNames.includes('read'), 'Expected read tool in verification tools');
});

test('Free Tier Verification: appends bash and read tools alongside caller tools if missing', async () => {
  const context = createMockContext();
  const provider = new OpenCodeChatProvider(context);
  const progress = createMockProgress();
  const token = createMockToken();

  const options = {
    tools: [
      {
        name: 'customTool',
        description: 'A custom tool',
        inputSchema: { type: 'object' },
      },
    ],
  };

  await provider.provideLanguageModelChatResponse(
    MUSE_FREE_MODEL,
    [createMockMessage('hello')],
    options,
    progress,
    token
  );

  assert.equal(mockServer.requests.length, 1);
  const req = mockServer.requests[0];
  const toolNames = req.body.tools.map((t) => t.name);
  assert.ok(toolNames.includes('customTool'), 'Expected caller customTool to be preserved');
  assert.ok(toolNames.includes('bash'), 'Expected bash tool to be appended');
  assert.ok(toolNames.includes('read'), 'Expected read tool to be appended');
});

test('Free Tier Verification [403 FreeTierError]: streams alert card and does NOT throw NoPermissions', async () => {
  mockServer.setScenario({
    mode: 'fault',
    status: 403,
    message: JSON.stringify({
      type: 'error',
      error: {
        type: 'FreeTierError',
        message: "Error from provider (Console): OpenCode's free tier can only be used from within OpenCode",
      },
    }),
  });

  const context = createMockContext();
  const provider = new OpenCodeChatProvider(context);
  const progress = createMockProgress();
  const token = createMockToken();

  // Must NOT throw: clean resolution bypasses Copilot's retry loop
  await provider.provideLanguageModelChatResponse(
    MUSE_FREE_MODEL,
    [createMockMessage('hello')],
    {},
    progress,
    token
  );

  assert.equal(progress.parts.length, 1, 'Expected alert part to be emitted');
  assert.ok(progress.parts[0] instanceof vscode.LanguageModelTextPart);
  const alertText = progress.parts[0].value;
  assert.match(alertText, /⚠️ \*\*OpenCode Model Alert \(403/);
  assert.match(alertText, /free tier can only be used from within OpenCode/);
  assert.doesNotMatch(alertText, /Suggestions:/);
});
