import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTests } from '@vscode/test-electron';
import testRuntime from '../../scripts/test-runtime.cjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { applyOfflineTestEnvironment, createIsolatedTestRoot } = testRuntime;

// Insiders + proposed-API harness for the chatSessions spike. Points the
// Electron test host at the locally installed Insiders build and enables the
// chatSessionsProvider proposal, so suite-chatsessions.cjs runs against the
// REAL vscode.chat.createChatSessionItemController (not the unit mock).
async function main() {
  applyOfflineTestEnvironment();
  if (!process.env.CI) process.env.CI = '1';
  const testUserData = createIsolatedTestRoot('opencode-vscode-chatsessions-');

  try {
    const extensionDevelopmentPath = path.resolve(__dirname, '../../');
    const extensionTestsPath = path.resolve(__dirname, './suite-chatsessions.cjs');
    const vscodeExecutablePath =
      '/Applications/Visual Studio Code - Insiders.app/Contents/MacOS/Code - Insiders';

    console.log('[chatSessions E2E] Starting Insiders integration test...');
    console.log('[chatSessions E2E] Executable:', vscodeExecutablePath);
    console.log('[chatSessions E2E] Extension path:', extensionDevelopmentPath);

    await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [
        '--disable-gpu',
        '--disable-workspace-trust',
        '--disable-telemetry',
        '--sync',
        'off',
        '--enable-proposed-api',
        'mfenderov.opencode-copilot-sync',
        `--user-data-dir=${testUserData.root}`,
        `--extensions-dir=${testUserData.root}/extensions`,
      ],
    });

    console.log('[chatSessions E2E] Tests completed successfully!');
  } catch (err) {
    console.error('[chatSessions E2E] Failed to run tests:', err);
    process.exitCode = 1;
  } finally {
    testUserData.cleanup();
  }
}

main();
