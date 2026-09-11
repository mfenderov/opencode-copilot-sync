import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { buildProviderEntry, mergeChatLanguageModels } from './config.js';
import { fetchOpenCodeModels } from './fetcher.js';

export function getChatLanguageModelsPath(): string {
  const platform = process.platform;
  if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'chatLanguageModels.json');
  }
  if (platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'Code', 'User', 'chatLanguageModels.json');
  }
  return path.join(os.homedir(), '.config', 'Code', 'User', 'chatLanguageModels.json');
}

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

export function createBackup(filePath: string): string | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const dir = path.dirname(filePath);
  const baseName = path.basename(filePath);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(dir, `${baseName}.bak-${timestamp}`);

  fs.copyFileSync(filePath, backupPath);

  // Keep latest 3 backups, delete older ones
  try {
    const files = fs.readdirSync(dir);
    const backups = files
      .filter((f) => f.startsWith(`${baseName}.bak-`))
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

export function syncOpenCodeModelsToConfig(
  apiKey: string,
  modelIds: string[],
  options: { isGo?: boolean; targetPath?: string } = {}
): { syncedCount: number; targetPath: string; backupPath: string | null } {
  const isGo = options.isGo ?? true;
  const targetPath = options.targetPath || getChatLanguageModelsPath();

  const providerName = isGo ? 'OpenCode Go' : 'OpenCode Zen';
  const newProvider = buildProviderEntry(providerName, apiKey, modelIds, isGo);

  const existingConfig = readChatLanguageModels(targetPath);
  const mergedConfig = mergeChatLanguageModels(existingConfig, [newProvider]);

  const backupPath = createBackup(targetPath);

  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(targetPath, JSON.stringify(mergedConfig, null, 4), 'utf-8');

  return {
    syncedCount: modelIds.length,
    targetPath,
    backupPath,
  };
}

export async function syncOpenCodeModels(
  apiKey: string,
  options: { isGo?: boolean; targetPath?: string } = {}
): Promise<{ syncedCount: number; targetPath: string; backupPath: string | null }> {
  const isGo = options.isGo ?? true;
  const modelIds = await fetchOpenCodeModels(apiKey, isGo);
  return syncOpenCodeModelsToConfig(apiKey, modelIds, options);
}
