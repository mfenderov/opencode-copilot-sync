import * as vscode from 'vscode';
import { resolveApiKey, promptAndSetApiKey } from './infrastructure/vscode/secret-store.js';
import {
  syncOpenCodeModels,
  getModelFamily,
  getModelCatalog,
  type SyncOpenCodeOptions,
  type SyncOpenCodeResult,
} from './models/application/synchronize-models.js';
import { getChatLanguageModelsPath } from './sync-targets.js';
import { formatSyncFailureMessage, formatSyncFailureTooltip } from './sync-status.js';
import { buildSyncOptions, shouldPromptForApiKey } from './sync-options.js';
import { updateUsageMeter } from './usage/application/refresh-usage.js';
import { OpenCodeChatProvider } from './chat/infrastructure/vscode-chat-provider.js';
import { setVSCodeProxyUrl } from './infrastructure/http/proxy-routing.js';
import { OpenCodeUsageTreeProvider } from './usage/infrastructure/usage-tree-adapter.js';

export async function activate(context: vscode.ExtensionContext) {
  const outputChannel = vscode.window.createOutputChannel('OpenCode Copilot Sync');
  context.subscriptions.push(outputChannel);

  outputChannel.appendLine(
    `[Platform] OS: ${process.platform} (${process.arch}), Remote: ${vscode.env.remoteName || 'local'}, App: ${vscode.env.appName}`
  );

  // Honor VS Code's own `http.proxy` setting for all outbound requests, in addition to
  // the standard HTTPS_PROXY/HTTP_PROXY/NO_PROXY env vars (network.ts falls back to those).
  const applyProxySetting = () => {
    const proxyUrl = vscode.workspace.getConfiguration('http').get<string>('proxy');
    setVSCodeProxyUrl(proxyUrl || undefined);
  };
  applyProxySetting();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('http.proxy')) {
        applyProxySetting();
      }
    })
  );

  // Register first-class native Language Model Chat Provider in VS Code
  const chatProvider = new OpenCodeChatProvider(context, outputChannel);
  context.subscriptions.push(
    vscode.lm.registerLanguageModelChatProvider('opencode', chatProvider)
  );
  // Announce the cached models immediately so Agent Mode sees them before the
  // delayed startup sync finishes; otherwise restored sessions fail model
  // lookup until the first post-sync refresh.
  chatProvider.refresh();
  outputChannel.appendLine('Registered native OpenCode LanguageModelChatProvider with VS Code.');

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

  // Dedicated Activity Bar Sidebar View: Usage & Quotas
  const usageTreeProvider = new OpenCodeUsageTreeProvider(async () => resolveApiKey(context.secrets, false));
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('opencode-usage-view', usageTreeProvider)
  );

  async function openApiKeyPageAndSet(): Promise<void> {
    try {
      await vscode.env.openExternal(vscode.Uri.parse('https://opencode.ai'));
    } catch {}
    await vscode.commands.executeCommand('opencode-copilot-sync.setApiKey');
  }

  const missingKeyActions: Partial<Record<string, () => Thenable<unknown>>> = {
    'Set API Key': () => vscode.commands.executeCommand('opencode-copilot-sync.setApiKey'),
    'Get API Key (opencode.ai)': openApiKeyPageAndSet,
  };

  function handleMissingApiKeyChoice(choice: string | undefined): void {
    const action = missingKeyActions[String(choice)];
    if (action) void action();
  }

  function showMissingApiKeyMessage(interactive: boolean): void {
    if (interactive) {
      vscode.window.showWarningMessage('OpenCode sync cancelled: No API key provided.');
      return;
    }

    void vscode.window
      .showInformationMessage(
        'OpenCode Copilot Sync: Enter your OpenCode API key to enable flat-rate Go and Zen models in Copilot.',
        'Set API Key',
        'Get API Key (opencode.ai)'
      )
      .then(handleMissingApiKeyChoice);
  }

  async function getSyncApiKey(interactive: boolean): Promise<string | undefined> {
    const promptIfMissing = shouldPromptForApiKey(interactive, Boolean(process.env.CI));
    const promptWindow = promptIfMissing ? vscode.window : undefined;
    return resolveApiKey(context.secrets, promptIfMissing, promptWindow);
  }

  async function runSyncWithProgress(
    interactive: boolean,
    apiKey: string,
    syncOptions: SyncOpenCodeOptions
  ): Promise<SyncOpenCodeResult> {
    if (!interactive) return syncOpenCodeModels(apiKey, syncOptions);

    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'OpenCode: Fetching models and syncing to Copilot...',
        cancellable: false,
      },
      () => syncOpenCodeModels(apiKey, syncOptions)
    );
  }

  function logSyncResult(syncResult: SyncOpenCodeResult, interactive: boolean): void {
    outputChannel.appendLine(
      `${interactive ? '' : '[Startup] '}Synced ${syncResult.totalCount} unified OpenCode models (${syncResult.goCount} Go + ${syncResult.zenCount} Zen) to native provider.`
    );
    syncResult.warnings.forEach((warning) => {
      outputChannel.appendLine(`[Compatibility mirror] ${warning}`);
    });
  }

  function reportSyncResult(syncResult: SyncOpenCodeResult, interactive: boolean): void {
    logSyncResult(syncResult, interactive);
    if (interactive) notifySyncResult(syncResult);
  }

  function notifySyncResult(syncResult: SyncOpenCodeResult): void {
    if (syncResult.warnings.length > 0) {
      vscode.window.showWarningMessage(
        `Synced OpenCode models, but ${syncResult.warnings.length} compatibility mirror(s) were skipped. See the OpenCode Copilot Sync output channel for target-local setup instructions.`
      );
      return;
    }

    vscode.window.showInformationMessage(
      `Synced ${syncResult.totalCount} OpenCode models (${syncResult.goCount} Go flat-rate + ${syncResult.zenCount} Zen exclusive) to Copilot!`
    );
  }

  function updateModelCatalog(syncResult: SyncOpenCodeResult): void {
    if (syncResult.models.length > 0) {
      chatProvider.updateModels(
        syncResult.models.map((model) => ({
          id: model.id,
          name: model.name,
          family: getModelFamily(model),
          catalog: getModelCatalog(model),
          isFree: !!model.isFree,
          contextWindow: model.contextWindow,
          maxOutputTokens: model.maxOutputTokens,
          vision: model.vision,
          thinking: model.thinking,
          supportsReasoningEffort: model.supportsReasoningEffort,
          apiType: model.apiType,
        }))
      );
      usageTreeProvider.updateModelCounts(syncResult.goCount, syncResult.zenCount);
      return;
    }
    chatProvider.refresh();
  }

  function reportSyncFailure(error: unknown, interactive: boolean): void {
    const message = formatSyncFailureMessage(error);
    outputChannel.appendLine(`[Sync Error] ${message}`);
    if (interactive) {
      vscode.window.showErrorMessage(`OpenCode sync failed: ${message}`);
    }
    statusBarItem.text = '$(hubot) OpenCode';
    statusBarItem.tooltip = formatSyncFailureTooltip();
  }

  async function runSyncWorkflow(interactive: boolean): Promise<void> {
    const syncOptions = buildSyncOptions(
      vscode.workspace.getConfiguration('opencode'),
      context.globalStorageUri.fsPath,
      vscode.env.remoteName
    );
    const apiKey = await getSyncApiKey(interactive);
    if (!apiKey) {
      showMissingApiKeyMessage(interactive);
      return;
    }

    statusBarItem.text = '$(sync~spin) OpenCode';
    statusBarItem.tooltip = 'Syncing OpenCode models...';
    const syncResult = await runSyncWithProgress(interactive, apiKey, syncOptions);
    reportSyncResult(syncResult, interactive);
    updateModelCatalog(syncResult);
    await updateUsageMeter(statusBarItem, usageTreeProvider, context.secrets, apiKey);
  }

  async function performSync(interactive: boolean): Promise<void> {
    try {
      await runSyncWorkflow(interactive);
    } catch (error: unknown) {
      reportSyncFailure(error, interactive);
    }
  }

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('opencode-copilot-sync.sync', () => performSync(true)),
    vscode.commands.registerCommand('opencode-copilot-sync.refreshUsage', async () => {
      await Promise.all([updateUsageMeter(statusBarItem, usageTreeProvider, context.secrets), usageTreeProvider.refresh()]);
    }),
    vscode.commands.registerCommand('opencode-copilot-sync.setApiKey', async () => {
      const key = await promptAndSetApiKey(context.secrets, vscode.window);
      if (key) {
        vscode.window.showInformationMessage('OpenCode API Key saved! Syncing models to Copilot...');
        await performSync(true);
      }
    }),
    vscode.commands.registerCommand('opencode-copilot-sync.openConfig', async () => {
      const p = getChatLanguageModelsPath(context.globalStorageUri.fsPath);
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
      void performSync(false);
    }, 3000);
  }

  // Periodic usage meter refresh (every 60 seconds)
  const usageTimer = setInterval(() => {
    void updateUsageMeter(statusBarItem, usageTreeProvider, context.secrets);
  }, 60000);
  context.subscriptions.push({ dispose: () => { clearInterval(usageTimer); } });

  return {
    chatProvider,
    statusBarItem,
    performSync,
  };
}

export function deactivate() {}
