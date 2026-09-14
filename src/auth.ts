import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as cp from 'node:child_process';
import type * as vscode from 'vscode';
import { getAllChatLanguageModelsPaths } from './syncer.js';

export const SECRET_KEY = 'opencode_api_key';

export function getStoredOpenCodeKey(customPath?: string): string | null {
  if (process.env.OPENCODE_API_KEY && process.env.OPENCODE_API_KEY.trim().length > 0) {
    return process.env.OPENCODE_API_KEY.trim();
  }

  if (customPath) {
    try {
      if (fs.existsSync(customPath)) {
        const raw = fs.readFileSync(customPath, 'utf-8');
        const data = JSON.parse(raw);
        const key = data['opencode-go']?.key || data['opencode']?.key;
        if (typeof key === 'string' && key.trim().length > 0) {
          return key.trim();
        }
      }
    } catch {}
    return null;
  }

  const candidatePaths: string[] = [];

  // 1. Primary local platform paths
  const home = os.homedir();
  candidatePaths.push(path.join(home, '.local', 'share', 'opencode', 'auth.json'));
  candidatePaths.push(path.join(home, '.config', 'opencode', 'auth.json'));

  // 2. Windows-specific local AppData / UserProfile
  if (process.env.LOCALAPPDATA) {
    candidatePaths.push(path.join(process.env.LOCALAPPDATA, 'opencode', 'auth.json'));
  }
  if (process.env.APPDATA) {
    candidatePaths.push(path.join(process.env.APPDATA, 'opencode', 'auth.json'));
  }
  if (process.env.USERPROFILE) {
    candidatePaths.push(path.join(process.env.USERPROFILE, '.local', 'share', 'opencode', 'auth.json'));
    candidatePaths.push(path.join(process.env.USERPROFILE, '.config', 'opencode', 'auth.json'));
  }

  // 3. If running on Windows, also check WSL network shares
  if (process.platform === 'win32') {
    for (const prefix of ['\\\\wsl.localhost', '\\\\wsl$']) {
      try {
        if (fs.existsSync(prefix)) {
          let distros: string[] = [];
          try {
            distros = fs.readdirSync(prefix);
          } catch {}
          for (const distro of distros) {
            const homeDir = path.join(prefix, distro, 'home');
            if (fs.existsSync(homeDir)) {
              let users: string[] = [];
              try {
                users = fs.readdirSync(homeDir);
              } catch {}
              for (const u of users) {
                candidatePaths.push(path.join(homeDir, u, '.local', 'share', 'opencode', 'auth.json'));
                candidatePaths.push(path.join(homeDir, u, '.config', 'opencode', 'auth.json'));
              }
            }
            const rootDir = path.join(prefix, distro, 'root');
            if (fs.existsSync(rootDir)) {
              candidatePaths.push(path.join(rootDir, '.local', 'share', 'opencode', 'auth.json'));
              candidatePaths.push(path.join(rootDir, '.config', 'opencode', 'auth.json'));
            }
          }
        }
      } catch {}
    }
  }

  // 4. If running inside Linux/WSL, also check Windows user directories across mounts
  if (process.platform === 'linux') {
    const userRoots = ['/mnt/c/Users', '/mnt/d/Users', '/mnt/e/Users', '/c/Users', '/d/Users'];
    for (const root of userRoots) {
      if (fs.existsSync(root)) {
        let users: string[] = [];
        try {
          users = fs.readdirSync(root);
        } catch {}
        for (const u of users) {
          if (['Public', 'Default', 'Default User', 'All Users'].includes(u) || u.startsWith('.')) continue;
          candidatePaths.push(path.join(root, u, 'AppData', 'Local', 'opencode', 'auth.json'));
          candidatePaths.push(path.join(root, u, 'AppData', 'Roaming', 'opencode', 'auth.json'));
          candidatePaths.push(path.join(root, u, '.local', 'share', 'opencode', 'auth.json'));
          candidatePaths.push(path.join(root, u, '.config', 'opencode', 'auth.json'));
        }
      }
    }
  }

  for (const authPath of candidatePaths) {
    try {
      if (fs.existsSync(authPath)) {
        const raw = fs.readFileSync(authPath, 'utf-8');
        const data = JSON.parse(raw);
        const key = data['opencode-go']?.key || data['opencode']?.key;
        if (typeof key === 'string' && key.trim().length > 0) {
          return key.trim();
        }
      }
    } catch {}
  }

  return null;
}

