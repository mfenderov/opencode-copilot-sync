export async function fetchOpenCodeModels(
  apiKey: string,
  isGo: boolean = true
): Promise<string[]> {
  const url = isGo
    ? 'https://opencode.ai/zen/go/v1/models'
    : 'https://opencode.ai/zen/v1/models';

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'User-Agent': 'vscode-copilot/1.0',
    },
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Failed to fetch models (${res.status} ${res.statusText}): ${errorText}`);
  }

  const json = (await res.json()) as { data?: Array<{ id: string }> };
  if (!json.data || !Array.isArray(json.data)) {
    throw new Error('Invalid response structure: expected data array');
  }

  return json.data.map((m) => m.id).filter(Boolean);
}
