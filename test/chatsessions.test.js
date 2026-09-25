// test/chatsessions.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import vscode from './mocks/vscode/index.js';
import { registerOpencodeChatSession } from '../out/chatsessions.js';
test('registers opencode controller and serves content', async () => {
  const created = [];
  const fakeVscode = { ...vscode, chat: { ...vscode.chat,
    createChatSessionItemController: (id, rh) => { const c = vscode.chat.createChatSessionItemController(id, rh); created.push(c); return c; },
    registerChatSessionContentProvider: (scheme, p) => { fakeVscode._provider = p; return { dispose() {} }; } } };
  const bridge = { listSessions: async () => [], newSession: async () => ({ resource: 'opencode://session/abc', label: 'abc' }), prompt: async () => {}, cancel: async () => {}, dispose: () => {} };
  const h = registerOpencodeChatSession(fakeVscode, { appendLine() {} }, bridge);
  assert.equal(created[0].id, 'opencode');
  const content = await fakeVscode._provider.provideChatSessionContent(vscode.Uri.parse('opencode://session/abc'), {}, {});
  assert.ok(content.history.length >= 1);
  h.dispose();
});
