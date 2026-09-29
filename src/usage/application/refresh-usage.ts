// Usage application: quota meter refresh orchestration.
import * as vscode from 'vscode';
import { resolveApiKey } from '../../infrastructure/vscode/secret-store.js';
import { fetchOpenCodeUsage } from '../infrastructure/quota-client.js';
import type { GoUsageData } from '../domain/usage-snapshot.js';
import { formatStatusBarText, formatUsageTooltip, toUsageDisplayState } from '../domain/usage-snapshot.js';
import type { OpenCodeUsageTreeProvider } from '../infrastructure/usage-tree-adapter.js';

interface MeterTargets {
  statusBarItem: vscode.StatusBarItem;
  usageTreeProvider: OpenCodeUsageTreeProvider;
}

function renderUsage(targets: MeterTargets, usage: GoUsageData): void {
  targets.statusBarItem.text = formatStatusBarText(usage);
  const md = new vscode.MarkdownString(formatUsageTooltip(usage));
  md.isTrusted = true;
  targets.statusBarItem.tooltip = md;
  targets.usageTreeProvider.setUsage(usage);
}

function renderNoSubscription(targets: MeterTargets): void {
  targets.statusBarItem.text = '$(hubot) OpenCode (Zen)';
  targets.statusBarItem.tooltip = 'OpenCode Zen (Pay-as-you-go / Free tier). Click to sync models.';
}

async function refreshWithKey(targets: MeterTargets, key: string): Promise<void> {
  const res = await fetchOpenCodeUsage(key);
  if (res.ok) {
    renderUsage(targets, res.usage);
    return;
  }
  if (res.reason === 'no-subscription') {
    renderNoSubscription(targets);
  }
  const state = toUsageDisplayState(res);
  targets.usageTreeProvider.setUsage(state.usage, state.error);
}

export async function updateUsageMeter(
  statusBarItem: vscode.StatusBarItem,
  usageTreeProvider: OpenCodeUsageTreeProvider,
  secrets: vscode.SecretStorage,
  apiKey?: string
): Promise<void> {
  const targets = { statusBarItem, usageTreeProvider };
  try {
    const key = apiKey || (await resolveApiKey(secrets, false));
    if (!key) {
      usageTreeProvider.setUsage(null, 'No API key configured');
      return;
    }
    await refreshWithKey(targets, key);
  } catch {
    usageTreeProvider.setUsage(null, 'Error fetching usage');
  }
}
