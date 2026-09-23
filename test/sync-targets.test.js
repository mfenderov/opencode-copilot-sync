import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function loadSyncTargets() {
  try {
    return await import('../out/sync-targets.js');
  } catch {
    assert.fail('Sync target discovery must be extracted into a testable module.');
  }
}

function userConfigDir(homeDir, platform, appDataPath) {
  if (platform === 'darwin') {
    return path.join(homeDir, 'Library', 'Application Support', 'Code', 'User');
  }
  if (platform === 'win32') {
    return path.join(appDataPath, 'Code', 'User');
  }
  return path.join(homeDir, '.vscode-server', 'data', 'User');
}

function makeDiscoveryContext(homeDir) {
  const appDataPath = process.platform === 'win32'
    ? path.join(homeDir, 'AppData', 'Roaming')
    : undefined;
  const userDir = userConfigDir(homeDir, process.platform, appDataPath);
  const activeExtensionStoragePath = path.join(
    userDir,
    'globalStorage',
    'mfenderov.opencode-copilot-sync'
  );
  return {
    platform: process.platform,
    homeDir,
    appDataPath,
    activeExtensionStoragePath,
    userDir,
  };
}

function wslUserConfigDir(homeDir, platform) {
  const pathOps = platform === 'win32' ? path.win32 : path.posix;
  return pathOps.join(homeDir, '.vscode-server', 'data', 'User');
}

