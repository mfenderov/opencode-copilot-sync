import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

async function loadTestRuntime() {
  try {
    return (await import('../scripts/test-runtime.cjs')).default;
  } catch {
    assert.fail('E2E runners must share an explicit-key and offline-mode helper.');
  }
}

test('E2E live checks require an explicit API key and are disabled in offline mode', async () => {
  const runtime = await loadTestRuntime();
  assert.equal(typeof runtime.getExplicitApiKey, 'function');
  assert.equal(typeof runtime.shouldRunLiveChecks, 'function');
  assert.equal(typeof runtime.applyOfflineTestEnvironment, 'function');
  assert.equal(typeof runtime.getE2ERunnerArgs, 'function');

  assert.equal(runtime.getExplicitApiKey({ OPENCODE_API_KEY: '  sk-test-key  ' }), 'sk-test-key');
  assert.equal(runtime.getExplicitApiKey({}), undefined);
  assert.equal(runtime.shouldRunLiveChecks({ OPENCODE_API_KEY: 'sk-test-key' }, []), true);
  assert.equal(
    runtime.shouldRunLiveChecks({ OPENCODE_API_KEY: 'sk-test-key', OPENCODE_OFFLINE: '1' }, []),
    false
  );
  assert.equal(runtime.shouldRunLiveChecks({}, []), false);

  const env = { OPENCODE_API_KEY: 'sk-test-key' };
  assert.equal(runtime.applyOfflineTestEnvironment(env, ['--offline']), true);
  assert.equal(env.OPENCODE_API_KEY, undefined);
  assert.equal(env.OPENCODE_OFFLINE, '1');
  assert.equal(env.CI, '1');
  assert.deepEqual(runtime.getE2ERunnerArgs(false), ['test/e2e/runner.js']);
  assert.deepEqual(runtime.getE2ERunnerArgs(true), ['test/e2e/runner.js', '--offline']);
});

test('WSL and VS Code E2E checks do not rely on auth.json or stored-key scanning', () => {
  const remoteScript = fs.readFileSync(path.join(process.cwd(), 'scripts', 'test-remote-wsl.js'), 'utf8');
  const wslReproduction = fs.readFileSync(path.join(process.cwd(), 'scripts', 'reproduce-wsl-issue.js'), 'utf8');
  const e2eSuite = fs.readFileSync(path.join(process.cwd(), 'test', 'e2e', 'suite.cjs'), 'utf8');
  const e2eRunner = fs.readFileSync(path.join(process.cwd(), 'test', 'e2e', 'runner.js'), 'utf8');

  assert.doesNotMatch(remoteScript, /getStoredOpenCodeKey|auth\.json/);
  assert.doesNotMatch(wslReproduction, /auth\.json|cross-mount scanning/i);
  assert.doesNotMatch(e2eSuite, /getStoredOpenCodeKey|auth\.json/);
  assert.match(remoteScript, /shouldRunLiveChecks/);
  assert.match(e2eSuite, /shouldRunLiveChecks/);
  assert.match(e2eRunner, /applyOfflineTestEnvironment/);
});
