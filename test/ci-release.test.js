import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';

const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const releasePreparation = workflow.split('\n  release:\n')[1].split('      - name: Record latest tag')[0];
const preparationScript = [...releasePreparation.matchAll(/^        run: \|\r?\n((?:          .*\r?\n)+)/gm)]
  .map((match) => match[1].replace(/^          /gm, ''))
  .join('\n');

function setupRepositories(t) {
  const root = mkdtempSync(join(tmpdir(), 'ci-release-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const remote = join(root, 'remote.git');
  const producer = join(root, 'producer');
  const release = join(root, 'release');
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
  function git(cwd, ...args) {
    return execFileSync('git', [
      ...(cwd === remote ? ['--git-dir', remote] : []),
      '-c', 'user.name=CI Test',
      '-c', 'user.email=ci-test@example.invalid',
      '-c', 'commit.gpgsign=false',
      ...args,
    ], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  }
  git(root, 'init', '--bare', '--initial-branch=main', remote);
  git(root, 'init', '--initial-branch=main', producer);
  writeFileSync(join(producer, 'badge.svg'), 'original badge\n');
  writeFileSync(join(producer, 'version.txt'), '0.18.10\n');
  git(producer, 'add', '.');
  git(producer, 'commit', '-m', 'fix: initial release');
  git(producer, 'remote', 'add', 'origin', remote);
  git(producer, 'push', 'origin', 'main');
  git(root, 'clone', remote, release);
  return { remote, producer, release, env, git };
}

for (const refreshBadge of [false, true]) {
  test(`CI release: publishes without losing history ${refreshBadge ? 'after a badge refresh' : 'when main is unchanged'}`, (t) => {
    const { remote, producer, release, env, git } = setupRepositories(t);
    if (refreshBadge) {
      writeFileSync(join(producer, 'badge.svg'), 'refreshed badge\n');
      git(producer, 'commit', '-am', 'chore(badge): refresh badge [skip ci]');
      git(producer, 'push', 'origin', 'main');
    }
    const remoteHead = git(remote, 'rev-parse', 'main');
    const preparation = spawnSync('bash', ['-e', '-c', preparationScript], {
      cwd: release, env, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(preparation.status, 0, preparation.stderr);

    writeFileSync(join(release, 'version.txt'), '0.18.11\n');
    git(release, 'commit', '-am', 'chore: release v0.18.11');
    git(release, 'tag', 'v0.18.11');
    assert.doesNotThrow(() => git(release, 'push', 'origin', 'main'), 'version push must include the latest main commit');
    git(release, 'push', 'origin', 'v0.18.11');

    assert.equal(git(remote, 'show', 'v0.18.11:version.txt'), '0.18.11');
    assert.equal(git(remote, 'show', 'v0.18.11:badge.svg'), refreshBadge ? 'refreshed badge' : 'original badge');
    assert.equal(git(remote, 'rev-parse', 'main'), git(remote, 'rev-parse', 'v0.18.11'));
    git(remote, 'merge-base', '--is-ancestor', remoteHead, 'main');
  });
}

test('CI release: stops before versioning when main has diverged', (t) => {
  const { remote, producer, release, env, git } = setupRepositories(t);
  writeFileSync(join(producer, 'badge.svg'), 'refreshed badge\n');
  git(producer, 'commit', '-am', 'chore(badge): refresh badge [skip ci]');
  git(producer, 'push', 'origin', 'main');
  writeFileSync(join(release, 'version.txt'), 'unpublished change\n');
  git(release, 'commit', '-am', 'chore: divergent local change');
  const releaseHead = git(release, 'rev-parse', 'HEAD');
  const remoteHead = git(remote, 'rev-parse', 'main');

  const preparation = spawnSync('bash', ['-e', '-c', preparationScript], {
    cwd: release, env, encoding: 'utf8', timeout: 10000,
  });
  assert.ok(preparation.status > 0, 'diverged history must fail rather than be merged or overwritten');
  assert.equal(git(release, 'rev-parse', 'HEAD'), releaseHead);
  assert.equal(git(remote, 'rev-parse', 'main'), remoteHead);
});
