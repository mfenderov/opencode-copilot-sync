import { test } from 'node:test';
import assert from 'node:assert/strict';

async function loadSyncStatus() {
  try {
    return await import('../out/sync-status.js');
  } catch {
    assert.fail('Sync failure status text must be provided by a testable formatter.');
  }
}

test('sync failure tooltip reports failure and retry instead of success', async () => {
  const { formatSyncFailureTooltip, formatSyncFailureMessage } = await loadSyncStatus();
  assert.equal(typeof formatSyncFailureTooltip, 'function');
  assert.equal(typeof formatSyncFailureMessage, 'function');

  const tooltip = formatSyncFailureTooltip();

  assert.match(tooltip, /failed/i);
  assert.match(tooltip, /retry/i);
  assert.doesNotMatch(tooltip, /synced successfully|models synced with Copilot/i);
  assert.equal(formatSyncFailureMessage(new Error('failure')), 'failure');
  assert.equal(formatSyncFailureMessage('unknown failure'), 'unknown failure');
});
