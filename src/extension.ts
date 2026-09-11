import * as vscode from 'vscode';
import { resolveApiKey, promptAndSetApiKey } from './auth.js';
import { syncOpenCodeModels } from './syncer.js';

export async function activate(context: vscode.ExtensionContext) {
  const outputChannel = vscode.window.createOutputChannel('OpenCode Copilot Sync');
  context.subscriptions.push(outputChannel);

  async function performSync(interactive: boolean) {
    try {
      const apiKey = await resolveApiKey(context.secrets, interactive, vscode.window);
      if (!apiKey) {
        if (interactive) {
          vscode.window.showWarningMessage('OpenCode sync cancelled: No API key provided.');
        }
        return;
      }

      if (interactive) {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'OpenCode: Fetching models and syncing to Copilot...',
            cancellable: false,
          },
          async () => {
            const result = await syncOpenCodeModels(apiKey, { isGo: true });
            outputChannel.appendLine(`Synced ${result.syncedCount} models to ${result.targetPath}`);
            vscode.window
              .showInformationMessage(
                `Synced ${result.syncedCount} OpenCode Go models to Copilot!`,
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
        const result = await syncOpenCodeModels(apiKey, { isGo: true });
        outputChannel.appendLine(`[Startup] Synced ${result.syncedCount} models to ${result.targetPath}`);
      }
    } catch (err: any) {
      outputChannel.appendLine(`Sync error: ${err.message}`);
      if (interactive) {
        vscode.window.showErrorMessage(`OpenCode sync failed: ${err.message}`);
      }
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
    })
  );

  // Background sync on startup / reload (delayed slightly to avoid startup contention)
  setTimeout(() => {
    performSync(false);
  }, 1000);
}

export function deactivate() {}
