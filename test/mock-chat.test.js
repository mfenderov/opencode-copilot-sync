// test/mock-chat.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import vscode from './mocks/vscode/index.js';
test('mock supports chatSessions controller', () => {
  const c = vscode.chat.createChatSessionItemController('opencode', () => {});
  const item = c.createChatSessionItem(vscode.Uri.parse('opencode://session/1'), 'sess 1');
  c.items.add(item);
  assert.equal(c.id, 'opencode');
  assert.equal(c.items.size, 1);
  const d = vscode.chat.registerChatSessionContentProvider('opencode', { provideChatSessionContent: async () => ({}) });
  assert.ok(typeof d.dispose === 'function');
  c.dispose(); d.dispose();
});
