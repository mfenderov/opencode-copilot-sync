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

test('sync target discovery stays within the current user by default', async () => {
  const { discoverSyncTargets } = await loadSyncTargets();
  assert.equal(typeof discoverSyncTargets, 'function');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-targets-'));
  const homeDir = path.join(root, 'home', 'current-user');
  const userDir = path.join(homeDir, '.vscode-server', 'data', 'User');
  const activeStoragePath = path.join(userDir, 'globalStorage', 'mfenderov.opencode-copilot-sync');
  const profileDir = path.join(userDir, 'profiles', 'work');
  const otherUserDir = path.join(root, 'home', 'other-user', '.vscode-server', 'data', 'User');
  const siblingDistroHome = path.join(root, 'wsl', 'Debian', 'home', 'other-user');

  try {
    fs.mkdirSync(activeStoragePath, { recursive: true });
    fs.mkdirSync(profileDir, { recursive: true });
    fs.mkdirSync(otherUserDir, { recursive: true });
    fs.mkdirSync(path.join(siblingDistroHome, '.vscode-server', 'data', 'User'), { recursive: true });

    const paths = discoverSyncTargets({
      platform: 'linux',
      homeDir,
      activeExtensionStoragePath: activeStoragePath,
    }).map((target) => target.path);

    assert.ok(paths.includes(path.join(userDir, 'chatLanguageModels.json')));
    assert.ok(paths.includes(path.join(profileDir, 'chatLanguageModels.json')));
    assert.ok(!paths.some((candidate) => candidate.startsWith(path.join(root, 'home', 'other-user'))));
    assert.ok(!paths.some((candidate) => candidate.startsWith(path.join(root, 'wsl', 'Debian'))));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sync target discovery includes only the associated WSL home and exact explicit paths', async () => {
  const { discoverSyncTargets } = await loadSyncTargets();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-targets-wsl-'));
  const homeDir = path.join(root, 'home', 'current-user');
  const associatedWslHome = path.join(root, 'wsl', 'Ubuntu', 'home', 'current-user');
  const siblingWslHome = path.join(root, 'wsl', 'Debian', 'home', 'other-user');
  const explicitTargetPath = path.join(root, 'opt-in', 'chatLanguageModels.json');

  try {
    fs.mkdirSync(path.join(associatedWslHome, '.vscode-server', 'data', 'User'), { recursive: true });
    fs.mkdirSync(path.join(siblingWslHome, '.vscode-server', 'data', 'User'), { recursive: true });

    const paths = discoverSyncTargets({
      platform: 'linux',
      homeDir,
      associatedWslHome,
      additionalTargetPaths: [explicitTargetPath],
    }).map((target) => target.path);

    assert.ok(paths.includes(path.join(associatedWslHome, '.vscode-server', 'data', 'User', 'chatLanguageModels.json')));
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
  const homeDir = path.join(os.tmpdir(), 'opencode-wsl-home-test');

  assert.equal(
    getChatLanguageModelsPath(undefined, { platform: 'linux', homeDir, isWsl: true }),
    path.join(homeDir, '.vscode-server', 'data', 'User', 'chatLanguageModels.json')
  );
});

test('platform path defaults stay with the current profile', async () => {
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

    const appDataPath = path.win32.join('C:\\Users\\current-user', 'AppData', 'Roaming');
    assert.equal(
      getChatLanguageModelsPath(undefined, {
        platform: 'win32',
        homeDir: 'C:\\Users\\current-user',
        appDataPath,
      }),
      path.win32.join(appDataPath, 'Code', 'User', 'chatLanguageModels.json')
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
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
