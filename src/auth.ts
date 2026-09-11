import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type * as vscode from 'vscode';

export const SECRET_KEY = 'opencode_api_key';

export function getStoredOpenCodeKey(customPath?: string): string | null {
  const authPath = customPath || path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json');
  try {
    if (!fs.existsSync(authPath)) {
      return null;
    }
    const raw = fs.readFileSync(authPath, 'utf-8');
    const data = JSON.parse(raw);
    const key = data['opencode-go']?.key || data['opencode']?.key;
    if (typeof key === 'string' && key.trim().length > 0) {
      return key.trim();
    }
  } catch {
    // Ignore read/parse errors
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

  if (promptIfMissing && vscodeWindow) {
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
