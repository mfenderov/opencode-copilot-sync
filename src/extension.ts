import * as vscode from 'vscode';
import { resolveApiKey, promptAndSetApiKey } from './auth.js';
import { syncOpenCodeModels, getChatLanguageModelsPath } from './syncer.js';
import { fetchOpenCodeUsage, formatStatusBarText, formatUsageTooltip } from './usage.js';
import { OpenCodeChatProvider } from './provider.js';

export async function activate(context: vscode.ExtensionContext) {
  const outputChannel = vscode.window.createOutputChannel('OpenCode Copilot Sync');
  context.subscriptions.push(outputChannel);

  // Register first-class native Language Model Chat Provider in VS Code
  const chatProvider = new OpenCodeChatProvider(context);
  context.subscriptions.push(
    vscode.lm.registerLanguageModelChatProvider('opencode', chatProvider)
  );
  outputChannel.appendLine('Registered native OpenCode LanguageModelChatProvider with VS Code.');

  // Automatically discover and seed API key into SecretStorage if not already set
  try {
    const storedSecret = await context.secrets.get('opencode_api_key');
    if (!storedSecret) {
      const discoveredKey = await resolveApiKey(context.secrets, false);
      if (discoveredKey) {
        await context.secrets.store('opencode_api_key', discoveredKey);
        outputChannel.appendLine('Seeded OpenCode API key into SecretStorage.');
      }
    }
  } catch {}

  // Auto-enable VS Code's experimental Agent Host BYOK bridge so custom models appear in Agent Mode
  try {
    const agentHostCfg = vscode.workspace.getConfiguration('chat.agentHost');
    if (!agentHostCfg.get<boolean>('byokModels.enabled', false)) {
      await agentHostCfg.update('byokModels.enabled', true, vscode.ConfigurationTarget.Global);
      outputChannel.appendLine('Enabled chat.agentHost.byokModels.enabled for Agent Mode support.');
    }
  } catch (err: any) {
    outputChannel.appendLine(`Note: Could not set chat.agentHost.byokModels.enabled: ${err.message}`);
  }

  // Status bar indicator with Live Usage Meter & quick trigger
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  statusBarItem.text = '$(hubot) OpenCode';
  statusBarItem.tooltip = 'Click to sync OpenCode models & refresh usage';
  statusBarItem.command = 'opencode-copilot-sync.sync';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  async function updateUsageMeter(apiKey?: string) {
    try {
      const key = apiKey || (await resolveApiKey(context.secrets, false));
      if (!key) return;

      const res = await fetchOpenCodeUsage(key);
      if (res.ok) {
        statusBarItem.text = formatStatusBarText(res.usage);
        const md = new vscode.MarkdownString(formatUsageTooltip(res.usage));
        md.isTrusted = true;
        statusBarItem.tooltip = md;
      } else if (res.reason === 'no-subscription') {
        statusBarItem.text = '$(hubot) OpenCode (Zen)';
        statusBarItem.tooltip = 'OpenCode Zen (Pay-as-you-go / Free tier). Click to sync models.';
      }
    } catch {}
  }

  async function performSync(interactive: boolean) {
    try {
      const config = vscode.workspace.getConfiguration('opencode');
      const includeGo = config.get<boolean>('includeGoModels', true);
      const includeZen = config.get<boolean>('includeZenModels', true);

      const apiKey = await resolveApiKey(context.secrets, interactive, vscode.window);
      if (!apiKey) {
        if (interactive) {
          vscode.window.showWarningMessage('OpenCode sync cancelled: No API key provided.');
        } else {
          vscode.window
            .showInformationMessage(
              'OpenCode Copilot Sync: Set your API key to sync OpenCode models to Copilot.',
              'Set API Key'
            )
            .then((choice) => {
              if (choice === 'Set API Key') {
                vscode.commands.executeCommand('opencode-copilot-sync.setApiKey');
              }
            });
        }
        return;
      }

      statusBarItem.text = '$(sync~spin) OpenCode';
      statusBarItem.tooltip = 'Syncing OpenCode models...';

      const storagePath = context.globalStorageUri?.fsPath;

      if (interactive) {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'OpenCode: Fetching models and syncing to Copilot...',
            cancellable: false,
          },
          async () => {
            const result = await syncOpenCodeModels(apiKey, { includeGo, includeZen, storagePath });
            outputChannel.appendLine(
              `Synced ${result.totalCount} unified OpenCode models (${result.goCount} Go + ${result.zenCount} Zen) to ${result.targetPath}`
            );
            vscode.window
              .showInformationMessage(
                `Synced ${result.totalCount} OpenCode models (${result.goCount} Go flat-rate + ${result.zenCount} Zen exclusive) to Copilot!`,
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
        const result = await syncOpenCodeModels(apiKey, { includeGo, includeZen, storagePath });
        outputChannel.appendLine(
          `[Startup] Synced ${result.totalCount} unified OpenCode models (${result.goCount} Go + ${result.zenCount} Zen) to ${result.targetPath}`
        );
      }

      // Refresh usage meter and native model provider after successful sync
      chatProvider.refresh();
      await updateUsageMeter(apiKey);
    } catch (err: any) {
      outputChannel.appendLine(`[Sync Error] ${err.message}`);
      if (interactive) {
        vscode.window.showErrorMessage(`OpenCode sync failed: ${err.message}`);
      }
      statusBarItem.text = '$(hubot) OpenCode';
      statusBarItem.tooltip = 'OpenCode models synced with Copilot (click to re-sync)';
    }
  }

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('opencode-copilot-sync.sync', () => performSync(true)),
    vscode.commands.registerCommand('opencode-copilot-sync.refreshUsage', () => updateUsageMeter()),
    vscode.commands.registerCommand('opencode-copilot-sync.setApiKey', async () => {
      const key = await promptAndSetApiKey(context.secrets, vscode.window);
      if (key) {
        vscode.window.showInformationMessage('OpenCode API Key updated! Syncing models now...');
        await performSync(true);
      }
    }),
    vscode.commands.registerCommand('opencode-copilot-sync.openConfig', async () => {
      const p = getChatLanguageModelsPath(context.globalStorageUri?.fsPath);
      try {
        const doc = await vscode.workspace.openTextDocument(p);
        await vscode.window.showTextDocument(doc);
      } catch (err: any) {
        vscode.window.showErrorMessage(`Unable to open config: ${err.message}`);
      }
    })
  );

  // Background sync on startup / reload if enabled (waits 3s for network/bridges)
  const config = vscode.workspace.getConfiguration('opencode');
  const autoSync = config.get<boolean>('autoSyncOnStartup', true);
  if (autoSync) {
    setTimeout(() => {
      performSync(false);
    }, 3000);
  }

  // Periodic usage meter refresh (every 60 seconds)
  const usageTimer = setInterval(() => {
    updateUsageMeter();
  }, 60000);
  context.subscriptions.push({ dispose: () => clearInterval(usageTimer) });
}

export function deactivate() {}
