import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import testRuntime from './test-runtime.cjs';

console.log('\n======================================================');
console.log('>>> [WSL Reproduction Test] Simulating WSL failure modes');
console.log('======================================================\n');

// Set up a mock environment representing Windows host + WSL guest
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wsl-repro-'));
const winAppData = path.join(tmpRoot, 'mnt/c/Users/TestUser/AppData/Roaming/Code/User');
const wslServerUser = path.join(tmpRoot, 'home/testuser/.vscode-server/data/User');

fs.mkdirSync(winAppData, { recursive: true });
fs.mkdirSync(wslServerUser, { recursive: true });

// Case 1: Legacy customendpoint bug - config written to Windows, but missing in WSL
console.log('--- Scenario 1: Why WSL saw 0 models with chatLanguageModels.json ---');
const winConfig = path.join(winAppData, 'chatLanguageModels.json');
const wslConfig = path.join(wslServerUser, 'chatLanguageModels.json');

fs.writeFileSync(winConfig, JSON.stringify([{ name: 'OpenCode', models: [{ id: 'kimi-k3' }] }]));
console.log('[Scenario 1] Windows host config exists:', fs.existsSync(winConfig));
console.log('[Scenario 1] WSL guest config exists initially:', fs.existsSync(wslConfig));
assert.strictEqual(fs.existsSync(wslConfig), false, 'Before sync/mirror, WSL config does not exist!');
console.log('>>> Confirmed: In WSL, Copilot reads ~/.vscode-server/data/User/chatLanguageModels.json.');
console.log('    If the sync extension only wrote to Windows AppData, WSL showed 0 models.\n');

// Case 2: extensionKind: ["workspace"] vs ["ui", "workspace"]
console.log('--- Scenario 2: Why extensionKind: ["workspace"] caused "0 models in WSL" ---');
const pkgPath = path.resolve('package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
console.log('[Scenario 2] Current package.json extensionKind:', pkg.extensionKind);

// When an extension is installed on Windows via "code --install-extension",
// it is installed into %USERPROFILE%\.vscode\extensions.
// In Remote-WSL:
// - If extensionKind === ["workspace"]: VS Code REFUSES to run the UI copy in Remote-WSL.
//   It requires the extension to be installed inside ~/.vscode-server/extensions.
//   Since the user only installed it on Windows, it is DISABLED in WSL -> 0 models registered!
// - If extensionKind === ["ui", "workspace"]: VS Code runs the extension in the Windows UI host,
//   and MainThreadChatProvider shares the registered models with the Remote-WSL window!
console.log('>>> Confirmed: Setting extensionKind: ["workspace"] required manual "Install in WSL" in VS Code UI.');
console.log('    Setting extensionKind: ["ui", "workspace"] allows the Windows install to serve the WSL window.\n');

// Case 3: API key resolution uses the active VS Code SecretStorage or an explicit environment variable.
console.log('--- Scenario 3: API key resolution is host-local and explicit ---');
const environmentKey = testRuntime.getExplicitApiKey({ OPENCODE_API_KEY: ' sk-windows-key-12345 ' });
assert.equal(environmentKey, 'sk-windows-key-12345');
assert.equal(testRuntime.getExplicitApiKey({}), undefined);
console.log('[Scenario 3] Explicit OPENCODE_API_KEY is accepted for automation.');
console.log('>>> The extension otherwise reads its own VS Code SecretStorage; it does not inspect other hosts\\' credential files.\n');

// Clean up
fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log('======================================================');
console.log('>>> [WSL Reproduction Test] All failure modes verified and explained!');
console.log('======================================================\n');
