import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const harnessPath = path.join(process.cwd(), 'scripts', 'test-remote-wsl.js');

async function loadSandboxModule() {
  try {
    return (await import('../scripts/test-runtime.cjs')).default;
  } catch {
    assert.fail('The remote WSL harness must provide its isolated sandbox helper.');
  }
}

test('remote WSL sandbox uses a unique temporary root and only cleans its own run', async () => {
  const { createRemoteWslSandbox } = await loadSandboxModule();
  assert.equal(typeof createRemoteWslSandbox, 'function');

  const first = createRemoteWslSandbox();
  const second = createRemoteWslSandbox();
  const sibling = `${first.root}-sibling`;

  try {
    assert.notEqual(first.root, second.root);
    assert.equal(path.dirname(first.root), os.tmpdir());
    assert.equal(path.dirname(second.root), os.tmpdir());
    assert.match(path.basename(first.root), /^opencode-remote-wsl-/);

    fs.mkdirSync(sibling);
    fs.writeFileSync(path.join(sibling, 'keep.txt'), 'not owned by either run');
    fs.writeFileSync(path.join(second.root, 'keep.txt'), 'second run');

    first.cleanup();

    assert.equal(fs.existsSync(first.root), false);
    assert.equal(fs.readFileSync(path.join(second.root, 'keep.txt'), 'utf8'), 'second run');
    assert.equal(fs.readFileSync(path.join(sibling, 'keep.txt'), 'utf8'), 'not owned by either run');
  } finally {
    first.cleanup();
    second.cleanup();
    fs.rmSync(sibling, { recursive: true, force: true });
  }
});

test('remote WSL harness never cleans or writes host mount roots', () => {
  const source = fs.readFileSync(harnessPath, 'utf8');

  assert.match(source, /createRemoteWslSandbox/);
  assert.doesNotMatch(source, /\/mnt\//);
  assert.doesNotMatch(source, /fs\.rmSync\(\s*["'`]\/mnt\//);
  assert.doesNotMatch(source, /fs\.mkdirSync\(\s*["'`]\/mnt\//);
  assert.doesNotMatch(source, /\/mnt\/test-perm-check/);
});
