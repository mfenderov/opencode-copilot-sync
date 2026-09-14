import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as cp from 'node:child_process';
import { buildProviderEntry, mergeChatLanguageModels, purgeOpenCodeFromChatLanguageModels, type ProviderEntry } from './config.js';
import { enrichModel } from './enricher.js';
import { fetchOpenCodeModels, filterFreeModels, filterAvailableGoModels, checkZenBalance, KNOWN_UNAVAILABLE_MODELS } from './fetcher.js';

export function getChatLanguageModelsPath(activeExtensionStoragePath?: string): string {
  if (activeExtensionStoragePath) {
    try {
      const derived = path.resolve(activeExtensionStoragePath, '..', '..', 'chatLanguageModels.json');
      if (
        fs.existsSync(path.dirname(derived)) ||
        activeExtensionStoragePath.includes('.vscode-server') ||
        activeExtensionStoragePath.includes('Code')
      ) {
        return derived;
      }
    } catch {}
  }

  const platform = process.platform;
  if (platform === 'darwin') {
    const insiders = path.join(os.homedir(), 'Library', 'Application Support', 'Code - Insiders', 'User', 'chatLanguageModels.json');
    if (fs.existsSync(path.dirname(insiders)) && !fs.existsSync(path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User'))) {
      return insiders;
    }
    return path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'chatLanguageModels.json');
  }
  if (platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'Code', 'User', 'chatLanguageModels.json');
  }

  // Linux / WSL: check if VS Code Server data directory exists
  const serverDir = path.join(os.homedir(), '.vscode-server');
  const serverPath = path.join(serverDir, 'data', 'User', 'chatLanguageModels.json');
  if (fs.existsSync(serverDir) || fs.existsSync(path.dirname(serverPath))) {
    return serverPath;
  }
  const serverInsidersDir = path.join(os.homedir(), '.vscode-server-insiders');
  const serverInsidersPath = path.join(serverInsidersDir, 'data', 'User', 'chatLanguageModels.json');
  if (fs.existsSync(serverInsidersDir) || fs.existsSync(path.dirname(serverInsidersPath))) {
    return serverInsidersPath;
  }

  // If in WSL, default to .vscode-server even if not yet created on disk
  if (isWSL()) {
    return serverPath;
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
  if (process.platform !== 'win32') {
    // If running inside WSL, mirror back to Windows host AppData
    if (isWSL()) {
      try {
        const potentialUserRoots = [
          '/mnt/c/Users',
          '/mnt/d/Users',
          '/mnt/e/Users',
          '/c/Users',
          '/d/Users',
        ];
        for (const mntUsers of potentialUserRoots) {
          if (fs.existsSync(mntUsers)) {
            let userDirs: string[] = [];
            try {
              userDirs = fs.readdirSync(mntUsers);
            } catch {}
            for (const user of userDirs) {
              if (['Public', 'Default', 'Default User', 'All Users'].includes(user) || user.startsWith('.')) continue;
              for (const variant of ['Code', 'Code - Insiders']) {
                const winDest = path.join(mntUsers, user, 'AppData', 'Roaming', variant, 'User', 'chatLanguageModels.json');
                const winDir = path.dirname(winDest);
                if (!fs.existsSync(winDir)) {
                  fs.mkdirSync(winDir, { recursive: true });
                }
                fs.copyFileSync(sourceFilePath, winDest);
              }
            }
          }
        }
      } catch {}
    }
    return;
  }

  try {
    const driveMatch = sourceFilePath.match(/^([A-Za-z]):\\(.*)$/);
    if (!driveMatch) return;

    const driveLetter = driveMatch[1].toLowerCase();
    const rest = driveMatch[2].replace(/\\/g, '/');
    const wslSourcePath = `/mnt/${driveLetter}/${rest}`;

    const subDirs = [
      '.vscode-server/data/User',
      '.vscode-server/data/Machine',
      '.vscode-server-insiders/data/User',
      '.vscode-server-insiders/data/Machine',
      '.config/Code/User',
      '.config/Code - Insiders/User',
    ];
    const mkdirCommands = subDirs.map((d) => `mkdir -p ~/"${d}"`).join(' && ');
    const cpCommands = subDirs.map((d) => `cp "${wslSourcePath}" ~/"${d}/chatLanguageModels.json"`).join(' && ');
    const fullCmd = `${mkdirCommands} && ${cpCommands}`;

    // 1. Enumerate all installed WSL distributions via wsl.exe -l -q
    try {
      cp.exec('wsl.exe -l -q', { encoding: 'buffer', timeout: 5000 }, (err, stdout) => {
        const distros: string[] = [];
        if (!err && stdout) {
          // wsl.exe -l -q outputs UTF-16LE or UTF-8
          const text = stdout.toString('utf16le').includes('\0')
            ? stdout.toString('utf8')
            : stdout.toString('utf16le');
          const clean = text
            .replace(/\0/g, '')
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter((s) => s.length > 0 && !s.includes('Windows Subsystem') && !s.startsWith('-'));
          for (const d of clean) {
            if (!distros.includes(d)) distros.push(d);
          }
        }

        // If distros found, mirror to each specific distro
        if (distros.length > 0) {
          for (const distro of distros) {
            cp.exec(`wsl.exe -d "${distro}" -e bash -c "${fullCmd}"`, () => {});
          }
        }
        // Always also run against default distro as fallback
        cp.exec(`wsl.exe -e bash -c "${fullCmd}"`, () => {});
      });
    } catch {
      // Fallback: run on default distro
      cp.exec(`wsl.exe -e bash -c "${fullCmd}"`, () => {});
    }
  } catch {}
}

