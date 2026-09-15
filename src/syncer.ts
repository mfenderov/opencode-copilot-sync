import fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as cp from 'node:child_process';
import { mergeChatLanguageModels, purgeOpenCodeFromChatLanguageModels, type ProviderEntry } from './config.js';
import { enrichModel } from './enricher.js';
import { fetchOpenCodeModels, fetchModelsDevMetadata, filterFreeModels } from './fetcher.js';

export function getChatLanguageModelsPath(activeExtensionStoragePath?: string): string {
  if (activeExtensionStoragePath) {
    // context.globalStorageUri is authoritative: VS Code hands us the real path for
    // the *actual running instance* (portable installs, VSCodium, custom
    // --user-data-dir, Insiders, Remote-SSH/WSL server folders all resolve correctly
    // here), so prefer it unconditionally rather than gating on brittle substring/
    // existsSync heuristics that can silently fall through to the wrong hardcoded
    // guess on a fresh install where the directory doesn't exist yet.
    try {
      return path.resolve(activeExtensionStoragePath, '..', '..', 'chatLanguageModels.json');
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

        // Mirror across sibling distros mounted under /mnt/wsl/instances or /mnt/wsl
        const potentialDistroRoots = ['/mnt/wsl/instances', '/mnt/wsl'];
        for (const distroRoot of potentialDistroRoots) {
          if (fs.existsSync(distroRoot)) {
            let distros: string[] = [];
            try {
              distros = fs.readdirSync(distroRoot);
            } catch {}
            for (const distro of distros) {
              if (distro.startsWith('.') || distro === 'resolv.conf' || distro === 'wslg' || distro === 'instances') continue;
              const distroHome = path.join(distroRoot, distro, 'home');
              const userHomes: string[] = [];
              if (fs.existsSync(distroHome)) {
                try {
                  for (const u of fs.readdirSync(distroHome)) {
                    userHomes.push(path.join(distroHome, u));
                  }
                } catch {}
              }
              const rootHome = path.join(distroRoot, distro, 'root');
              if (fs.existsSync(rootHome)) {
                userHomes.push(rootHome);
              }
              for (const h of userHomes) {
                const targetSubDirs = [
                  '.vscode-server/data/User',
                  '.vscode-server/data/Machine',
                  '.vscode-server-insiders/data/User',
                  '.vscode-server-insiders/data/Machine',
                  '.config/Code/User',
                  '.config/Code - Insiders/User',
                ];
                for (const sub of targetSubDirs) {
                  const target = path.join(h, sub, 'chatLanguageModels.json');
                  const targetDir = path.dirname(target);
                  if (!fs.existsSync(targetDir)) {
                    fs.mkdirSync(targetDir, { recursive: true });
                  }
                  fs.copyFileSync(sourceFilePath, target);
                }
              }
            }
          }
        }
      } catch {}
    }
    return;
  }

  // Windows host: mirror directly to WSL
  try {
    if (!fs.existsSync(sourceFilePath)) return;
    const fileContent = fs.readFileSync(sourceFilePath, 'utf-8');

    // 1. Enumerate all installed WSL distributions via wsl.exe -l -q
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

      const candidateDistros = distros.length > 0 ? distros : ['Ubuntu', 'Debian', 'docker-desktop'];
      const subDirs = [
        '.vscode-server\\data\\User',
        '.vscode-server\\data\\Machine',
        '.vscode-server-insiders\\data\\User',
        '.vscode-server-insiders\\data\\Machine',
        '.config\\Code\\User',
        '.config\\Code - Insiders\\User',
      ];

      // Strategy A: Direct UNC filesystem write (no shell escaping, space-safe)
      for (const d of candidateDistros) {
        for (const prefix of [`\\\\wsl.localhost\\${d}`, `\\\\wsl$\\${d}`]) {
          try {
            if (!fs.existsSync(prefix)) continue;
            const userHomes: string[] = [];
            const homeDir = path.join(prefix, 'home');
            if (fs.existsSync(homeDir)) {
              try {
                for (const u of fs.readdirSync(homeDir)) {
                  userHomes.push(path.join(homeDir, u));
                }
              } catch {}
            }
            const rootDir = path.join(prefix, 'root');
            if (fs.existsSync(rootDir)) {
              userHomes.push(rootDir);
            }

            for (const h of userHomes) {
              for (const sub of subDirs) {
                try {
                  const target = path.join(h, sub, 'chatLanguageModels.json');
                  const targetDir = path.dirname(target);
                  if (!fs.existsSync(targetDir)) {
                    fs.mkdirSync(targetDir, { recursive: true });
                  }
                  fs.writeFileSync(target, fileContent, 'utf-8');
                } catch {}
              }
            }
          } catch {}
        }
      }

      // Strategy B: Safe stdin streaming via wsl.exe execFile (no command line quote escaping)
      const targetScript =
        'mkdir -p ~/.vscode-server/data/User ~/.vscode-server/data/Machine ~/.vscode-server-insiders/data/User && cat > ~/.vscode-server/data/User/chatLanguageModels.json';
      for (const d of distros) {
        try {
          const child = cp.execFile('wsl.exe', ['-d', d, 'sh', '-c', targetScript], { timeout: 8000 });
          child.stdin?.write(fileContent);
          child.stdin?.end();
        } catch {}
      }
      try {
        const defaultChild = cp.execFile('wsl.exe', ['sh', '-c', targetScript], { timeout: 8000 });
        defaultChild.stdin?.write(fileContent);
        defaultChild.stdin?.end();
      } catch {}
    });
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

      // Discover sibling distro config paths under /mnt/wsl/instances or /mnt/wsl
      const potentialDistroRoots = ['/mnt/wsl/instances', '/mnt/wsl'];
      for (const distroRoot of potentialDistroRoots) {
        if (fs.existsSync(distroRoot)) {
          let distros: string[] = [];
          try {
            distros = fs.readdirSync(distroRoot);
          } catch {}
          for (const distro of distros) {
            if (distro.startsWith('.') || distro === 'resolv.conf' || distro === 'wslg' || distro === 'instances') continue;
            const distroHome = path.join(distroRoot, distro, 'home');
            const userHomes: string[] = [];
            if (fs.existsSync(distroHome)) {
              try {
                for (const u of fs.readdirSync(distroHome)) {
                  userHomes.push(path.join(distroHome, u));
                }
              } catch {}
            }
            const rootHome = path.join(distroRoot, distro, 'root');
            if (fs.existsSync(rootHome)) {
              userHomes.push(rootHome);
            }
            for (const h of userHomes) {
              const distroPaths = [
                path.join(h, '.vscode-server', 'data', 'User', 'chatLanguageModels.json'),
                path.join(h, '.vscode-server', 'data', 'Machine', 'chatLanguageModels.json'),
                path.join(h, '.vscode-server-insiders', 'data', 'User', 'chatLanguageModels.json'),
                path.join(h, '.vscode-server-insiders', 'data', 'Machine', 'chatLanguageModels.json'),
                path.join(h, '.config', 'Code', 'User', 'chatLanguageModels.json'),
                path.join(h, '.config', 'Code - Insiders', 'User', 'chatLanguageModels.json'),
              ];
              for (const dp of distroPaths) {
                if (!paths.includes(dp)) {
                  paths.push(dp);
                }
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
        let distros: string[] = [];
        try {
          distros = fs.readdirSync(prefix);
        } catch {}
        if (distros.length === 0) {
          distros = ['Ubuntu', 'Debian', 'docker-desktop'];
        }
        for (const distro of distros) {
          const userHomes: string[] = [];
          const home = path.join(prefix, distro, 'home');
          try {
            if (fs.existsSync(home)) {
              for (const u of fs.readdirSync(home)) {
                userHomes.push(path.join(home, u));
              }
            }
          } catch {}
          const rootHome = path.join(prefix, distro, 'root');
          try {
            if (fs.existsSync(rootHome)) {
              userHomes.push(rootHome);
            }
          } catch {}

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
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-') + '-' + Math.random().toString(36).slice(2, 8);
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

/** Opens `path` for writing, writes `data`, fsyncs the fd, then closes it — giving
 * durability against a crash/power-loss between the write and the OS actually
 * persisting it, which a plain writeFileSync does not guarantee. */
function writeFileWithFsync(filePath: string, data: string, mode: number): void {
  const fd = fs.openSync(filePath, 'w', mode);
  try {
    fs.writeSync(fd, Buffer.from(data, 'utf-8'));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Best-effort fsync of a directory so a preceding renameSync into it is durable.
 * Directory fsync is a POSIX-only concept; Windows can't open a directory handle
 * for this, so it's skipped there. */
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

export function safeWriteFileSync(filePath: string, data: string, options?: { mode?: number } | number): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Preserve the existing file's permission bits by default instead of always
  // resetting to 0o644, so a rewrite doesn't silently loosen/tighten perms an
  // administrator or the user deliberately set. Callers can still override via
  // an explicit mode.
  let mode = typeof options === 'number' ? options : options?.mode;
  if (mode === undefined) {
    try {
      mode = fs.statSync(filePath).mode & 0o777;
    } catch {
      mode = 0o644;
    }
  }

  const tmpPath = `${filePath}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    writeFileWithFsync(tmpPath, data, mode);
    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(tmpPath, mode);
      } catch {}
    }
    fs.renameSync(tmpPath, filePath);
    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(filePath, mode);
      } catch {}
    }
    fsyncDir(dir);
  } catch {
    try {
      writeFileWithFsync(filePath, data, mode);
      if (process.platform !== 'win32') {
        try {
          fs.chmodSync(filePath, mode);
        } catch {}
      }
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
      const readRaw = (): string => {
        try {
          return fs.readFileSync(filePath, 'utf-8');
        } catch {
          return '';
        }
      };

      // Optimistic concurrency: another VS Code window/instance (or `code --sync`)
      // could write this same file between our read and our write. Re-read
      // immediately before writing and, if the on-disk content changed underneath
      // us, redo the merge against the newer content once instead of silently
      // clobbering the other writer's changes.
      const beforeRaw = readRaw();
      let existingConfig = readChatLanguageModels(filePath);
      let mergedConfig = mergeChatLanguageModels(existingConfig, providers);

      if (readRaw() !== beforeRaw) {
        existingConfig = readChatLanguageModels(filePath);
        mergedConfig = mergeChatLanguageModels(existingConfig, providers);
      }

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

  // 0. Fetch live model metadata from models.dev for dynamic limits and capabilities
  let modelsDevMap: Record<string, any> = {};
  try {
    modelsDevMap = await fetchModelsDevMetadata();
  } catch {}

  const goSet = new Set(goModelIds);
  const models = [];

  // Go models first (flat subscription rate) -> (OpenCode Go)
  for (const id of goModelIds) {
    const devData = modelsDevMap[id] || modelsDevMap[id.replace(/-contributor$/, '')] || modelsDevMap[id.replace(/-free$/, '')];
    models.push(enrichModel(id, { isGo: true, suffix: '(OpenCode Go)', modelsDevData: devData }));
  }

  // Zen models that are NOT in Go -> (OpenCode Free) or (OpenCode Zen)
  let zenCount = 0;
  for (const id of zenModelIds) {
    if (!goSet.has(id)) {
      const isFree = filterFreeModels([id]).length > 0;
      const suffix = isFree ? '(OpenCode Free)' : '(OpenCode Zen)';
      const devData = modelsDevMap[id] || modelsDevMap[id.replace(/-contributor-free$/, '')] || modelsDevMap[id.replace(/-free$/, '')];
      models.push(enrichModel(id, { isGo: false, isFree, suffix, modelsDevData: devData }));
      zenCount++;
    }
  }

  if (models.length === 0) {
    throw new Error('No models were fetched from OpenCode API. Preserving existing configuration to prevent accidental erasure.');
  }

  let targetPath = options.targetPath || getChatLanguageModelsPath(options.storagePath);
  let backupPath: string | null = null;

  // Write unified OpenCode provider with multi-transport models to chatLanguageModels.json
  // This guarantees models appear instantly in Remote-WSL, Windows, and macOS without requiring remote extension install.
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

  return {
    goCount: goModelIds.length,
    zenCount,
    totalCount: models.length,
    models,
    targetPath,
    backupPath,
  };
}
