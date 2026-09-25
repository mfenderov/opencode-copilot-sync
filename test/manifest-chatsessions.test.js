// test/manifest-chatsessions.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url)));
test('manifest declares opencode chatSession', () => {
  assert.ok(pkg.enabledApiProposals.includes('chatSessionsProvider'));
  assert.ok(pkg.activationEvents.includes('onChatSession:opencode'));
  const e = pkg.contributes.chatSessions.find(c => c.type === 'opencode');
  assert.equal(e.name, 'opencode');
  assert.equal(e.displayName, 'OpenCode');
  assert.ok(e.description.length > 0);
  assert.equal(e.requiresCopilotSignIn, false);
  assert.ok(!('hideFromSessionTypePicker' in e) || e.hideFromSessionTypePicker === false);
});
