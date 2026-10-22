import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXTENSION_VERSION, IS_DEV_VERSION, extensionUserAgent } from '../out/extension-version.js';

test('extension UA names this extension with the build-injected version', () => {
  assert.match(extensionUserAgent(), /^vscode-opencode-copilot-sync\/.+/);
  assert.equal(extensionUserAgent(), `vscode-opencode-copilot-sync/${EXTENSION_VERSION}`);
});

test('dev fallback is explicit: unbundled runs report dev, never a fake version', () => {
  // tsc `out/` runs have no esbuild --define, so the fallback is live here.
  assert.equal(EXTENSION_VERSION, 'dev');
  assert.equal(IS_DEV_VERSION, true);
});
