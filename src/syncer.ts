import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { buildProviderEntry, mergeChatLanguageModels, type ProviderEntry } from './config.js';
import { fetchOpenCodeModels, filterFreeModels } from './fetcher.js';

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

export function writeProvidersToConfig(
  providers: ProviderEntry[],
  targetPath?: string
): { targetPath: string; backupPath: string | null } {
  const filePath = targetPath || getChatLanguageModelsPath();
  const existingConfig = readChatLanguageModels(filePath);
  const mergedConfig = mergeChatLanguageModels(existingConfig, providers);

  const backupPath = createBackup(filePath);

  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(filePath, JSON.stringify(mergedConfig, null, 4), 'utf-8');

  return { targetPath: filePath, backupPath };
}

export async function syncOpenCodeModels(
  apiKey: string,
  options: { includeGo?: boolean; includeFree?: boolean; targetPath?: string } = {}
): Promise<{ goCount: number; freeCount: number; totalCount: number; targetPath: string; backupPath: string | null }> {
  const includeGo = options.includeGo ?? true;
  const includeFree = options.includeFree ?? true;
  const providers: ProviderEntry[] = [];
  let goCount = 0;
  let freeCount = 0;

  // 1. Fetch OpenCode Go catalog
  if (includeGo) {
    try {
      const goModelIds = await fetchOpenCodeModels(apiKey, 'go');
      if (goModelIds.length > 0) {
        providers.push(buildProviderEntry('OpenCode Go', apiKey, goModelIds, { isGo: true }));
        goCount = goModelIds.length;
      }
    } catch (err: any) {
      console.error(`Failed to fetch Go models: ${err.message}`);
    }
  }

  // 2. Fetch OpenCode Zen Free catalog
  if (includeFree) {
    try {
      const zenModelIds = await fetchOpenCodeModels(apiKey, 'zen');
      const freeModelIds = filterFreeModels(zenModelIds);
      if (freeModelIds.length > 0) {
        providers.push(buildProviderEntry('OpenCode Zen Free', apiKey, freeModelIds, { isGo: false, isFree: true }));
        freeCount = freeModelIds.length;
      }
    } catch (err: any) {
      console.error(`Failed to fetch Zen Free models: ${err.message}`);
    }
  }

  const { targetPath, backupPath } = writeProvidersToConfig(providers, options.targetPath);

  return {
    goCount,
    freeCount,
    totalCount: goCount + freeCount,
    targetPath,
    backupPath,
  };
}
