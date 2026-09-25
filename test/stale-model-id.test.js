// Regression test: sync v1 (id A) -> chat pinned to A -> sync v2 (A renamed to B)
// -> request with A must degrade to ONE alert card, never a thrown NotFound retry storm.
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
      fsPath: path.resolve(process.cwd(), '.test-user-data', 'stale-model-storage'),
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

function makeMeta(id, catalog = 'zen') {
  return {
    id,
    name: `${id} (OpenCode Zen)`,
    family: id,
    catalog,
    contextWindow: 1048576,
    maxOutputTokens: 65536,
    vision: false,
    thinking: true,
    apiType: 'responses',
  };
}

// Simulates the rename described in the bug: muse-spark-1.2-* -> 1.3-* between syncs.
const OLD_ID = 'muse-spark-1.2-contributor';
const NEW_ID = 'muse-spark-1.3-contributor';
const STALE_PINNED_MODEL = {
  id: OLD_ID,
  name: 'Muse Spark 1.2 Contributor (OpenCode Go)',
  family: OLD_ID,
};

test('stale model ID after resync renames it: ONE alert card, never a thrown NotFound', async () => {
  mockServer.setScenario({ mode: 'fault', status: 404 });

  const context = createMockContext();
  const provider = new OpenCodeChatProvider(context);
  const progress = createMockProgress();
  const token = createMockToken();

  // Sync v1 advertises A; chat pins A; sync v2 renames A -> B (wholesale replace).
  provider.updateModels([makeMeta(OLD_ID)]);
  provider.updateModels([makeMeta(NEW_ID)]);

  // Must resolve (not reject): degrades to a single alert card.
  await provider.provideLanguageModelChatResponse(
    STALE_PINNED_MODEL,
    [createMockMessage('hello')],
    {},
    progress,
    token
  );

  assert.equal(mockServer.getRequests().length, 1, 'expected exactly one upstream attempt');
  const alertCards = progress.parts.filter(
    (p) => p instanceof vscode.LanguageModelTextPart && /OpenCode Model Alert/.test(p.value)
  );
  assert.equal(alertCards.length, 1, 'expected exactly ONE alert card, never a retry storm');
  assert.match(alertCards[0].value, new RegExp(OLD_ID.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(alertCards[0].value, /stale model ID/);
});

test('renamed (current) model ID still streams normally after resync', async () => {
  const context = createMockContext();
  const provider = new OpenCodeChatProvider(context);
  const progress = createMockProgress();
  const token = createMockToken();

  provider.updateModels([makeMeta(OLD_ID)]);
  provider.updateModels([makeMeta(NEW_ID)]);

  await provider.provideLanguageModelChatResponse(
    { id: NEW_ID, name: 'Muse Spark 1.3 Contributor (OpenCode Go)', family: NEW_ID },
    [createMockMessage('hello')],
    {},
    progress,
    token
  );

  const textParts = progress.parts.filter((p) => p instanceof vscode.LanguageModelTextPart);
  assert.ok(textParts.length >= 1, 'expected streamed success content');
  assert.ok(
    !textParts.some((p) => /OpenCode Model Alert/.test(p.value)),
    'no alert card should be emitted for a current catalog ID'
  );
});
