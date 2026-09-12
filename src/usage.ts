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

export const OPENCODE_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage';

export async function fetchOpenCodeUsage(
  apiKey: string,
  fetchFn: typeof fetch = fetch
): Promise<GoUsageResult> {
  if (!apiKey || !apiKey.trim()) {
    return { ok: false, reason: 'no-key' };
  }

  try {
    const res = await fetchFn(OPENCODE_USAGE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey.trim()}`,
        'x-opencode-session': 'vscode-copilot',
        'User-Agent': 'vscode-copilot/1.0',
      },
    });

    if (res.status === 401) return { ok: false, reason: 'unauthorized' };
    if (res.status === 403) return { ok: false, reason: 'no-subscription' };
    if (!res.ok) return { ok: false, reason: 'network' };

    const json = (await res.json()) as { usage?: GoUsageData };
    if (!json?.usage?.rolling || !json?.usage?.weekly || !json?.usage?.monthly) {
      return { ok: false, reason: 'invalid' };
    }

    return { ok: true, usage: json.usage };
  } catch {
    return { ok: false, reason: 'network' };
  }
}

export function formatStatusBarText(usage: GoUsageData): string {
  const maxPercent = Math.max(usage.rolling.percent, usage.weekly.percent);
  const isRateLimited =
    usage.rolling.status === 'rate-limited' ||
    usage.weekly.status === 'rate-limited' ||
    usage.monthly.status === 'rate-limited';

  const icon = isRateLimited ? '$(warning)' : '$(hubot)';
  return `${icon} OpenCode ${maxPercent}%`;
}

function formatRelativeTime(isoDateStr: string): string {
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
