export interface GoUsagePeriod {
  status: 'ok' | 'rate-limited';
  percent: number;
  resetsAt: string;
}

export interface GoUsageData {
  rolling: GoUsagePeriod;
  weekly: GoUsagePeriod;
  monthly: GoUsagePeriod;
}

export type GoUsageResult =
  | { ok: true; usage: GoUsageData }
  | { ok: false; reason: 'no-key' | 'unauthorized' | 'no-subscription' | 'network' | 'invalid' };

export function formatStatusBarText(usage: GoUsageData): string {
  const maxPercent = Math.max(usage.rolling.percent, usage.weekly.percent);
  const isRateLimited =
    usage.rolling.status === 'rate-limited' ||
    usage.weekly.status === 'rate-limited' ||
    usage.monthly.status === 'rate-limited';

  const icon = isRateLimited ? '$(warning)' : '$(hubot)';
  return `${icon} OpenCode ${maxPercent}%`;
}

export function formatRelativeTime(isoDateStr: string): string {
  try {
    const target = new Date(isoDateStr).getTime();
    const now = Date.now();
    const diffMs = target - now;
    if (diffMs <= 0) return 'now';

    const diffMins = Math.round(diffMs / 60000);
    if (diffMins < 60) return `in ${diffMins}m`;

    const diffHours = Math.round(diffMins / 60);
    if (diffHours < 24) return `in ${diffHours}h`;

    const diffDays = Math.round(diffHours / 24);
    return `in ${diffDays}d`;
  } catch {
    return isoDateStr;
  }
}

export function formatUsageTooltip(usage: GoUsageData): string {
  return [
    '### OpenCode Go Usage',
    '',
    '| Quota Window | Used | Status | Resets |',
    '|:---|:---:|:---:|:---|',
    `| **5h Rolling** | \`${usage.rolling.percent}%\` | ${usage.rolling.status === 'ok' ? '🟢 OK' : '🔴 Limited'} | ${formatRelativeTime(usage.rolling.resetsAt)} |`,
    `| **Weekly Quota** | \`${usage.weekly.percent}%\` | ${usage.weekly.status === 'ok' ? '🟢 OK' : '🔴 Limited'} | ${formatRelativeTime(usage.weekly.resetsAt)} |`,
    `| **Monthly Quota** | \`${usage.monthly.percent}%\` | ${usage.monthly.status === 'ok' ? '🟢 OK' : '🔴 Limited'} | ${formatRelativeTime(usage.monthly.resetsAt)} |`,
    '',
    '---',
    '_Click to sync models & refresh usage quota._',
  ].join('\n');
}
