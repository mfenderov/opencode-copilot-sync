import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchOpenCodeUsage, formatStatusBarText, formatUsageTooltip } from '../out/usage.js';

test('formatStatusBarText formats weekly usage percentage', () => {
  const usage = {
    rolling: { status: 'ok', percent: 5, resetsAt: '2026-09-12T18:00:00Z' },
    weekly: { status: 'ok', percent: 15, resetsAt: '2026-09-14T00:00:00Z' },
    monthly: { status: 'ok', percent: 2, resetsAt: '2026-10-09T00:00:00Z' },
  };
  const text = formatStatusBarText(usage);
  assert.equal(text, '$(hubot) OpenCode 15%');
});

test('formatStatusBarText handles rate-limited status', () => {
  const usage = {
    rolling: { status: 'rate-limited', percent: 100, resetsAt: '2026-09-12T18:00:00Z' },
    weekly: { status: 'ok', percent: 45, resetsAt: '2026-09-14T00:00:00Z' },
    monthly: { status: 'ok', percent: 10, resetsAt: '2026-10-09T00:00:00Z' },
  };
  const text = formatStatusBarText(usage);
  assert.equal(text, '$(warning) OpenCode 100%');
});

test('formatUsageTooltip produces Markdown table', () => {
  const usage = {
    rolling: { status: 'ok', percent: 0, resetsAt: '2026-09-12T18:00:00Z' },
    weekly: { status: 'ok', percent: 10, resetsAt: '2026-09-14T00:00:00Z' },
    monthly: { status: 'ok', percent: 1, resetsAt: '2026-10-09T00:00:00Z' },
  };
  const md = formatUsageTooltip(usage);
  assert.ok(md.includes('### OpenCode Go Usage'));
  assert.ok(md.includes('5h Rolling'));
  assert.ok(md.includes('Weekly Quota'));
  assert.ok(md.includes('10%'));
});

test('fetchOpenCodeUsage handles successful API response', async () => {
  const mockFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      usage: {
        rolling: { status: 'ok', percent: 0, resetsAt: '2026-09-12T15:39:17Z' },
        weekly: { status: 'ok', percent: 10, resetsAt: '2026-09-14T00:00:00Z' },
        monthly: { status: 'ok', percent: 1, resetsAt: '2026-10-09T06:15:23Z' },
      },
    }),
  });

  const res = await fetchOpenCodeUsage('sk-test', mockFetch);
  assert.equal(res.ok, true);
  assert.equal(res.usage?.weekly.percent, 10);
});

test('fetchOpenCodeUsage handles 403 non-subscription Zen key gracefully', async () => {
  const mockFetch = async () => ({
    ok: false,
    status: 403,
  });

  const res = await fetchOpenCodeUsage('sk-test', mockFetch);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'no-subscription');
});
