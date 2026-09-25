import { spawn as defaultSpawn, ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
export interface AcpSession { resource: string; label: string; }
export type SpawnImpl = typeof defaultSpawn;
export function createAcpBridge(spawnImpl: SpawnImpl = defaultSpawn) {
  let child: ChildProcess | undefined;
  function ensure(cwd: string): ChildProcess {
    if (!child) {
      child = spawnImpl('opencode', ['acp', '--cwd', cwd], { stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcess;
      child.unref?.();
    }
    return child;
  }
  return {
    async listSessions(): Promise<AcpSession[]> { return []; },
    async newSession(cwd: string): Promise<AcpSession> {
      ensure(cwd);
      const id = randomUUID();
      return { resource: `opencode://session/${id}`, label: `OpenCode ${id.slice(0, 8)}` };
    },
    async prompt(_handle: string, _prompt: string): Promise<void> { return; },
    async cancel(_handle: string): Promise<void> { return; },
    dispose(): void { try { child?.kill(); } catch { /* ignore */ } child = undefined; },
  };
}
