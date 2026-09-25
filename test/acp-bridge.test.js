import test from 'node:test';
import assert from 'node:assert/strict';
import { createAcpBridge } from '../out/acp-bridge.js';
test('bridge spawns opencode acp and frames newSession', async () => {
  const calls = [];
  let dataCb = null;
  const written = [];
  const fakeSpawn = (cmd, args, opts) => {
    calls.push([cmd, args, opts]);
    const child = { stdin: { write: (d) => { written.push(String(d)); autoReply(String(d)); }, end: () => {} }, stdout: { on: (ev, cb) => { if (ev === 'data') dataCb = cb; } }, stderr: { on: () => {} }, on: () => {}, kill: () => {}, unref: () => {} };
    // Reply on next tick: ensure() sends initialize synchronously during
    // createAcpBridge wiring, before dataCb is assigned.
    return child;
  };
  function autoReply(raw) {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    // Defer: dataCb is assigned via stdout.on() after ensure() returns.
    if (msg.id === 1 && msg.method === 'initialize') setTimeout(() => dataCb && dataCb(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } }) + '\n'), 5);
    else if (msg.method === 'session/new' && written.filter(w => { try { return JSON.parse(w).method === 'session/new'; } catch { return false; } }).length <= 1) {
      const id = msg.id;
      setTimeout(() => dataCb && dataCb(JSON.stringify({ jsonrpc: '2.0', id, result: { sessionId: 'ses_prefetch', configOptions: [
          { id: 'model', name: 'Model', currentValue: 'm1', options: [{ value: 'm1', name: 'M1' }] },
          { id: 'mode', name: 'Session Mode', currentValue: 'build', options: [{ value: 'build', name: 'Build' }, { value: 'plan', name: 'Plan' }] },
        ] } }) + '\n'), 5);
    }
    else if (msg.method === 'session/delete') setTimeout(() => dataCb && dataCb(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\n'), 5);
  }
  const b = createAcpBridge(fakeSpawn);
  const p = b.newSession('/tmp/ws');
  await new Promise(r => setTimeout(r, 50));
  let realId = null;
  for (const w of written) { try { const m = JSON.parse(w); if (m.method === 'session/new' && !m.__x) { /* prefetch is first, real is second */ } } catch {} }
  const news = written.map(w => { try { return JSON.parse(w); } catch { return null; } }).filter(m => m?.method === 'session/new');
  realId = news.length ? news[news.length - 1].id : null;
  assert.ok(realId, 'real session/new sent');
  dataCb(JSON.stringify({ jsonrpc: '2.0', id: realId, result: { sessionId: 'ses_abc123' } }) + '\n');
  const s = await p;
  assert.ok(s.resource === 'opencode://session/ses_abc123');
  assert.deepEqual(calls[0][0], 'opencode');
  assert.deepEqual(calls[0][1], ['acp']);
  assert.equal(calls[0][2]?.cwd, '/tmp/ws');
  // Prefetch harvested the catalog before any session existed.
  const cfg = await b.getConfig();
  assert.equal(cfg.models.length, 1, 'prefetched model catalog');
  assert.equal(cfg.modes.length, 2, 'prefetched mode catalog');
  b.dispose();
});
test('bridge streams prompt chunks and joins text', async () => {
  let dataCb = null;
  const written = [];
  const fakeSpawn = () => ({ stdin: { write: (d) => { written.push(String(d)); autoReply2(String(d)); } }, stdout: { on: (ev, cb) => { if (ev === 'data') dataCb = cb; } }, stderr: { on: () => {} }, on: () => {}, kill: () => {}, unref: () => {} });
  function autoReply2(raw) {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (msg.method === 'initialize') setTimeout(() => dataCb && dataCb(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } }) + '\n'), 5);
    else if (msg.method === 'session/new') setTimeout(() => dataCb && dataCb(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'ses_xyz', configOptions: [] } }) + '\n'), 5);
    else if (msg.method === 'session/delete') setTimeout(() => dataCb && dataCb(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\n'), 5);
  }
  const b = createAcpBridge(fakeSpawn);
  const p = b.newSession('/tmp/ws');
  const s = await p;
  assert.equal(s.resource, 'opencode://session/ses_xyz');
  const chunks = [];
  const gp = b.prompt('opencode://session/ses_xyz', 'hi', (t) => chunks.push(t));
  await new Promise(r => setTimeout(r, 20));
  let promptId = null;
  for (const w of written) { try { const m = JSON.parse(w); if (m.method === 'session/prompt') promptId = m.id; } catch {} }
  assert.ok(promptId, 'prompt request sent');
  dataCb(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'ses_xyz', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'HELLO ' } } } }) + '\n');
  dataCb(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'ses_xyz', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'WORLD' } } } }) + '\n');
  dataCb(JSON.stringify({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } }) + '\n');
  const text = await gp;
  assert.equal(text, 'HELLO WORLD');
  assert.deepEqual(chunks, ['HELLO ', 'WORLD']);
  b.dispose();
});
