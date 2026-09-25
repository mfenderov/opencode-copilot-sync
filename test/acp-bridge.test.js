import test from 'node:test';
import assert from 'node:assert/strict';
import { createAcpBridge } from '../out/acp-bridge.js';
test('bridge spawns opencode acp and frames newSession', async () => {
  const calls = [];
  const fakeSpawn = (cmd, args) => {
    calls.push([cmd, args]);
    return { stdin: { write: () => {}, end: () => {} }, stdout: { on: () => {} }, stderr: { on: () => {} }, on: () => {}, kill: () => {}, unref: () => {} };
  };
  const b = createAcpBridge(fakeSpawn);
  const s = await b.newSession('/tmp/ws');
  assert.ok(s.resource.startsWith('opencode://session/'));
  assert.deepEqual(calls[0][0], 'opencode');
  assert.ok(calls[0][1].includes('acp'));
  b.dispose();
});
