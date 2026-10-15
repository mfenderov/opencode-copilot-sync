import { test } from 'node:test';
import assert from 'node:assert/strict';

// Honest-client contract (standing): no injection parameter exists anymore.
// formatProviderTools(tools, isResponses, log, relaxedToolNames?) maps caller
// tools only; with no caller tools it returns undefined, never synthetic tools.
test('honest client: formatProviderTools never injects bash/read verification tools', async () => {
  const { formatProviderTools } = await import('../out/chat/infrastructure/tool-mapper.js');
  const discardLog = () => {};
  const empty = formatProviderTools(undefined, true, discardLog);
  assert.equal(empty, undefined, 'No caller tools must mean no tools payload, not injected bash/read');
  const chatEmpty = formatProviderTools(undefined, false, discardLog);
  assert.equal(chatEmpty, undefined);
});

test('honest client: tool-mapper exposes no verification-tool exports', async () => {
  const mapper = await import('../out/chat/infrastructure/tool-mapper.js');
  assert.equal('injectOpenCodeVerificationTools' in mapper, false, 'injectOpenCodeVerificationTools must be deleted');
  assert.equal('OPENCODE_CLIENT_VERIFICATION_TOOLS_RESPONSES' in mapper, false);
  assert.equal('OPENCODE_CLIENT_VERIFICATION_TOOLS_CHAT' in mapper, false);
  assert.equal('isSyntheticVerificationTool' in mapper, false, 'isSyntheticVerificationTool must be deleted');
});

test('honest client: request headers identify honestly, not as the OpenCode client', async () => {
  const { createOpenCodeRequestHeaders } = await import('../out/chat/infrastructure/request-factory.js');
  const sessionId = '72cc93f5-9d95-4a43-a94d-54c9ead4122d';
  const headers = createOpenCodeRequestHeaders('sk-test', sessionId);
  assert.ok(!String(headers['User-Agent'] ?? '').startsWith('opencode/'), `UA must not impersonate OpenCode, got: ${headers['User-Agent']}`);
  assert.equal(headers['x-opencode-client'], undefined, 'x-opencode-client must be gone');
  assert.equal(headers['x-opencode-session'], sessionId, 'documented routing header is not client impersonation');
  assert.equal(headers['x-opencode-request'], undefined, 'fake msg_ request header must be gone');
});

test('honest client: buildUnifiedModels announces Zen IDs as-is with Zen suffix', async () => {
  const { buildUnifiedModels } = await import('../out/models/application/synchronize-models.js');
  const { models } = buildUnifiedModels(['kimi-k3'], ['ling-3.1-flash-free', 'claude-sonnet-4-6'], {});
  const ling = models.find((m) => m.id === 'ling-3.1-flash-free');
  assert.ok(ling, 'Zen catalog IDs must be announced as-is, including -free IDs');
  assert.ok(ling.name.includes('(OpenCode Zen)'), `No (OpenCode Free) suffix may remain, got: ${ling.name}`);
  assert.ok(!models.some((m) => m.name.includes('(OpenCode Free)')));
});

test('honest client: enrichModel has no isFree concept and no Free suffix', async () => {
  const { enrichModel } = await import('../out/models/infrastructure/model-enricher.js');
  const model = enrichModel('ling-3.1-flash-free', { isGo: false });
  assert.equal(model.isFree, undefined, 'isFree field must be gone');
  assert.ok(!model.name.includes('(OpenCode Free)'), `name must not carry the Free-tier suffix, got: ${model.name}`);
  assert.ok(model.name.includes('(OpenCode Zen)'), `Zen IDs keep the Zen suffix, got: ${model.name}`);
  assert.equal(model.requestHeaders, undefined, 'fake x-opencode-session requestHeaders must be gone');
});

test('honest client: models-dev-client exposes no free-tier helpers', async () => {
  const client = await import('../out/models/infrastructure/models-dev-client.js');
  assert.equal('isFreeTierModel' in client, false, 'isFreeTierModel must be deleted');
  assert.equal('filterFreeModels' in client, false, 'filterFreeModels must be deleted');
});

test('Upstream error card relays their message with no invented reason', async () => {
  const { OpenCodeChatProvider } = await import('../out/chat/infrastructure/vscode-chat-provider.js');
  const { startMockServer } = await import('./helpers/mock-opencode-server.js');
  const path = await import('node:path');
  const server = await startMockServer(0);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    let target = input;
    if (typeof target === 'string' && target.startsWith('https://opencode.ai/zen/')) {
      target = target.replace('https://opencode.ai', server.url);
    }
    return originalFetch(target, init);
  };
  try {
    server.setScenario({
      mode: 'fault',
      status: 403,
      message: "OpenCode's free tier can only be used from within OpenCode",
    });
    server.clearRequests();
    const context = { secrets: { get: async () => 'sk-test' }, globalStorageUri: { fsPath: path.resolve(process.cwd(), '.test-user-data', 'honest-alert-storage') } };
    const provider = new OpenCodeChatProvider(context);
    const parts = [];
    const vscode = await import('vscode');
    await provider.provideLanguageModelChatResponse(
      { id: 'jev-1.13-free', name: 'Jev 1.13 Free (OpenCode Zen)', family: 'jev-1.13-free' },
      [{ role: vscode.LanguageModelChatMessageRole.User, content: [new vscode.LanguageModelTextPart('hi')] }],
      {},
      { report: (part) => parts.push(part) },
      { isCancellationRequested: false, onCancellationRequested: (() => { const e = new vscode.EventEmitter(); return e.event; })() }
    );
    assert.equal(parts.length, 1);
    assert.equal(parts[0].value, "> \u26a0\uFE0F `jev-1.13-free` (403): OpenCode's free tier can only be used from within OpenCode");
  } finally {
    globalThis.fetch = originalFetch;
    await server.close();
  }
});

test('Upstream error card quotes every line of a multi-line message', async () => {
  const { OpenCodeChatProvider } = await import('../out/chat/infrastructure/vscode-chat-provider.js');
  const { startMockServer } = await import('./helpers/mock-opencode-server.js');
  const path = await import('node:path');
  const server = await startMockServer(0);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    let target = input;
    if (typeof target === 'string' && target.startsWith('https://opencode.ai/zen/')) {
      target = target.replace('https://opencode.ai', server.url);
    }
    return originalFetch(target, init);
  };
  try {
    server.setScenario({
      mode: 'fault',
      status: 500,
      message: 'first line\nsecond line\nthird line',
    });
    server.clearRequests();
    const context = { secrets: { get: async () => 'sk-test' }, globalStorageUri: { fsPath: path.resolve(process.cwd(), '.test-user-data', 'honest-alert-multiline-storage') } };
    const provider = new OpenCodeChatProvider(context);
    const parts = [];
    const vscode = await import('vscode');
    await provider.provideLanguageModelChatResponse(
      { id: 'kimi-k3', name: 'Kimi K3 (OpenCode Go)', family: 'kimi-k3' },
      [{ role: vscode.LanguageModelChatMessageRole.User, content: [new vscode.LanguageModelTextPart('hi')] }],
      {},
      { report: (part) => parts.push(part) },
      { isCancellationRequested: false, onCancellationRequested: (() => { const e = new vscode.EventEmitter(); return e.event; })() }
    );
    assert.equal(parts.length, 1);
    for (const line of String(parts[0].value).split('\n')) {
      assert.ok(line.startsWith('> '), `every alert line stays inside the blockquote, got: ${JSON.stringify(line)}`);
    }
  } finally {
    globalThis.fetch = originalFetch;
    await server.close();
  }
});
