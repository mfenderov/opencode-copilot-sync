const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function createIsolatedTestRoot(prefix) {
  if (typeof prefix !== 'string' || !/^[a-z0-9][a-z0-9-]*-$/.test(prefix)) {
    throw new Error('Test root prefix must be a lowercase name ending in a hyphen.');
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  let cleaned = false;

  return {
    root,
    cleanup() {
      if (cleaned) return;

      const resolvedRoot = path.resolve(root);
      if (
        path.dirname(resolvedRoot) !== path.resolve(os.tmpdir()) ||
        !path.basename(resolvedRoot).startsWith(prefix)
      ) {
        throw new Error('Refusing to clean a path outside this test run temporary root.');
      }

      fs.rmSync(resolvedRoot, { recursive: true, force: true });
      cleaned = true;
    },
  };
}

function createRemoteWslSandbox() {
  const run = createIsolatedTestRoot('opencode-remote-wsl-');
  return {
    ...run,
    homeDir: path.join(run.root, 'home', 'wsl-user'),
    windowsProfile: path.join(run.root, 'mnt', 'c', 'Users', 'CurrentUser'),
    associatedWslHome: path.join(run.root, 'wsl', 'Ubuntu', 'home', 'wsl-user'),
    siblingWslHome: path.join(run.root, 'wsl', 'Debian', 'home', 'other-user'),
  };
}

function getExplicitApiKey(env = process.env) {
  const key = env.OPENCODE_API_KEY;
  return typeof key === 'string' && key.trim() ? key.trim() : undefined;
}

function isOfflineTestRun(env = process.env, argv = process.argv) {
  return argv.includes('--offline') || env.OPENCODE_OFFLINE === '1';
}

function shouldRunLiveChecks(env = process.env, argv = process.argv) {
  return !isOfflineTestRun(env, argv) && Boolean(getExplicitApiKey(env));
}

function applyOfflineTestEnvironment(env = process.env, argv = process.argv) {
  if (!isOfflineTestRun(env, argv)) return false;

  delete env.OPENCODE_API_KEY;
  env.OPENCODE_OFFLINE = '1';
  env.CI = '1';
  return true;
}

function getE2ERunnerArgs(forceOffline) {
  return forceOffline ? ['test/e2e/runner.js', '--offline'] : ['test/e2e/runner.js'];
}

module.exports = {
  applyOfflineTestEnvironment,
  createIsolatedTestRoot,
  createRemoteWslSandbox,
  getE2ERunnerArgs,
  getExplicitApiKey,
  isOfflineTestRun,
  shouldRunLiveChecks,
};
