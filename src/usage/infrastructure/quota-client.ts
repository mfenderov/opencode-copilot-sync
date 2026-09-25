// Usage infrastructure: quota HTTP client.
import { isOfflineMode } from '../../infrastructure/http/fetch-policy.js';
import type { GoUsageData, GoUsageResult } from '../domain/usage-snapshot.js';

export const OPENCODE_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage';

export async function fetchOpenCodeUsage(
  apiKey: string,
  fetchFn: typeof fetch = fetch
): Promise<GoUsageResult> {
  if (!apiKey?.trim()) {
    return { ok: false, reason: 'no-key' };
  }
  if (isOfflineMode()) {
    return { ok: false, reason: 'network' };
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
