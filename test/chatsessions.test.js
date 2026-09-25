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
    registerChatSessionContentProvider: (scheme, p) => { fakeVscode._provider = p; return { dispose() {} }; } } };
  const bridge = { listSessions: async () => [], newSession: async () => ({ resource: 'opencode://session/abc', label: 'abc' }), prompt: async (handle, text, onChunk) => { prompts.push([handle, text]); onChunk?.('bridge says: ' + text); return 'bridge says: ' + text; }, cancel: async () => {}, dispose: () => {} };
  const prompts = [];
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
  h.dispose();
});
