import fs from 'node:fs';
import * as path from 'node:path';
import { getChatLanguageModelsPath } from './sync-targets.js';

export function readChatLanguageModels(targetPath?: string): any[] {
  const filePath = targetPath || getChatLanguageModelsPath();
  if (!fs.existsSync(filePath)) {
    return [];
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    if (!raw.trim()) {
      return [];
    }
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err: any) {
    throw new Error(`Failed to parse ${filePath}: ${err.message}`);
  }
}

export function createBackup(filePath: string, backupContent?: string): string | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const dir = path.dirname(filePath);
  const baseName = path.basename(filePath);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-') + '-' + Math.random().toString(36).slice(2, 8);
  const backupPath = path.join(dir, `${baseName}.bak-${timestamp}`);

  if (backupContent === undefined) {
    fs.copyFileSync(filePath, backupPath);
  } else {
    const mode = fs.statSync(filePath).mode & 0o777;
    safeWriteFileSync(backupPath, backupContent, mode);
  }

  try {
    const files = fs.readdirSync(dir);
    const backups = files
      .filter((file) => file.startsWith(`${baseName}.bak-`))
      .sort()
      .reverse();

    if (backups.length > 3) {
      for (const old of backups.slice(3)) {
        try {
          fs.unlinkSync(path.join(dir, old));
        } catch {}
      }
    }
  } catch {}

  return backupPath;
}

/** Ensure the contents reach disk before a caller atomically renames the file. */
function writeFileWithFsync(filePath: string, data: string, mode: number): void {
  const fd = fs.openSync(filePath, 'w', mode);
  try {
    fs.writeSync(fd, Buffer.from(data, 'utf-8'));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function fsyncDir(dir: string): void {
  if (process.platform === 'win32') return;
  try {
    const dirFd = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  } catch {}
}

function chmodPortable(target: string, mode: number): void {
  if (process.platform === 'win32') return;
  try {
    fs.chmodSync(target, mode);
  } catch {}
}

function resolveWriteMode(filePath: string, options?: { mode?: number } | number): number {
  if (typeof options === 'number') return options;
  if (options?.mode !== undefined) return options.mode;
  // Preserve existing permissions unless the caller explicitly requests another mode.
  try {
    return fs.statSync(filePath).mode & 0o777;
  } catch {
    return 0o644;
  }
}

function atomicWrite(filePath: string, tmpPath: string, data: string, mode: number, dir: string): void {
  writeFileWithFsync(tmpPath, data, mode);
  chmodPortable(tmpPath, mode);
  fs.renameSync(tmpPath, filePath);
  chmodPortable(filePath, mode);
  fsyncDir(dir);
}

function directWriteFallback(filePath: string, tmpPath: string, data: string, mode: number): void {
  try {
    writeFileWithFsync(filePath, data, mode);
    chmodPortable(filePath, mode);
  } finally {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {}
  }
}

export function safeWriteFileSync(filePath: string, data: string, options?: { mode?: number } | number): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const mode = resolveWriteMode(filePath, options);
  const tmpPath = `${filePath}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    atomicWrite(filePath, tmpPath, data, mode, dir);
  } catch {
    directWriteFallback(filePath, tmpPath, data, mode);
  }
}
