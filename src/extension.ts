import * as vscode from 'vscode';
import { resolveApiKey, promptAndSetApiKey } from './auth.js';
import { syncOpenCodeModels, getChatLanguageModelsPath } from './syncer.js';

export async function activate(context: vscode.ExtensionContext) {
  const outputChannel = vscode.window.createOutputChannel('OpenCode Copilot Sync');
  context.subscriptions.push(outputChannel);

  // Status bar indicator & quick trigger
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  statusBarItem.text = '$(hubot) OpenCode';
  statusBarItem.tooltip = 'Click to sync OpenCode models to Copilot';
  statusBarItem.command = 'opencode-copilot-sync.sync';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  async function performSync(interactive: boolean) {
    try {
      const config = vscode.workspace.getConfiguration('opencode');
      const includeGo = config.get<boolean>('includeGoModels', true);
      const includeFree = config.get<boolean>('includeFreeModels', true);

      const apiKey = await resolveApiKey(context.secrets, interactive, vscode.window);
      if (!apiKey) {
        if (interactive) {
          vscode.window.showWarningMessage('OpenCode sync cancelled: No API key provided.');
        }
        return;
      }

      statusBarItem.text = '$(sync~spin) OpenCode';
      statusBarItem.tooltip = 'Syncing OpenCode models...';

      if (interactive) {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'OpenCode: Fetching models and syncing to Copilot...',
            cancellable: false,
          },
          async () => {
            const result = await syncOpenCodeModels(apiKey, { includeGo, includeFree });
            outputChannel.appendLine(
              `Synced ${result.goCount} Go models + ${result.freeCount} Free models to ${result.targetPath}`
            );
            vscode.window
              .showInformationMessage(
                `Synced ${result.totalCount} OpenCode models (${result.goCount} Go + ${result.freeCount} Free) to Copilot!`,
                'Open Models File'
              )
              .then((choice) => {
                if (choice === 'Open Models File') {
                  vscode.workspace.openTextDocument(result.targetPath).then((doc) => {
                    vscode.window.showTextDocument(doc);
                  });
                }
              });
          }
        );
      } else {
        // Background silent sync on startup / reload
        const result = await syncOpenCodeModels(apiKey, { includeGo, includeFree });
        outputChannel.appendLine(
          `[Startup] Synced ${result.goCount} Go models + ${result.freeCount} Free models to ${result.targetPath}`
        );
      }
    } catch (err: any) {
      outputChannel.appendLine(`Sync error: ${err.message}`);
      if (interactive) {
        vscode.window.showErrorMessage(`OpenCode sync failed: ${err.message}`);
      }
    } finally {
      statusBarItem.text = '$(hubot) OpenCode';
      statusBarItem.tooltip = 'OpenCode models synced with Copilot (click to re-sync)';
    }
  }

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('opencode-copilot-sync.sync', () => performSync(true)),
    vscode.commands.registerCommand('opencode-copilot-sync.setApiKey', async () => {
      const key = await promptAndSetApiKey(context.secrets, vscode.window);
      if (key) {
        vscode.window.showInformationMessage('OpenCode API Key updated! Syncing models now...');
        await performSync(true);
      }
    }),
    vscode.commands.registerCommand('opencode-copilot-sync.openConfig', async () => {
      const p = getChatLanguageModelsPath();
      try {
        const doc = await vscode.workspace.openTextDocument(p);
        await vscode.window.showTextDocument(doc);
      } catch (err: any) {
        vscode.window.showErrorMessage(`Unable to open config: ${err.message}`);
      }
    })
  );

  // Background sync on startup / reload if enabled
  const config = vscode.workspace.getConfiguration('opencode');
  const autoSync = config.get<boolean>('autoSyncOnStartup', true);
  if (autoSync) {
    setTimeout(() => {
      performSync(false);
    }, 1000);
  }
}

export function deactivate() {}