export function getKeyFromExistingConfig(customPath?: string): string | null {
  const pathsToCheck: string[] = [];
  if (customPath) {
    pathsToCheck.push(customPath);
  } else {
    try {
      pathsToCheck.push(...getAllChatLanguageModelsPaths());
    } catch {
      const fallback =
        process.platform === 'darwin'
          ? path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'chatLanguageModels.json')
          : process.platform === 'win32'
            ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Code', 'User', 'chatLanguageModels.json')
            : path.join(os.homedir(), '.config', 'Code', 'User', 'chatLanguageModels.json');
      pathsToCheck.push(fallback);
    }
  }

  for (const configPath of pathsToCheck) {
    try {
      if (fs.existsSync(configPath)) {
        const raw = fs.readFileSync(configPath, 'utf-8');
        const data = JSON.parse(raw);
        if (Array.isArray(data)) {
          const entry = data.find(
            (e) =>
              e &&
              (e.name === 'OpenCode' ||
                e.name === 'OpenCode Go' ||
                e.name === 'OpenCode Zen Free' ||
                /^(customprovider|custom endpoint|customendpoint)$/i.test(e.name || '') ||
                (Array.isArray(e.models) &&
                  e.models.some((m: any) => typeof m?.url === 'string' && m.url.includes('opencode.ai'))))
          );
          if (entry?.apiKey && typeof entry.apiKey === 'string' && entry.apiKey.trim().startsWith('sk-')) {
            return entry.apiKey.trim();
          }
        }
      }
    } catch {}
  }
  return null;
}

export async function resolveApiKey(
  secrets: vscode.SecretStorage,
  promptIfMissing: boolean = true,
  vscodeWindow?: typeof vscode.window
): Promise<string | undefined> {
  const stored = await secrets.get(SECRET_KEY);
  if (stored && stored.trim().length > 0) {
    return stored.trim();
  }

  const autoFound = getStoredOpenCodeKey();
  if (autoFound) {
    await secrets.store(SECRET_KEY, autoFound);
    return autoFound;
  }

  const fromExisting = getKeyFromExistingConfig();
  if (fromExisting) {
    await secrets.store(SECRET_KEY, fromExisting);
    return fromExisting;
  }

  if (promptIfMissing && vscodeWindow && !process.env.CI) {
    const entered = await vscodeWindow.showInputBox({
      title: 'OpenCode API Key',
      prompt: 'Enter your OpenCode API Key (starts with sk-)',
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) => {
        if (!value || value.trim().length === 0) {
          return 'API Key cannot be empty';
        }
        if (!value.trim().startsWith('sk-')) {
          return 'OpenCode API keys typically start with sk-';
        }
        return null;
      },
    });

    if (entered && entered.trim().length > 0) {
      const cleanKey = entered.trim();
      await secrets.store(SECRET_KEY, cleanKey);
      return cleanKey;
    }
  }

  return undefined;
}

export async function promptAndSetApiKey(
  secrets: vscode.SecretStorage,
  vscodeWindow: typeof vscode.window
): Promise<string | undefined> {
  const currentKey = await secrets.get(SECRET_KEY);
  const entered = await vscodeWindow.showInputBox({
    title: 'OpenCode API Key',
    prompt: 'Enter your OpenCode API Key (starts with sk-)',
    value: currentKey || '',
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) => {
      if (!value || value.trim().length === 0) {
        return 'API Key cannot be empty';
      }
      return null;
    },
  });

  if (entered && entered.trim().length > 0) {
    const cleanKey = entered.trim();
    await secrets.store(SECRET_KEY, cleanKey);
    return cleanKey;
  }

  return undefined;
}
