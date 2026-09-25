import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { OpenCodeUsageTreeProvider } from '../out/usage/infrastructure/usage-tree-adapter.js';

test('OpenCodeUsageTreeProvider: returns 3 root categories', () => {
  const provider = new OpenCodeUsageTreeProvider(async () => 'sk-test');
  const roots = provider.getChildren();
  assert.equal(roots.length, 3);
  assert.equal(roots[0].label, 'Go Subscription Quotas');
  assert.equal(roots[1].label, 'Model Catalogs');
  assert.equal(roots[2].label, 'Quick Actions');
});

test('OpenCodeUsageTreeProvider: shows loading item when no usage and no error', () => {
  const provider = new OpenCodeUsageTreeProvider(async () => 'sk-test');
  const [quotaRoot] = provider.getChildren();
  const children = provider.getChildren(quotaRoot);
  assert.equal(children.length, 1);
  assert.equal(children[0].label, 'Loading usage data...');
});

test('OpenCodeUsageTreeProvider: renders quota items correctly when usage data is present', () => {
  const provider = new OpenCodeUsageTreeProvider(async () => 'sk-test');
  provider.setUsage({
    rolling: { status: 'ok', percent: 25, resetsAt: new Date(Date.now() + 3600000).toISOString() },
    weekly: { status: 'rate-limited', percent: 100, resetsAt: new Date(Date.now() + 86400000).toISOString() },
    monthly: { status: 'ok', percent: 45, resetsAt: new Date(Date.now() + 864000000).toISOString() },
  });

  const [quotaRoot] = provider.getChildren();
  const children = provider.getChildren(quotaRoot);
  assert.equal(children.length, 3);

  assert.match(children[0].label, /Rolling 5-Hour: 25%/);
  assert.equal(children[0].iconPath.id, 'pass');

  assert.match(children[1].label, /Weekly Quota: 100%/);
  assert.equal(children[1].iconPath.id, 'warning');

  assert.match(children[2].label, /Monthly Quota: 45%/);
  assert.equal(children[2].iconPath.id, 'pass');
});

test('OpenCodeUsageTreeProvider: displays error status item when error is set', () => {
  const provider = new OpenCodeUsageTreeProvider(async () => 'sk-test');
  provider.setUsage(null, 'No API key configured');

  const [quotaRoot] = provider.getChildren();
  const children = provider.getChildren(quotaRoot);
  assert.equal(children.length, 1);
  assert.equal(children[0].label, 'No API key configured');
  assert.equal(children[0].command.command, 'opencode-copilot-sync.setApiKey');
});

test('OpenCodeUsageTreeProvider: displays updated model counts in Model Catalogs', () => {
  const provider = new OpenCodeUsageTreeProvider(async () => 'sk-test');
  provider.updateModelCounts(38, 50);

  const [, catalogRoot] = provider.getChildren();
  const children = provider.getChildren(catalogRoot);
  assert.equal(children.length, 2);
  assert.equal(children[0].label, 'OpenCode Go: 38 models');
  assert.equal(children[1].label, 'Zen & Free Tier: 50 models');
});

test('OpenCodeUsageTreeProvider: lists quick actions with proper commands', () => {
  const provider = new OpenCodeUsageTreeProvider(async () => 'sk-test');
  const [, , actionRoot] = provider.getChildren();
  const children = provider.getChildren(actionRoot);
  assert.equal(children.length, 3);
  assert.equal(children[0].command.command, 'opencode-copilot-sync.sync');
  assert.equal(children[1].command.command, 'opencode-copilot-sync.setApiKey');
  assert.equal(children[2].command.command, 'opencode-copilot-sync.openConfig');
});

test('OpenCodeUsageTreeProvider: refresh() handles missing API key', async () => {
  const provider = new OpenCodeUsageTreeProvider(async () => undefined);
  await provider.refresh();

  const [quotaRoot] = provider.getChildren();
  const children = provider.getChildren(quotaRoot);
  assert.equal(children.length, 1);
  assert.equal(children[0].label, 'No API key configured');
});

test('OpenCodeUsageTreeProvider: refresh() fetches and populates usage data', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      usage: {
        rolling: { status: 'ok', percent: 12, resetsAt: new Date().toISOString() },
        weekly: { status: 'ok', percent: 34, resetsAt: new Date().toISOString() },
        monthly: { status: 'ok', percent: 56, resetsAt: new Date().toISOString() },
      },
    }),
  });

  try {
    const provider = new OpenCodeUsageTreeProvider(async () => 'sk-valid-key');
    await provider.refresh();

    const [quotaRoot] = provider.getChildren();
    const children = provider.getChildren(quotaRoot);
    assert.equal(children.length, 3);
    assert.match(children[0].label, /Rolling 5-Hour: 12%/);
    assert.match(children[1].label, /Weekly Quota: 34%/);
    assert.match(children[2].label, /Monthly Quota: 56%/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('OpenCodeUsageTreeProvider: refresh() handles 403 no-subscription response', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 403,
  });

  try {
    const provider = new OpenCodeUsageTreeProvider(async () => 'sk-zen-only-key');
    await provider.refresh();

    const [quotaRoot] = provider.getChildren();
    const children = provider.getChildren(quotaRoot);
    assert.equal(children.length, 1);
    assert.match(children[0].label, /No active Go subscription/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('OpenCodeUsageTreeProvider: refresh() handles network fetch error', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('Connection refused');
  };

  try {
    const provider = new OpenCodeUsageTreeProvider(async () => 'sk-key');
    await provider.refresh();

    const [quotaRoot] = provider.getChildren();
    const children = provider.getChildren(quotaRoot);
    assert.equal(children.length, 1);
    assert.match(children[0].label, /Unable to fetch usage/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

