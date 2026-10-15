import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import { OpenCodeChatProvider, isContextLengthError, isSchemaValidationError } from '../out/chat/infrastructure/vscode-chat-provider.js';
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
  // Model-cache isolation: provider tests that call updateModels persist a
  // models_cache.json into the shared storage dir. A leftover cache from a
  // previous run (or an earlier test in this file) would override the
  // VERIFIED catalog default and poison routing assertions. Reset it so every
  // test starts from the default catalog.
  try {
    const cacheFile = path.resolve(process.cwd(), '.test-user-data', 'honest-client-storage', 'models_cache.json');
    if (fs.existsSync(cacheFile)) fs.rmSync(cacheFile);
  } catch {}
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
      fsPath: path.resolve(process.cwd(), '.test-user-data', 'honest-client-storage'),
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

const MUSE_ZEN_MODEL = {
  id: 'muse-spark-1.3',
  name: 'Muse Spark 1.3 (OpenCode Zen)',
  family: 'muse-spark-1.3',
};

const MIMO_ZEN_MODEL = {
  id: 'mimo-v2.5-free',
  name: 'MiMo V2.5 Free (OpenCode Zen)',
  family: 'mimo-v2.5-free',
};

const GO_MODEL = {
  id: 'deepseek-v4-pro',
  name: 'DeepSeek V4 Pro (OpenCode Go)',
  family: 'deepseek-v4-pro',
};

test('Honest client: no synthetic bash/read tools in Responses payload when caller passes no tools', async () => {
  const context = createMockContext();
  const provider = new OpenCodeChatProvider(context);
  const progress = createMockProgress();
  const token = createMockToken();

  await provider.provideLanguageModelChatResponse(
    MUSE_ZEN_MODEL,
    [createMockMessage('hello')],
    {},
    progress,
    token
  );

  assert.equal(mockServer.requests.length, 1);
  const req = mockServer.requests[0];
  assert.equal(req.pathname, '/zen/v1/responses');
  assert.equal(req.body.tools, undefined, 'honest client sends no tools when caller passes none');
});

test('Honest client: no synthetic bash/read tools in Chat Completions payload when caller passes no tools', async () => {
  const context = createMockContext();
  const provider = new OpenCodeChatProvider(context);
  const progress = createMockProgress();
  const token = createMockToken();

  await provider.provideLanguageModelChatResponse(
    MIMO_ZEN_MODEL,
    [createMockMessage('hello')],
    {},
    progress,
    token
  );

  assert.equal(mockServer.requests.length, 1);
  const req = mockServer.requests[0];
  assert.equal(req.pathname, '/zen/v1/chat/completions');
  assert.equal(req.body.tools, undefined, 'honest client sends no tools when caller passes none');
});

test('Honest client: forwards caller tools unchanged, adds nothing synthetic', async () => {
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
    MUSE_ZEN_MODEL,
    [createMockMessage('hello')],
    options,
    progress,
    token
  );

  assert.equal(mockServer.requests.length, 1);
  const req = mockServer.requests[0];
  const toolNames = req.body.tools.map((t) => t.name);
  assert.deepEqual(toolNames, ['customTool']);
});

test('Free Tier Verification: strips oversized enums from the wire payload in both protocols', async () => {
  const many = Array.from({ length: 300 }, (_, i) => `mode-${i}`);

  const context = createMockContext();
  const provider = new OpenCodeChatProvider(context);

  for (const [model, path] of [
    [MUSE_ZEN_MODEL, '/zen/v1/responses'],
    [MIMO_ZEN_MODEL, '/zen/v1/chat/completions'],
  ]) {
    mockServer.requests.length = 0;

    await provider.provideLanguageModelChatResponse(
      model,
      [createMockMessage('hello')],
      {
        tools: [
          {
            name: 'picker',
            description: 'Pick a mode',
            inputSchema: {
              type: 'object',
              properties: { mode: { type: 'string', enum: many } },
            },
          },
        ],
      },
      createMockProgress(),
      createMockToken()
    );

    const req = mockServer.requests[0];
    assert.equal(req.pathname, path);
    const tools = req.body.tools;
    const schema = tools[0].parameters ?? tools[0].function.parameters;
    assert.equal(
      schema.properties.mode.enum,
      undefined,
      `oversized enum reached the wire on ${path} — the gateway would reject the whole request`
    );
    assert.equal(schema.properties.mode.type, 'string');
  }
});

test('context-length helpers still detect window overruns for logging', () => {
  assert.equal(isContextLengthError(400, 'context_length_exceeded: too many tokens', true), true);
  assert.equal(isContextLengthError(400, 'plain boom', false), false);
  assert.equal(
    isContextLengthError(
      400,
      'a single enum property with more than 250 values exceeds the maximum combined enum string length of 15000 characters',
      false
    ),
    false,
    'schema-shaped messages keep the schema label'
  );
});

test('Free Tier Verification [400 schema error]: reports a tool schema rejection, not a server error', async () => {
  mockServer.setScenario({
    mode: 'fault',
    status: 400,
    message: JSON.stringify({
      error: {
        message:
          'a single enum property with more than 250 values exceeds the maximum combined enum string length of 15000 characters',
      },
    }),
  });

  const context = createMockContext();
  const provider = new OpenCodeChatProvider(context);
  const progress = createMockProgress();

  await provider.provideLanguageModelChatResponse(
    MUSE_ZEN_MODEL,
    [createMockMessage('hello')],
    {},
    progress,
    createMockToken()
  );

  const text = progress.parts.map((p) => p.value ?? '').join('\n');
  assert.match(text, /> \u26a0\uFE0F `muse-spark-1\.3` \(400\): /);
  assert.match(text, /a single enum property with more than 250 values/);
  assert.doesNotMatch(text, /Model Alert/);
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
    MUSE_ZEN_MODEL,
    [createMockMessage('hello')],
    {},
    progress,
    token
  );

  assert.equal(progress.parts.length, 1, 'Expected alert part to be emitted');
  assert.ok(progress.parts[0] instanceof vscode.LanguageModelTextPart);
  const alertText = progress.parts[0].value;
  assert.ok(alertText.startsWith('> \u26a0\uFE0F `'), `card is minimal with warning sign, got: ${alertText}`);
  assert.match(alertText, /`muse-spark-1\.3` \(403\): /);
  assert.match(alertText, /free tier can only be used from within OpenCode/);
  assert.doesNotMatch(alertText, /Model Alert/);
  assert.doesNotMatch(alertText, /Upstream detail/);
  assert.doesNotMatch(alertText, /Unable to reach/);
});
