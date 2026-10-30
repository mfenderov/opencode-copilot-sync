import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EXTENSION_VERSION, IS_DEV_VERSION, extensionUserAgent } from '../out/extension-version.js';

test('the extension remains installable on the previously supported VS Code 1.125 release', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.engines.vscode, '^1.125.0');
});

test('extension UA names this extension with the build-injected version', () => {
  assert.match(extensionUserAgent(), /^vscode-opencode-copilot-sync\/.+/);
  assert.equal(extensionUserAgent(), `vscode-opencode-copilot-sync/${EXTENSION_VERSION}`);
});

test('dev fallback is explicit: unbundled runs report dev, never a fake version', () => {
  // tsc `out/` runs have no esbuild --define, so the fallback is live here.
  assert.equal(EXTENSION_VERSION, 'dev');
  assert.equal(IS_DEV_VERSION, true);
});
