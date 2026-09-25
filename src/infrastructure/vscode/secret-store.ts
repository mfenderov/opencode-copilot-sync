import * as vscode from 'vscode';

export const SECRET_KEY = 'opencode_api_key';

/**
 * Resolves the OpenCode API key explicitly without scanning arbitrary disk files.
 * Sources in priority order:
 * 1. VS Code SecretStorage (secure encrypted credential vault)
 * 2. Explicit process.env.OPENCODE_API_KEY (for CI or automated testing)
 * 3. User input prompt (if promptIfMissing is true and in an interactive environment)
 */
export async function resolveApiKey(
  secrets: vscode.SecretStorage,
  promptIfMissing = true,
  vscodeWindow?: typeof vscode.window
): Promise<string | undefined> {
  const stored = await secrets.get(SECRET_KEY);
  if (stored && stored.trim().length > 0) {
    return stored.trim();
  }

  const envKey = process.env.OPENCODE_API_KEY;
  if (envKey && envKey.trim().length > 0) {
    const cleanKey = envKey.trim();
    await secrets.store(SECRET_KEY, cleanKey);
    return cleanKey;
  }

  if (promptIfMissing && vscodeWindow && !process.env.CI) {
    return promptAndSetApiKey(secrets, vscodeWindow);
  }

  return undefined;
}

/**
 * Prompts the user to enter their OpenCode API key, providing helpful hints,
 * direct link button to opencode.ai, and instant validation.
 */
export async function promptAndSetApiKey(
  secrets: vscode.SecretStorage,
  vscodeWindow: typeof vscode.window
): Promise<string | undefined> {
  const currentKey = await secrets.get(SECRET_KEY);

  // If createInputBox is available, provide title bar button linking to opencode.ai
  if (typeof vscodeWindow.createInputBox === 'function') {
    return new Promise<string | undefined>((resolve) => {
      const input = vscodeWindow.createInputBox();
      input.title = 'OpenCode API Key';
      input.prompt = "Enter your OpenCode API Key (starts with sk-). Don't have one? Click the globe icon or visit opencode.ai";
      input.placeholder = 'sk-...';
      input.value = currentKey ?? '';
      input.password = true;
      input.ignoreFocusOut = true;
      input.buttons = [
        {
          iconPath: new vscode.ThemeIcon('globe'),
          tooltip: 'Get API Key at opencode.ai',
        },
      ];

      input.onDidTriggerButton(async () => {
        try {
          await vscode.env.openExternal(vscode.Uri.parse('https://opencode.ai'));
        } catch {}
      });

      input.onDidChangeValue((val) => {
        if (!val || val.trim().length === 0) {
          input.validationMessage = 'API Key cannot be empty';
        } else if (!val.trim().startsWith('sk-')) {
          input.validationMessage = 'OpenCode API keys typically start with sk-';
        } else {
          input.validationMessage = undefined;
        }
      });

      input.onDidAccept(async () => {
        const val = input.value.trim();
        if (!val) {
          input.validationMessage = 'API Key cannot be empty';
          return;
        }
        input.hide();
        await secrets.store(SECRET_KEY, val);
        input.dispose();
        resolve(val);
      });

      input.onDidHide(() => {
        input.dispose();
        resolve(undefined);
      });

      input.show();
    });
  }

  // Fallback to standard showInputBox
  const entered = await vscodeWindow.showInputBox({
    title: 'OpenCode API Key',
    prompt: "Enter your OpenCode API Key (starts with sk-). Don't have one? Get it at https://opencode.ai",
    placeHolder: 'sk-...',
    value: currentKey ?? '',
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

  return undefined;
}
