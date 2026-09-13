import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as cp from 'node:child_process';
import { buildProviderEntry, mergeChatLanguageModels, type ProviderEntry } from './config.js';
import { enrichModel } from './enricher.js';
import { fetchOpenCodeModels, filterFreeModels, filterAvailableGoModels, checkZenBalance } from './fetcher.js';

export function getChatLanguageModelsPath(activeExtensionStoragePath?: string): string {
  if (activeExtensionStoragePath) {
    try {
      const derived = path.resolve(activeExtensionStoragePath, '..', '..', 'chatLanguageModels.json');
      if (fs.existsSync(path.dirname(derived))) {
        return derived;
      }
    } catch {}
  }

  const platform = process.platform;
  if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'chatLanguageModels.json');
  }
  if (platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'Code', 'User', 'chatLanguageModels.json');
  }

  // Linux / WSL: check if VS Code Server data directory exists
  const serverPath = path.join(os.homedir(), '.vscode-server', 'data', 'User', 'chatLanguageModels.json');
  if (fs.existsSync(path.dirname(serverPath))) {
    return serverPath;
  }
  const serverInsidersPath = path.join(os.homedir(), '.vscode-server-insiders', 'data', 'User', 'chatLanguageModels.json');
  if (fs.existsSync(path.dirname(serverInsidersPath))) {
    return serverInsidersPath;
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

export function syncWslMirror(sourceFilePath: string): void {
  if (process.platform !== 'win32') return;

  try {
    const driveMatch = sourceFilePath.match(/^([A-Za-z]):\\(.*)$/);
    if (!driveMatch) return;

    const driveLetter = driveMatch[1].toLowerCase();
    const rest = driveMatch[2].replace(/\\/g, '/');
    const wslSourcePath = `/mnt/${driveLetter}/${rest}`;

    const cmd = `mkdir -p ~/.vscode-server/data/User ~/.config/Code/User && cp "${wslSourcePath}" ~/.vscode-server/data/User/chatLanguageModels.json && cp "${wslSourcePath}" ~/.config/Code/User/chatLanguageModels.json`;
    cp.exec(`wsl.exe -e bash -c "${cmd}"`, () => {});
  } catch {}
}

export function getAllChatLanguageModelsPaths(activeExtensionStoragePath?: string): string[] {
  const paths: string[] = [];
  const primary = getChatLanguageModelsPath(activeExtensionStoragePath);
  paths.push(primary);

  // Linux / WSL: unconditionally include all possible server and client locations
  if (process.platform === 'linux') {
    const serverCandidates = [
      path.join(os.homedir(), '.vscode-server', 'data', 'User', 'chatLanguageModels.json'),
      path.join(os.homedir(), '.vscode-server-insiders', 'data', 'User', 'chatLanguageModels.json'),
      path.join(os.homedir(), '.config', 'Code', 'User', 'chatLanguageModels.json'),
      path.join(os.homedir(), '.config', 'Code - Insiders', 'User', 'chatLanguageModels.json'),
    ];
    for (const sc of serverCandidates) {
      if (!paths.includes(sc)) {
        paths.push(sc);
      }
    }
  }

  if (isWSL()) {
    try {
      const mntCUsers = '/mnt/c/Users';
      if (fs.existsSync(mntCUsers)) {
        for (const user of fs.readdirSync(mntCUsers)) {
          if (['Public', 'Default', 'Default User', 'All Users'].includes(user) || user.startsWith('.')) continue;
          for (const variant of ['Code', 'Code - Insiders']) {
            const winPath = path.join(mntCUsers, user, 'AppData', 'Roaming', variant, 'User', 'chatLanguageModels.json');
            if (!paths.includes(winPath)) {
              paths.push(winPath);
            }
          }
        }
      }
    } catch {}
  }

  // Windows host checking WSL network shares
  if (process.platform === 'win32') {
    for (const prefix of ['\\\\wsl.localhost', '\\\\wsl$']) {
      try {
        if (fs.existsSync(prefix)) {
          for (const distro of fs.readdirSync(prefix)) {
            const home = path.join(prefix, distro, 'home');
            if (fs.existsSync(home)) {
              for (const u of fs.readdirSync(home)) {
                const wslPaths = [
                  path.join(home, u, '.vscode-server', 'data', 'User', 'chatLanguageModels.json'),
                  path.join(home, u, '.vscode-server-insiders', 'data', 'User', 'chatLanguageModels.json'),
                  path.join(home, u, '.config', 'Code', 'User', 'chatLanguageModels.json'),
                ];
                for (const wp of wslPaths) {
                  if (!paths.includes(wp)) {
                    paths.push(wp);
                  }
                }
              }
            }
          }
        }
      } catch {}
    }
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
  targetPath?: string,
  storagePath?: string
): { targetPath: string; backupPath: string | null } {
  const filePaths = targetPath ? [targetPath] : getAllChatLanguageModelsPaths(storagePath);
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

  // If on Windows, trigger automated mirror into WSL vscode-server
  if (filePaths.length > 0) {
    syncWslMirror(filePaths[0]);
  }

  return { targetPath: filePaths[0], backupPath: primaryBackup };
}

export async function syncOpenCodeModels(
  apiKey: string,
  options: { includeGo?: boolean; includeZen?: boolean; targetPath?: string; storagePath?: string } = {}
): Promise<{ goCount: number; zenCount: number; totalCount: number; targetPath: string; backupPath: string | null }> {
  const includeGo = options.includeGo ?? true;
  const includeZen = options.includeZen ?? true;

  let goModelIds: string[] = [];
  let zenModelIds: string[] = [];

  // 1. Fetch OpenCode Go catalog
  if (includeGo) {
    try {
      const rawGoIds = await fetchOpenCodeModels(apiKey, 'go');
      goModelIds = filterAvailableGoModels(rawGoIds);
    } catch (err: any) {
      console.error(`Failed to fetch Go models: ${err.message}`);
    }
  }

  // 2. Fetch OpenCode Zen catalog if user has active Zen credits
  let hasZenCredits = false;
  if (includeZen) {
    try {
      hasZenCredits = await checkZenBalance(apiKey);
      if (hasZenCredits) {
        zenModelIds = await fetchOpenCodeModels(apiKey, 'zen');
      } else {
        console.log('No active Zen credit balance detected. Skipping paid Zen catalog to avoid 401 retry timeouts.');
      }
    } catch (err: any) {
      console.error(`Failed to check/fetch Zen models: ${err.message}`);
    }
  }

  const goSet = new Set(goModelIds);
  const models = [];

  // Go models first (flat subscription rate)
  for (const id of goModelIds) {
    models.push(enrichModel(id, { isGo: true }));
  }

  // Zen models that are NOT in Go (only added if user has Zen balance)
  let zenCount = 0;
  for (const id of zenModelIds) {
    if (!goSet.has(id)) {
      const isFree = filterFreeModels([id]).length > 0;
      models.push(enrichModel(id, { isGo: false, isFree }));
      zenCount++;
    }
  }

  if (models.length === 0) {
    throw new Error('No models were fetched from OpenCode API. Preserving existing configuration to prevent accidental erasure.');
  }

  const unifiedProvider: ProviderEntry = {
    name: 'OpenCode',
    vendor: 'customendpoint',
    apiKey,
    apiType: 'chat-completions',
    models,
  };

  const { targetPath, backupPath } = writeProvidersToConfig([unifiedProvider], options.targetPath, options.storagePath);

  return {
    goCount: goModelIds.length,
    zenCount,
    totalCount: models.length,
    targetPath,
    backupPath,
  };
}
