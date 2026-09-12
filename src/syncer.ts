import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { buildProviderEntry, mergeChatLanguageModels, type ProviderEntry } from './config.js';
import { enrichModel } from './enricher.js';
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

export function isWSL(): boolean {
  if (process.platform !== 'linux') return false;
  if (process.env.WSL_DISTRO_NAME) return true;
  try {
    const v = fs.readFileSync('/proc/version', 'utf-8');
    return v.toLowerCase().includes('microsoft') || v.toLowerCase().includes('wsl');
  } catch {
    return false;
  }
}

export function getAllChatLanguageModelsPaths(): string[] {
  const paths: string[] = [getChatLanguageModelsPath()];

  if (isWSL()) {
    try {
      const mntCUsers = '/mnt/c/Users';
      if (fs.existsSync(mntCUsers)) {
        for (const user of fs.readdirSync(mntCUsers)) {
          if (['Public', 'Default', 'Default User', 'All Users'].includes(user) || user.startsWith('.')) continue;
          const winPath = path.join(mntCUsers, user, 'AppData', 'Roaming', 'Code', 'User', 'chatLanguageModels.json');
          if (fs.existsSync(path.dirname(winPath)) && !paths.includes(winPath)) {
            paths.push(winPath);
          }
        }
      }
    } catch {}
  }

  return paths;
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
  const filePaths = targetPath ? [targetPath] : getAllChatLanguageModelsPaths();
  let primaryBackup: string | null = null;

  for (const filePath of filePaths) {
    try {
      const existingConfig = readChatLanguageModels(filePath);
      const mergedConfig = mergeChatLanguageModels(existingConfig, providers);

      const backupPath = createBackup(filePath);
      if (!primaryBackup) {
        primaryBackup = backupPath;
      }

      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      fs.writeFileSync(filePath, JSON.stringify(mergedConfig, null, 4), 'utf-8');
    } catch (err: any) {
      console.error(`Failed writing to ${filePath}: ${err.message}`);
    }
  }

  return { targetPath: filePaths[0], backupPath: primaryBackup };
}

export async function syncOpenCodeModels(
  apiKey: string,
  options: { includeGo?: boolean; includeZen?: boolean; targetPath?: string } = {}
): Promise<{ goCount: number; zenCount: number; totalCount: number; targetPath: string; backupPath: string | null }> {
  const includeGo = options.includeGo ?? true;
  const includeZen = options.includeZen ?? true;

  let goModelIds: string[] = [];
  let zenModelIds: string[] = [];

  // 1. Fetch OpenCode Go catalog
  if (includeGo) {
    try {
      goModelIds = await fetchOpenCodeModels(apiKey, 'go');
    } catch (err: any) {
      console.error(`Failed to fetch Go models: ${err.message}`);
    }
  }

  // 2. Fetch OpenCode Zen catalog
  if (includeZen) {
    try {
      zenModelIds = await fetchOpenCodeModels(apiKey, 'zen');
    } catch (err: any) {
      console.error(`Failed to fetch Zen models: ${err.message}`);
    }
  }

  const goSet = new Set(goModelIds);
  const models = [];

  // Go models first (flat subscription rate)
  for (const id of goModelIds) {
    models.push(enrichModel(id, { isGo: true }));
  }

  // Zen models that are NOT in Go (Free tier + proprietary models like Claude/GPT)
  let zenCount = 0;
  for (const id of zenModelIds) {
    if (!goSet.has(id)) {
      const isFree = filterFreeModels([id]).length > 0;
      models.push(enrichModel(id, { isGo: false, isFree }));
      zenCount++;
    }
  }

  const unifiedProvider: ProviderEntry = {
    name: 'OpenCode',
    vendor: 'customendpoint',
    apiKey,
    apiType: 'chat-completions',
    models,
  };

  const { targetPath, backupPath } = writeProvidersToConfig([unifiedProvider], options.targetPath);

  return {
    goCount: goModelIds.length,
    zenCount,
    totalCount: models.length,
    targetPath,
    backupPath,
  };
}
