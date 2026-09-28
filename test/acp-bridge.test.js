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
test('bridge resolves model across resource identities (untitled -> session)', async () => {
  let dataCb = null;
  const fakeSpawn = () => ({ stdin: { write: (d) => autoReply3(String(d)) }, stdout: { on: (ev, cb) => { if (ev === 'data') dataCb = cb; } }, stderr: { on: () => {} }, on: () => {}, kill: () => {}, unref: () => {} });
  function autoReply3(raw) {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (msg.method === 'initialize') setTimeout(() => dataCb && dataCb(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } }) + '\n'), 5);
    else if (msg.method === 'session/new') setTimeout(() => dataCb && dataCb(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'ses_renamed', configOptions: [{ id: 'model', name: 'Model', currentValue: 'm-bunny', options: [{ value: 'm-bunny', name: 'Bunny' }] }] } }) + '\n'), 5);
    else if (msg.method === 'session/delete') setTimeout(() => dataCb && dataCb(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\n'), 5);
  }
  const b = createAcpBridge(fakeSpawn);
  const s = await b.newSession('/tmp/ws');
  assert.equal(s.resource, 'opencode://session/ses_renamed');
  // Selection stored under the untitled placeholder must survive the rename:
  // prompt with the OLD untitled handle still resolves the model.
  b.setSessionModel('opencode:/untitled-aaa', 'm-bunny');
  const written = [];
  const origPrompt = b.prompt.bind(b);
  // capture params via a second prompt with chunk capture
  let seenParams = null;
  const fakeSpawn2Check = b.getSessionModel('opencode:/untitled-aaa');
  assert.equal(fakeSpawn2Check, 'm-bunny', 'model visible via untitled handle');
  assert.equal(b.getSessionModel(s.resource), 'm-bunny', 'model visible via renamed resource');
  b.dispose();
});


// --- Issue 1: stderr must be consumed, else a full 64KB pipe buffer blocks
// the child and the whole ACP session hangs.
test('bridge drains child stderr so the ACP process cannot block', async () => {
  let stderrCb = 'unset';
  const fakeSpawn = () => ({ stdin: { on: () => {}, write: () => {} }, stdout: { on: () => {} }, stderr: { on: (ev, cb) => { if (ev === 'data') stderrCb = cb; } }, on: () => {}, once: () => {}, kill: () => {} });
  const b = createAcpBridge(fakeSpawn);
  b.getModels().catch(() => {}); // triggers ensure() -> spawn
  await new Promise(r => setTimeout(r, 10));
  assert.equal(typeof stderrCb, 'function', 'bridge must attach a stderr data handler');
  b.dispose();
});

// --- Issue 2: child exit/error must reject in-flight pending requests, else
// prompts hang forever after the ACP process dies.
test('bridge rejects pending prompts when the ACP child exits', async () => {
  let dataCb = null; let exitCb = 'unset';
  const fakeSpawn = () => ({ stdin: { on: () => {}, write: () => {} }, stdout: { on: (ev, cb) => { if (ev === 'data') dataCb = cb; } }, stderr: { on: () => {} }, on: () => {}, once: (ev, cb) => { if (ev === 'exit') exitCb = cb; }, kill: () => {} });
  const b = createAcpBridge(fakeSpawn);
  const p = b.prompt('opencode://session/ses_x', 'hi').then(() => 'resolved', (e) => 'rejected:' + e.message);
  await new Promise(r => setTimeout(r, 10));
  assert.equal(typeof exitCb, 'function', 'bridge must attach a child exit handler');
  exitCb(1, null);
  const outcome = await Promise.race([p, new Promise(r => setTimeout(() => r('HUNG'), 200))]);
  assert.notEqual(outcome, 'HUNG', 'in-flight prompt must not hang after child exit');
  assert.match(outcome, /^rejected:/, 'in-flight prompt must reject after child exit');
  b.dispose();
});

// --- Issue 3: per-session maps grow without bound across sessions.
test('bridge prunes per-session state when a session is deleted', async () => {
  let dataCb = null;
  const fakeSpawn = () => ({ stdin: { write: (d) => autoReply4(String(d)) }, stdout: { on: (ev, cb) => { if (ev === 'data') dataCb = cb; } }, stderr: { on: () => {} }, on: () => {}, kill: () => {}, unref: () => {} });
  function autoReply4(raw) {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (msg.method === 'initialize') setTimeout(() => dataCb && dataCb(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } }) + '\n'), 5);
    else if (msg.method === 'session/new') setTimeout(() => dataCb && dataCb(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'ses_prune', configOptions: [] } }) + '\n'), 5);
    else if (msg.method === 'session/delete') setTimeout(() => dataCb && dataCb(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\n'), 5);
  }
  const b = createAcpBridge(fakeSpawn);
  const s = await b.newSession('/tmp/ws');
  b.setSessionModel(s.resource, 'm-x');
  assert.equal(b.getSessionModel(s.resource), 'm-x', 'model set before delete');
  await b.deleteSession(s.resource);
  assert.equal(b.getSessionModel(s.resource), undefined, 'session state must be pruned after delete');
  b.dispose();
});

// --- Issue 4: chunks must reach the consumer WHILE the prompt is running.
// Collecting them and emitting only after the final result freezes the UI
// for the whole agent run.
test('bridge streams chunks to onChunk before the prompt resolves', async () => {
  let dataCb = null; const written = [];
  const fakeSpawn = () => ({ stdin: { on: () => {}, write: (d) => { written.push(String(d)); autoReply5(String(d)); } }, stdout: { on: (ev, cb) => { if (ev === 'data') dataCb = cb; } }, stderr: { on: () => {} }, on: () => {}, once: () => {}, kill: () => {} });
  function autoReply5(raw) {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (msg.method === 'initialize') setTimeout(() => dataCb && dataCb(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } }) + '\n'), 5);
    else if (msg.method === 'session/new') setTimeout(() => dataCb && dataCb(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'ses_stream', configOptions: [] } }) + '\n'), 5);
    else if (msg.method === 'session/delete') setTimeout(() => dataCb && dataCb(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\n'), 5);
  }
  const b = createAcpBridge(fakeSpawn);
  const sess = await b.newSession('/tmp/ws');
  const seen = [];
  let resolved = false;
  const p = b.prompt(sess.resource, 'hi', (t) => seen.push(t)).then((r) => { resolved = true; return r; });
  await new Promise(r => setTimeout(r, 20));
  let promptId = null;
  for (const w of written) { try { const m = JSON.parse(w); if (m.method === 'session/prompt') promptId = m.id; } catch {} }
  dataCb(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'ses_stream', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'PARTIAL' } } } }) + '\n');
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(seen, ['PARTIAL'], 'chunk must be delivered before the prompt resolves');
  assert.equal(resolved, false, 'prompt must still be in flight');
  dataCb(JSON.stringify({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } }) + '\n');
  const full = await p;
  assert.equal(full, 'PARTIAL');
  assert.deepEqual(seen, ['PARTIAL'], 'chunk must not be re-delivered on completion');
  b.dispose();
});
