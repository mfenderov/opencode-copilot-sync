// test/chatsessions.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import vscode from './mocks/vscode/index.js';
import { registerOpencodeChatSession, isChatSessionsAvailable } from '../out/chatsessions.js';
test('isChatSessionsAvailable gates on proposed API presence', () => {
  assert.equal(isChatSessionsAvailable(vscode), true);
  assert.equal(isChatSessionsAvailable({ chat: {} }), false);
  assert.equal(isChatSessionsAvailable({}), false);
});
test('register throws a clear error when proposed API is missing', () => {
  assert.throws(() => registerOpencodeChatSession({ chat: {} }, { appendLine() {} }), /chatSessionsProvider API not available/);
});
test('registers opencode controller and serves content', async () => {
  const created = [];
  const fakeVscode = { ...vscode, chat: { ...vscode.chat,
    createChatSessionItemController: (id, rh) => { const c = vscode.chat.createChatSessionItemController(id, rh); created.push(c); return c; },
    registerChatSessionContentProvider: (scheme, p) => { fakeVscode._provider = p; fakeVscode._handleOptions = p.provideHandleOptionsChange?.bind?.(p); return { dispose() {} }; } } };
  const bridge = { listSessions: async () => [], newSession: async () => ({ resource: 'opencode://session/abc', label: 'abc' }), prompt: async (handle, text, onChunk) => { prompts.push([handle, text]); onChunk?.('bridge says: ' + text); return 'bridge says: ' + text; }, cancel: async () => {}, dispose: () => {},
    getModels: async () => ({ models: [{ value: 'opencode/big-pickle', name: 'opencode/Big Pickle' }, { value: 'opencode/gpt-5', name: 'opencode/GPT 5' }], current: 'opencode/big-pickle' }),
    getConfig: async () => ({ models: [{ value: 'opencode/big-pickle', name: 'opencode/Big Pickle' }, { value: 'opencode/gpt-5', name: 'opencode/GPT 5' }], currentModel: 'opencode/big-pickle', efforts: [{ value: 'low', name: 'Low' }, { value: 'default', name: 'Default' }], currentEffort: 'default', modes: [{ value: 'build', name: 'Build' }, { value: 'plan', name: 'Plan' }], currentMode: 'build' }),
    getSessionModel: (h) => sessionModelOf(h), setSessionModel: (h, m) => { sessionCfgSet.push([h, { model: m }]); },
    getSessionConfig: (h) => ({}), setSessionConfig: (h, c) => { sessionCfgSet.push([h, c]); } };
  const sessionModelSet = [];
  const sessionCfgSet = [];
  const prompts = [];
  const sessionModelOf = (_h) => undefined;
  const h = registerOpencodeChatSession(fakeVscode, { appendLine() {} }, bridge);
  assert.equal(created[0].id, 'opencode');
  const content = await fakeVscode._provider.provideChatSessionContent(vscode.Uri.parse('opencode://session/abc'), {}, {});
  assert.ok(content.history.length >= 1);
  const turn = content.history[0];
  assert.ok(turn instanceof vscode.ChatResponseTurn, 'history items must be ChatResponseTurn instances (exthost convertResponseTurn reads .response.map)');
  assert.ok(Array.isArray(turn.response) && turn.response.length >= 1, 'response turn must carry parts array');
  assert.equal(typeof content.requestHandler, 'function', 'session must be writeable (requestHandler present)');
  const streamed = [];
  const progress = [];
  await content.requestHandler({ prompt: 'hello' }, {}, { markdown: (t) => { streamed.push(t); }, progress: (t) => { progress.push(t); } }, {});
  assert.ok(streamed.length === 1 && streamed[0].includes('hello'), 'requestHandler streams bridge text');
  assert.equal(progress.length, 1, 'progress notice pushed once');
  assert.equal(prompts.length, 1, 'bridge.prompt invoked once');
  assert.ok(prompts[0][1].includes('hello'), 'bridge receives user prompt');
  // Model picker: input-state exposes the ACP model catalog as a group.
  const inputState = await created[0].getChatSessionInputState(vscode.Uri.parse('opencode://session/abc'), {});
  const groups = inputState?.groups ?? inputState;
  const modelGroup = (Array.isArray(groups) ? groups : []).find((g) => g?.id === 'models');
  assert.ok(modelGroup, 'models option group present');
  assert.equal(modelGroup.items.length, 2, 'ACP catalog items exposed');
  assert.ok(modelGroup.selected?.id === 'opencode/big-pickle', 'current model preselected');
  // Per-message model override flows into the bridge.
  await content.requestHandler({ prompt: 'hi again' }, { inputState: { groups: [{ id: 'models', selected: { id: 'opencode/gpt-5' } }] } }, { markdown: () => {}, progress: () => {} }, {});
  assert.ok(sessionCfgSet.some(([h, c]) => c?.model === 'opencode/gpt-5'), 'model override applied to bridge');
  // Picker-driven change (provideHandleOptionsChange) persists per session.
  await fakeVscode._provider.provideHandleOptionsChange(
    vscode.Uri.parse('opencode://session/abc'),
    [{ optionId: 'models', value: 'opencode/kimi-k3' }],
    {},
  );
  assert.ok(sessionCfgSet.some(([h, c]) => c?.model === 'opencode/kimi-k3'), 'picker selection applied to bridge');
  // Type-level provider options seed the input-bar Model picker.
  const providerOpts = await fakeVscode._provider.provideChatSessionProviderOptions({});
  const typeGroups = providerOpts?.optionGroups ?? [];
  const typeModels = typeGroups.find((g) => g?.id === 'models');
  assert.ok(typeModels, 'type-level models group present');
  assert.equal(typeModels.items.length, 2, 'ACP catalog exposed at type level');
  assert.ok(typeModels.selected?.id === 'opencode/big-pickle', 'current model preselected at type level');
  const typeMode = typeGroups.find((g) => g?.id === 'mode');
  assert.ok(typeMode, 'type-level mode group present (build/plan)');
  assert.equal(typeMode.items.length, 2, 'mode options exposed');
  assert.equal(typeGroups[0]?.id, 'mode', 'mode picker comes first');
  assert.equal(typeGroups[1]?.id, 'models', 'model picker comes second');
  h.dispose();
});
