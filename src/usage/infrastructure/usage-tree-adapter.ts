import * as vscode from 'vscode';
import { fetchOpenCodeUsage } from './quota-client.js';
import { formatRelativeTime, type GoUsageData } from '../domain/usage-snapshot.js';

export type UsageTreeItemType =
  | 'category'
  | 'quota-item'
  | 'catalog-item'
  | 'action-item'
  | 'status-item';

export class OpenCodeTreeItem extends vscode.TreeItem {
  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.None,
    public readonly itemType: UsageTreeItemType = 'status-item'
  ) {
    super(label, collapsibleState);
  }
}

export class OpenCodeUsageTreeProvider implements vscode.TreeDataProvider<OpenCodeTreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<OpenCodeTreeItem | undefined | null>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private usageData: GoUsageData | null = null;
  private usageError: string | null = null;
  private goModelCount = 0;
  private zenModelCount = 0;
  private readonly getApiKeyFn: () => Promise<string | undefined>;

  constructor(getApiKey: () => Promise<string | undefined>) {
    this.getApiKeyFn = getApiKey;
  }

  updateModelCounts(goCount: number, zenCount: number): void {
    this.goModelCount = goCount;
    this.zenModelCount = zenCount;
    this._onDidChangeTreeData.fire(undefined);
  }

  setUsage(usage: GoUsageData | null, error?: string): void {
    this.usageData = usage;
    this.usageError = error ?? null;
    this._onDidChangeTreeData.fire(undefined);
  }

  async refresh(): Promise<void> {
    try {
      const apiKey = await this.getApiKeyFn();
      if (!apiKey) {
        this.usageData = null;
        this.usageError = 'No API key configured';
        this._onDidChangeTreeData.fire(undefined);
        return;
      }
      const res = await fetchOpenCodeUsage(apiKey);
      if (res.ok) {
        this.usageData = res.usage;
        this.usageError = null;
      } else if (res.reason === 'no-subscription') {
        this.usageData = null;
        this.usageError = 'No active Go subscription (Zen pay-as-you-go / free)';
      } else {
        this.usageData = null;
        this.usageError = `Unable to fetch usage (${res.reason})`;
      }
    } catch (err: unknown) {
      this.usageData = null;
      this.usageError = err instanceof Error ? err.message : 'Error fetching usage';
    }
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: OpenCodeTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: OpenCodeTreeItem): vscode.ProviderResult<OpenCodeTreeItem[]> {
    if (!element) {
      return this.getRootItems();
    }
    if (element.itemType === 'category') {
      return this.getCategoryChildren(element);
    }
    return [];
  }

  private getRootItems(): OpenCodeTreeItem[] {
    const quotaCategory = new OpenCodeTreeItem(
      'Go Subscription Quotas',
      vscode.TreeItemCollapsibleState.Expanded,
      'category'
    );
    quotaCategory.iconPath = new vscode.ThemeIcon('dashboard');

    const catalogCategory = new OpenCodeTreeItem(
      'Model Catalogs',
      vscode.TreeItemCollapsibleState.Expanded,
      'category'
    );
    catalogCategory.iconPath = new vscode.ThemeIcon('layers');

    const actionCategory = new OpenCodeTreeItem(
      'Quick Actions',
      vscode.TreeItemCollapsibleState.Expanded,
      'category'
    );
    actionCategory.iconPath = new vscode.ThemeIcon('zap');

    return [quotaCategory, catalogCategory, actionCategory];
  }

  private getCategoryChildren(element: OpenCodeTreeItem): OpenCodeTreeItem[] {
    if (element.label === 'Go Subscription Quotas') {
      if (this.usageError) {
        const errItem = new OpenCodeTreeItem(this.usageError, vscode.TreeItemCollapsibleState.None, 'status-item');
        errItem.iconPath = new vscode.ThemeIcon('info');
        if (this.usageError.includes('API key')) {
          errItem.command = {
            command: 'opencode-copilot-sync.setApiKey',
            title: 'Set API Key',
          };
        }
        return [errItem];
      }

      if (!this.usageData) {
        const loadingItem = new OpenCodeTreeItem('Loading usage data...', vscode.TreeItemCollapsibleState.None, 'status-item');
        loadingItem.iconPath = new vscode.ThemeIcon('loading~spin');
        return [loadingItem];
      }

      const { rolling, weekly, monthly } = this.usageData;

      const createPeriodItem = (name: string, period: typeof rolling): OpenCodeTreeItem => {
        const resetsIn = formatRelativeTime(period.resetsAt);
        const item = new OpenCodeTreeItem(
          `${name}: ${period.percent}% (resets ${resetsIn})`,
          vscode.TreeItemCollapsibleState.None,
          'quota-item'
        );
        const isLimited = period.status === 'rate-limited';
        item.iconPath = new vscode.ThemeIcon(
          isLimited ? 'warning' : 'pass',
          isLimited ? new vscode.ThemeColor('charts.red') : new vscode.ThemeColor('charts.green')
        );
        item.tooltip = `${name} limit: ${period.percent}% used. Status: ${period.status}. Resets at ${period.resetsAt}`;
        return item;
      };

      return [
        createPeriodItem('Rolling 5-Hour', rolling),
        createPeriodItem('Weekly Quota', weekly),
        createPeriodItem('Monthly Quota', monthly),
      ];
    }

    if (element.label === 'Model Catalogs') {
      const goItem = new OpenCodeTreeItem(
        `OpenCode Go: ${this.goModelCount} models`,
        vscode.TreeItemCollapsibleState.None,
        'catalog-item'
      );
      goItem.description = 'Flat-rate ($0/token)';
      goItem.iconPath = new vscode.ThemeIcon('package');

      const zenItem = new OpenCodeTreeItem(
        `Zen & Free Tier: ${this.zenModelCount} models`,
        vscode.TreeItemCollapsibleState.None,
        'catalog-item'
      );
      zenItem.description = 'Free & pay-as-you-go';
      zenItem.iconPath = new vscode.ThemeIcon('gift');

      return [goItem, zenItem];
    }

    if (element.label === 'Quick Actions') {
      const syncItem = new OpenCodeTreeItem(
        'Sync Models to Copilot',
        vscode.TreeItemCollapsibleState.None,
        'action-item'
      );
      syncItem.iconPath = new vscode.ThemeIcon('sync');
      syncItem.command = {
        command: 'opencode-copilot-sync.sync',
        title: 'Sync Models to Copilot',
      };

      const keyItem = new OpenCodeTreeItem(
        'Set API Key',
        vscode.TreeItemCollapsibleState.None,
        'action-item'
      );
      keyItem.iconPath = new vscode.ThemeIcon('key');
      keyItem.command = {
        command: 'opencode-copilot-sync.setApiKey',
        title: 'Set API Key',
      };

      const cfgItem = new OpenCodeTreeItem(
        'Open Models Config',
        vscode.TreeItemCollapsibleState.None,
        'action-item'
      );
      cfgItem.iconPath = new vscode.ThemeIcon('settings-gear');
      cfgItem.command = {
        command: 'opencode-copilot-sync.openConfig',
        title: 'Open Models Config',
      };

      return [syncItem, keyItem, cfgItem];
    }

    return [];
  }
}
