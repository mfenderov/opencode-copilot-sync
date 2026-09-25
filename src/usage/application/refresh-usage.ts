import * as vscode from 'vscode';
import { resolveApiKey } from '../../infrastructure/vscode/secret-store.js';
import { fetchOpenCodeUsage } from '../infrastructure/quota-client.js';
import { formatStatusBarText, formatUsageTooltip } from '../domain/usage-snapshot.js';
import type { OpenCodeUsageTreeProvider } from '../infrastructure/usage-tree-adapter.js';

export async function updateUsageMeter(
  statusBarItem: vscode.StatusBarItem,
  usageTreeProvider: OpenCodeUsageTreeProvider,
  secrets: vscode.SecretStorage,
  apiKey?: string
): Promise<void> {
  try {
    const key = apiKey || (await resolveApiKey(secrets, false));
    if (!key) {
      usageTreeProvider.setUsage(null, 'No API key configured');
      return;
    }

    const res = await fetchOpenCodeUsage(key);
    if (res.ok) {
      statusBarItem.text = formatStatusBarText(res.usage);
      const md = new vscode.MarkdownString(formatUsageTooltip(res.usage));
      md.isTrusted = true;
      statusBarItem.tooltip = md;
      usageTreeProvider.setUsage(res.usage);
    } else if (res.reason === 'no-subscription') {
      statusBarItem.text = '$(hubot) OpenCode (Zen)';
      statusBarItem.tooltip = 'OpenCode Zen (Pay-as-you-go / Free tier). Click to sync models.';
      usageTreeProvider.setUsage(null, 'No active Go subscription (Zen pay-as-you-go / free)');
    } else {
      usageTreeProvider.setUsage(null, `Unable to fetch usage (${res.reason})`);
    }
  } catch {
    usageTreeProvider.setUsage(null, 'Error fetching usage');
  }
}