test('sync target discovery stays within the current user by default', async () => {
  const { discoverSyncTargets } = await loadSyncTargets();
  assert.equal(typeof discoverSyncTargets, 'function');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-targets-'));
  const homeDir = path.join(root, 'home', 'current-user');
  const { platform, appDataPath, activeExtensionStoragePath, userDir } = makeDiscoveryContext(homeDir);
  const profileDir = path.join(userDir, 'profiles', 'work');
  const otherUserHome = path.join(root, 'home', 'other-user');
  const otherUserDir = userConfigDir(otherUserHome, platform, appDataPath);
  const siblingDistroHome = path.join(root, 'wsl', 'Debian', 'home', 'other-user');

  try {
    fs.mkdirSync(activeExtensionStoragePath, { recursive: true });
    fs.mkdirSync(profileDir, { recursive: true });
    fs.mkdirSync(otherUserDir, { recursive: true });

    const paths = discoverSyncTargets({
      platform,
      homeDir,
      appDataPath,
      activeExtensionStoragePath,
    }).map((target) => target.path);

    assert.ok(paths.includes(path.join(userDir, 'chatLanguageModels.json')));
    assert.ok(paths.includes(path.join(profileDir, 'chatLanguageModels.json')));
    assert.ok(!paths.some((candidate) => candidate.startsWith(otherUserHome)));
    assert.ok(!paths.some((candidate) => candidate.startsWith(path.join(root, 'wsl', 'Debian'))));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sync target discovery includes only the associated WSL home and exact explicit paths', async () => {
  const { discoverSyncTargets } = await loadSyncTargets();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-targets-wsl-'));
  const homeDir = path.join(root, 'home', 'current-user');
  const { platform, appDataPath, activeExtensionStoragePath } = makeDiscoveryContext(homeDir);
  const associatedWslHome = path.join(root, 'wsl', 'Ubuntu', 'home', 'current-user');
  const siblingWslHome = path.join(root, 'wsl', 'Debian', 'home', 'other-user');
  const explicitTargetPath = path.join(root, 'opt-in', 'chatLanguageModels.json');
  const associatedUserDir = wslUserConfigDir(associatedWslHome, platform);
  const siblingUserDir = wslUserConfigDir(siblingWslHome, platform);

  try {
    fs.mkdirSync(activeExtensionStoragePath, { recursive: true });
    fs.mkdirSync(associatedUserDir, { recursive: true });
    fs.mkdirSync(siblingUserDir, { recursive: true });

    const paths = discoverSyncTargets({
      platform,
      homeDir,
      appDataPath,
      activeExtensionStoragePath,
      associatedWslHome,
      additionalTargetPaths: [explicitTargetPath],
    }).map((target) => target.path);

    assert.ok(paths.includes(path.join(associatedUserDir, 'chatLanguageModels.json')));
    assert.ok(paths.includes(explicitTargetPath));
    assert.ok(!paths.some((candidate) => candidate.startsWith(siblingWslHome)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sync target discovery rejects relative explicit target paths', async () => {
  const { discoverSyncTargets } = await loadSyncTargets();

  assert.throws(
    () => discoverSyncTargets({ platform: 'linux', homeDir: os.tmpdir(), additionalTargetPaths: ['extra.json'] }),
    /absolute/
  );
});

test('sync target discovery rejects absolute paths that are not chatLanguageModels.json', async () => {
  const { discoverSyncTargets } = await loadSyncTargets();

  assert.throws(
    () =>
      discoverSyncTargets({
        platform: 'linux',
        homeDir: os.tmpdir(),
        additionalTargetPaths: [path.join(os.tmpdir(), 'other-config.json')],
      }),
    /chatLanguageModels\.json/
  );
});

test('primary target identity compares Windows paths case-insensitively', async () => {
  const { sameSyncTargetPath } = await loadSyncTargets();
  assert.equal(typeof sameSyncTargetPath, 'function');
  assert.equal(
    sameSyncTargetPath(
      'C:\\Users\\current-user\\AppData\\Roaming\\Code\\User\\chatLanguageModels.json',
      'c:\\users\\CURRENT-USER\\AppData\\Roaming\\Code\\User\\chatLanguageModels.json',
      'win32'
    ),
    true
  );
});

test('default WSL path resolution uses the isolated current-user home', async () => {
  const { getChatLanguageModelsPath } = await loadSyncTargets();
  const homeDir = '/opencode-wsl-home-test';

  assert.equal(
    getChatLanguageModelsPath(undefined, { platform: 'linux', homeDir, isWsl: true }),
    path.posix.join(homeDir, '.vscode-server', 'data', 'User', 'chatLanguageModels.json')
  );
});

test('Mac and Linux path defaults stay with the current profile', { skip: process.platform === 'win32' }, async () => {
  const { getChatLanguageModelsPath } = await loadSyncTargets();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-platform-paths-'));

  try {
    const macHome = path.join(root, 'mac-user');
    const insidersUser = path.join(macHome, 'Library', 'Application Support', 'Code - Insiders', 'User');
    fs.mkdirSync(insidersUser, { recursive: true });
    assert.equal(
      getChatLanguageModelsPath(undefined, { platform: 'darwin', homeDir: macHome }),
      path.join(insidersUser, 'chatLanguageModels.json')
    );
    fs.mkdirSync(path.join(macHome, 'Library', 'Application Support', 'Code', 'User'), { recursive: true });
    assert.equal(
      getChatLanguageModelsPath(undefined, { platform: 'darwin', homeDir: macHome }),
      path.join(macHome, 'Library', 'Application Support', 'Code', 'User', 'chatLanguageModels.json')
    );

    const linuxHome = path.join(root, 'linux-user');
    assert.equal(
      getChatLanguageModelsPath(undefined, { platform: 'linux', homeDir: linuxHome, isWsl: false }),
      path.join(linuxHome, '.config', 'Code', 'User', 'chatLanguageModels.json')
    );
    fs.mkdirSync(path.join(linuxHome, '.vscode-server-insiders'), { recursive: true });
    assert.equal(
      getChatLanguageModelsPath(undefined, { platform: 'linux', homeDir: linuxHome, isWsl: false }),
      path.join(linuxHome, '.vscode-server-insiders', 'data', 'User', 'chatLanguageModels.json')
    );

  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Windows path defaults use the supplied current-user AppData root', async () => {
  const { getChatLanguageModelsPath } = await loadSyncTargets();
  const homeDir = 'C:\\Users\\current-user';
  const appDataPath = path.win32.join(homeDir, 'AppData', 'Roaming');

  assert.equal(
    getChatLanguageModelsPath(undefined, { platform: 'win32', homeDir, appDataPath }),
    path.win32.join(appDataPath, 'Code', 'User', 'chatLanguageModels.json')
  );
});

test('associated WSL home resolution uses only the named distro and reports lookup failures', async () => {
  const { resolveAssociatedWslHome } = await loadSyncTargets();
  assert.equal(typeof resolveAssociatedWslHome, 'function');

  let queriedDistro;
  const resolved = resolveAssociatedWslHome('wsl+Ubuntu', {
    platform: 'win32',
    queryHome: (distro) => {
      queriedDistro = distro;
      return '/home/current-user';
    },
  });

  assert.equal(queriedDistro, 'Ubuntu');
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.homeDir, '\\\\wsl.localhost\\Ubuntu\\home\\current-user');
  assert.deepEqual(resolveAssociatedWslHome('wsl+Ubuntu', { platform: 'linux' }), { status: 'not-applicable' });
  assert.deepEqual(resolveAssociatedWslHome(undefined, { platform: 'win32' }), { status: 'not-applicable' });

  const invalidDistro = resolveAssociatedWslHome('wsl+../other', {
    platform: 'win32',
    queryHome: () => {
      assert.fail('Invalid distro names must not be executed.');
    },
  });
  assert.equal(invalidDistro.status, 'warning');
  assert.ok(invalidDistro.warning);

  const failedLookup = resolveAssociatedWslHome('wsl+Debian', {
    platform: 'win32',
    queryHome: () => {
      throw new Error('WSL unavailable');
    },
  });
  assert.equal(failedLookup.status, 'warning');
  assert.match(failedLookup.warning, /additionalSyncTargets/);
});
