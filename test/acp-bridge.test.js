import test from 'node:test';
import assert from 'node:assert/strict';
import { createAcpBridge } from '../out/acp-bridge.js';
test('bridge spawns opencode acp and frames newSession', async () => {
  const calls = [];
  let dataCb = null;
  const fakeSpawn = (cmd, args, opts) => {
    calls.push([cmd, args, opts]);
    return { stdin: { write: () => {}, end: () => {} }, stdout: { on: (ev, cb) => { if (ev === 'data') dataCb = cb; } }, stderr: { on: () => {} }, on: () => {}, kill: () => {}, unref: () => {} };
  };
  const b = createAcpBridge(fakeSpawn);
  const p = b.newSession('/tmp/ws');
  await new Promise(r => setTimeout(r, 10));
  const writes = [];
  // capture initialize id from pending: emulate server replies by re-driving through stdout
  dataCb(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } }) + '\n');
  await new Promise(r => setTimeout(r, 10));
  dataCb(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { sessionId: 'ses_abc123' } }) + '\n');
  const s = await p;
  assert.ok(s.resource === 'opencode://session/ses_abc123');
  assert.deepEqual(calls[0][0], 'opencode');
  assert.deepEqual(calls[0][1], ['acp']);
  assert.equal(calls[0][2]?.cwd, '/tmp/ws');
  b.dispose();
});
test('bridge streams prompt chunks and joins text', async () => {
  let dataCb = null;
  const written = [];
  const fakeSpawn = () => ({ stdin: { write: (d) => written.push(String(d)) }, stdout: { on: (ev, cb) => { if (ev === 'data') dataCb = cb; } }, stderr: { on: () => {} }, on: () => {}, kill: () => {}, unref: () => {} });
  const b = createAcpBridge(fakeSpawn);
  const p = b.newSession('/tmp/ws');
  await new Promise(r => setTimeout(r, 10));
  dataCb(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } }) + '\n');
  await new Promise(r => setTimeout(r, 10));
  dataCb(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { sessionId: 'ses_xyz' } }) + '\n');
  await p;
  const chunks = [];
  const gp = b.prompt('opencode://session/ses_xyz', 'hi', (t) => chunks.push(t));
  await new Promise(r => setTimeout(r, 10));
  dataCb(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'ses_xyz', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'HELLO ' } } } }) + '\n');
  dataCb(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'ses_xyz', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'WORLD' } } } }) + '\n');
  dataCb(JSON.stringify({ jsonrpc: '2.0', id: 3, result: { stopReason: 'end_turn' } }) + '\n');
  const text = await gp;
  assert.equal(text, 'HELLO WORLD');
  assert.deepEqual(chunks, ['HELLO ', 'WORLD']);
  b.dispose();
});
