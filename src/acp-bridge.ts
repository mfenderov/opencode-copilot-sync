import { spawn as defaultSpawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
export interface AcpSession { resource: string; label: string; }
export interface AcpModelOption { value: string; name: string; }
export interface AcpConfigOption { id: string; name: string; currentValue: string; options: AcpModelOption[]; }
export interface AcpConfig { models: AcpModelOption[]; currentModel?: string; efforts: AcpModelOption[]; currentEffort?: string; modes: AcpModelOption[]; currentMode?: string; }
export type SpawnImpl = typeof defaultSpawn;
interface Pending { kind: 'init' | 'new' | 'prompt'; resolve: (v: any) => void; reject: (e: any) => void; chunks: string[]; sid: string; token?: { cancelled: boolean }; }
function parseFramed(buf: string): { msgs: any[]; rest: string } {
  const msgs: any[] = [];
  const lines = buf.split('\n');
  const rest = lines.pop() ?? '';
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    try { msgs.push(JSON.parse(t)); } catch { /* keep rest tolerant */ }
  }
  return { msgs, rest };
}
export function createAcpBridge(spawnImpl: SpawnImpl = defaultSpawn) {
  let child: ChildProcess | undefined;
  let buf = '';
  let nextId = 1;
  const pending = new Map<number, Pending>();
  const sessions = new Map<string, string>();
  const sessionModels = new Map<string, string>();
  const sessionEfforts = new Map<string, string>();
  const sessionModes = new Map<string, string>();
  let cachedModels: AcpModelOption[] | undefined;
  let cachedCurrentModel: string | undefined;
  let cachedEfforts: AcpModelOption[] | undefined;
  let cachedCurrentEffort: string | undefined;
  let cachedModes: AcpModelOption[] | undefined;
  let cachedCurrentMode: string | undefined;
  let ready: Promise<void> | undefined;
  function onData(chunk: any) {
    buf += String(chunk);
    const { msgs, rest } = parseFramed(buf);
    buf = rest;
    for (const m of msgs) route(m);
  }
  function route(m: any) {
    if (m?.id !== undefined && pending.has(Number(m.id))) {
      const p = pending.get(Number(m.id))!;
      if (m.error) { pending.delete(Number(m.id)); p.reject(new Error(m.error?.message ?? 'acp error')); return; }
      if (p.kind === 'prompt') {
        if (m.result && ('stopReason' in m.result)) { pending.delete(Number(m.id)); p.resolve({ result: m.result, chunks: p.chunks }); }
        return;
      }
      // init + session/new resolve on any result
      pending.delete(Number(m.id));
      if (m.result?.sessionId && p.sid !== '__init__') sessions.set(p.sid, m.result.sessionId);
      p.resolve({ result: m.result, chunks: p.chunks });
      return;
    }
    if (m?.method === 'session/update') {
      const sid: string | undefined = m?.params?.sessionId;
      const upd = m?.params?.update;
      const text: string | undefined = upd?.content?.type === 'text' ? upd.content.text : undefined;
      if (sid && text !== undefined) {
        for (const p of pending.values()) {
          if (p.kind === 'prompt' && p.sid === sid && !p.token?.cancelled) p.chunks.push(text);
        }
      }
    }
  }
  function send(obj: any): void {
    child?.stdin?.write(JSON.stringify(obj) + '\n');
  }
  function cacheConfig(cfg: AcpConfigOption[] | undefined): void {
    for (const c of cfg ?? []) {
      if (c.id === 'model' && c.options?.length) { cachedModels = c.options; cachedCurrentModel = c.currentValue; }
      else if (c.id === 'effort' && c.options?.length) { cachedEfforts = c.options; cachedCurrentEffort = c.currentValue; }
      else if (c.id === 'mode' && c.options?.length) { cachedModes = c.options; cachedCurrentMode = c.currentValue; }
    }
  }
  function ensure(cwd: string): ChildProcess {
    if (!child) {
      // opencode acp takes no --cwd flag (it errored 'Unrecognized flag');
      // pass cwd via spawn options instead.
      child = spawnImpl('opencode', ['acp'], { stdio: ['pipe', 'pipe', 'pipe'], cwd } as any) as ChildProcess;
      child.unref?.();
      (child.stdout as any)?.on?.('data', onData);
      ready = (async () => {
        const id = nextId++;
        const done = new Promise<void>((resolve, reject) => {
          pending.set(id, { kind: 'init', resolve: () => resolve(), reject, chunks: [], sid: '__init__' });
        });
        send({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: 1 } });
        await done;
        pending.delete(id);
        send({ jsonrpc: '2.0', method: 'notifications/initialized' });
        // Prefetch the model/effort/mode catalog: configOptions only arrive
        // with session/new, but pickers query before any session exists.
        // Create a throwaway session, harvest, delete it.
        try {
          const nid = nextId++;
          const got = await new Promise<any>((resolve, reject) => {
            pending.set(nid, { kind: 'new', resolve, reject, chunks: [], sid: '__prefetch__' });
            send({ jsonrpc: '2.0', id: nid, method: 'session/new', params: { cwd, mcpServers: [] } });
          });
          cacheConfig(got.result.configOptions);
          const psid: string | undefined = got.result.sessionId;
          if (psid) {
            const did = nextId++;
            await new Promise<any>((resolve) => {
              pending.set(did, { kind: 'new', resolve, reject: () => resolve({}), chunks: [], sid: '__prefetch__' });
              send({ jsonrpc: '2.0', id: did, method: 'session/delete', params: { sessionId: psid } });
              setTimeout(() => { pending.delete(did); resolve({}); }, 3000);
            }).catch(() => {});
          }
        } catch { /* picker falls back to per-session config */ }
      })();
    }
    return child;
  }
  return {
    async listSessions(): Promise<AcpSession[]> { return []; },
    async newSession(cwd: string): Promise<AcpSession> {
      ensure(cwd);
      await ready;
      const id = nextId++;
      const sid = randomUUID();
      const got = await new Promise<any>((resolve, reject) => {
        pending.set(id, { kind: 'new', resolve, reject, chunks: [], sid });
        send({ jsonrpc: '2.0', id, method: 'session/new', params: { cwd, mcpServers: [] } });
      });
      const acpSid: string = got.result.sessionId;
      const resource = `opencode://session/${acpSid}`;
      sessions.set(resource, acpSid);
      sessions.set(sid, acpSid);
      const cfg: AcpConfigOption[] = got.result.configOptions ?? [];
      cacheConfig(cfg);
      const modelOpt = cfg.find(c => c.id === 'model');
      if (modelOpt) sessionModels.set(resource, modelOpt.currentValue);
      const effortOpt = cfg.find(c => c.id === 'effort');
      if (effortOpt) sessionEfforts.set(resource, effortOpt.currentValue);
      const modeOpt = cfg.find(c => c.id === 'mode');
      if (modeOpt) sessionModes.set(resource, modeOpt.currentValue);
      return { resource, label: `OpenCode ${acpSid.slice(-8)}` };
    },
    async prompt(handle: string, promptText: string, onChunk?: (t: string) => void, token?: { cancelled: boolean }): Promise<string> {
      ensure(process.cwd());
      await ready;
      const acpSid = sessions.get(handle) ?? handle.split('/').pop()!;
      const id = nextId++;
      const params: any = { sessionId: acpSid, prompt: [{ type: 'text', text: promptText }] };
      const model = sessionModels.get(handle);
      if (model) params.model = model;
      const effort = sessionEfforts.get(handle);
      if (effort && effort !== 'default') params.effort = effort;
      const mode = sessionModes.get(handle);
      if (mode) params.mode = mode;
      const got = await new Promise<{ result: any; chunks: string[] }>((resolve, reject) => {
        pending.set(id, { kind: 'prompt', resolve, reject, chunks: [], sid: acpSid, token });
        send({ jsonrpc: '2.0', id, method: 'session/prompt', params });
      });
      for (const c of got.chunks) onChunk?.(c);
      return got.chunks.join('');
    },
    getSessionModel(handle: string): string | undefined {
      return sessionModels.get(handle) ?? cachedCurrentModel;
    },
    setSessionModel(handle: string, model: string): void {
      sessionModels.set(handle, model);
    },
    async getModels(): Promise<{ models: AcpModelOption[]; current: string | undefined }> {
      ensure(process.cwd());
      await ready;
      return { models: cachedModels ?? [], current: cachedCurrentModel };
    },
    async getConfig(): Promise<AcpConfig> {
      ensure(process.cwd());
      await ready;
      return {
        models: cachedModels ?? [], currentModel: cachedCurrentModel,
        efforts: cachedEfforts ?? [], currentEffort: cachedCurrentEffort,
        modes: cachedModes ?? [], currentMode: cachedCurrentMode,
      };
    },
    getSessionConfig(handle: string): { model?: string; effort?: string; mode?: string } {
      return { model: sessionModels.get(handle), effort: sessionEfforts.get(handle), mode: sessionModes.get(handle) };
    },
    setSessionConfig(handle: string, cfg: { model?: string; effort?: string; mode?: string }): void {
      if (cfg.model) sessionModels.set(handle, cfg.model);
      if (cfg.effort) sessionEfforts.set(handle, cfg.effort);
      if (cfg.mode) sessionModes.set(handle, cfg.mode);
    },
    async cancel(_handle: string): Promise<void> { return; },
    dispose(): void { try { child?.kill(); } catch { /* ignore */ } child = undefined; buf = ''; pending.clear(); ready = undefined; },
  };
}