export function getAllChatLanguageModelsPaths(activeExtensionStoragePath?: string): string[] {
  const paths: string[] = [];
  const primary = getChatLanguageModelsPath(activeExtensionStoragePath);
  paths.push(primary);

  // macOS: include both Code and Code - Insiders
  if (process.platform === 'darwin') {
    const macCandidates = [
      path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'chatLanguageModels.json'),
      path.join(os.homedir(), 'Library', 'Application Support', 'Code - Insiders', 'User', 'chatLanguageModels.json'),
    ];
    for (const mc of macCandidates) {
      if (!paths.includes(mc)) {
        paths.push(mc);
      }
    }
  }

  // Linux / WSL: unconditionally include all possible server (User + Machine) and client locations
  if (process.platform === 'linux') {
    const serverCandidates = [
      path.join(os.homedir(), '.vscode-server', 'data', 'User', 'chatLanguageModels.json'),
      path.join(os.homedir(), '.vscode-server', 'data', 'Machine', 'chatLanguageModels.json'),
      path.join(os.homedir(), '.vscode-server-insiders', 'data', 'User', 'chatLanguageModels.json'),
      path.join(os.homedir(), '.vscode-server-insiders', 'data', 'Machine', 'chatLanguageModels.json'),
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
      const potentialUserRoots = [
        '/mnt/c/Users',
        '/mnt/d/Users',
        '/mnt/e/Users',
        '/c/Users',
        '/d/Users',
      ];
      for (const mntUsers of potentialUserRoots) {
        if (fs.existsSync(mntUsers)) {
          let userDirs: string[] = [];
          try {
            userDirs = fs.readdirSync(mntUsers);
          } catch {}
          for (const user of userDirs) {
            if (['Public', 'Default', 'Default User', 'All Users'].includes(user) || user.startsWith('.')) continue;
            for (const variant of ['Code', 'Code - Insiders']) {
              const winPath = path.join(mntUsers, user, 'AppData', 'Roaming', variant, 'User', 'chatLanguageModels.json');
              if (!paths.includes(winPath)) {
                paths.push(winPath);
              }
            }
          }
        }
      }
    } catch {}
  }

  // Windows host checking local AppData variants and WSL network shares
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    const winVariants = [
      path.join(appData, 'Code', 'User', 'chatLanguageModels.json'),
      path.join(appData, 'Code - Insiders', 'User', 'chatLanguageModels.json'),
    ];
    for (const wv of winVariants) {
      if (!paths.includes(wv)) {
        paths.push(wv);
      }
    }

    for (const prefix of ['\\\\wsl.localhost', '\\\\wsl$']) {
      try {
        if (fs.existsSync(prefix)) {
          let distros: string[] = [];
          try {
            distros = fs.readdirSync(prefix);
          } catch {}
          for (const distro of distros) {
            const userHomes: string[] = [];
            const home = path.join(prefix, distro, 'home');
            if (fs.existsSync(home)) {
              try {
                for (const u of fs.readdirSync(home)) {
                  userHomes.push(path.join(home, u));
                }
              } catch {}
            }
            const rootHome = path.join(prefix, distro, 'root');
            if (fs.existsSync(rootHome)) {
              userHomes.push(rootHome);
            }

            for (const h of userHomes) {
              const wslPaths = [
                path.join(h, '.vscode-server', 'data', 'User', 'chatLanguageModels.json'),
                path.join(h, '.vscode-server', 'data', 'Machine', 'chatLanguageModels.json'),
                path.join(h, '.vscode-server-insiders', 'data', 'User', 'chatLanguageModels.json'),
                path.join(h, '.vscode-server-insiders', 'data', 'Machine', 'chatLanguageModels.json'),
                path.join(h, '.config', 'Code', 'User', 'chatLanguageModels.json'),
                path.join(h, '.config', 'Code - Insiders', 'User', 'chatLanguageModels.json'),
              ];
              for (const wp of wslPaths) {
                if (!paths.includes(wp)) {
                  paths.push(wp);
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

export function safeWriteFileSync(filePath: string, data: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpPath = `${filePath}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    fs.writeFileSync(tmpPath, data, 'utf-8');
    fs.renameSync(tmpPath, filePath);
  } catch {
    try {
      fs.writeFileSync(filePath, data, 'utf-8');
    } finally {
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch {}
    }
  }
}

export function cleanupLegacyOpenCodeCustomEndpoints(storagePath?: string): string[] {
  const filePaths = getAllChatLanguageModelsPaths(storagePath);
  const cleaned: string[] = [];

  for (const filePath of filePaths) {
    try {
      if (!fs.existsSync(filePath)) continue;
      const existing = readChatLanguageModels(filePath);
      const purged = purgeOpenCodeFromChatLanguageModels(existing);
      if (purged.length !== existing.length) {
        createBackup(filePath);
        safeWriteFileSync(filePath, JSON.stringify(purged, null, 4));
        cleaned.push(filePath);
      }
    } catch (err: any) {
      console.error(`Failed cleaning legacy customendpoints in ${filePath}: ${err.message}`);
    }
  }

  return cleaned;
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

      safeWriteFileSync(filePath, JSON.stringify(mergedConfig, null, 4));
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
): Promise<{ goCount: number; zenCount: number; totalCount: number; models: any[]; targetPath: string; backupPath: string | null }> {
  const includeGo = options.includeGo ?? true;
  const includeZen = options.includeZen ?? true;

  let goModelIds: string[] = [];
  let zenModelIds: string[] = [];

  // 1. Fetch OpenCode Go catalog (pull ALL models from Go)
  if (includeGo) {
    try {
      const rawGoIds = await fetchOpenCodeModels(apiKey, 'go');
      goModelIds = rawGoIds.filter(Boolean);
    } catch (err: any) {
      console.error(`Failed to fetch Go models: ${err.message}`);
    }
  }

  // 2. Fetch OpenCode Zen catalog (pull ALL models from Zen)
  if (includeZen) {
    try {
      const rawZenIds = await fetchOpenCodeModels(apiKey, 'zen');
      zenModelIds = rawZenIds.filter(Boolean);
    } catch (err: any) {
      console.error(`Failed to fetch Zen models: ${err.message}`);
    }
  }

  const goSet = new Set(goModelIds);
  const models = [];

  // Go models first (flat subscription rate) -> (OpenCode Go)
  for (const id of goModelIds) {
    models.push(enrichModel(id, { isGo: true, suffix: '(OpenCode Go)' }));
  }

  // Zen models that are NOT in Go -> (OpenCode Free) or (OpenCode Zen)
  let zenCount = 0;
  for (const id of zenModelIds) {
    if (!goSet.has(id)) {
      const isFree = filterFreeModels([id]).length > 0;
      const suffix = isFree ? '(OpenCode Free)' : '(OpenCode Zen)';
      models.push(enrichModel(id, { isGo: false, isFree, suffix }));
      zenCount++;
    }
  }

  if (models.length === 0) {
    throw new Error('No models were fetched from OpenCode API. Preserving existing configuration to prevent accidental erasure.');
  }

  let targetPath = options.targetPath || getChatLanguageModelsPath(options.storagePath);
  let backupPath: string | null = null;

  if (options.targetPath) {
    // Explicit target path provided (e.g. in unit tests)
    const unifiedProvider: ProviderEntry = {
      name: 'OpenCode',
      vendor: 'customendpoint',
      apiKey,
      apiType: 'chat-completions',
      models,
    };
    const res = writeProvidersToConfig([unifiedProvider], options.targetPath, options.storagePath);
    targetPath = res.targetPath;
    backupPath = res.backupPath;
  } else {
    // Clean up any legacy customendpoint entries across all VS Code paths so Copilot uses native provider
    const cleaned = cleanupLegacyOpenCodeCustomEndpoints(options.storagePath);
    if (cleaned.length > 0) {
      backupPath = createBackup(cleaned[0]);
    }
  }

  return {
    goCount: goModelIds.length,
    zenCount,
    totalCount: models.length,
    models,
    targetPath,
    backupPath,
  };
}
