import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTests } from '@vscode/test-electron';
import testRuntime from '../../scripts/test-runtime.cjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { applyOfflineTestEnvironment, createIsolatedTestRoot } = testRuntime;

async function main() {
  applyOfflineTestEnvironment();
  if (!process.env.CI) process.env.CI = '1';
  const testUserData = createIsolatedTestRoot('oc-e2e-');

  try {
    const extensionDevelopmentPath = path.resolve(__dirname, '../../');
    const extensionTestsPath = path.resolve(__dirname, './registration.cjs');

    console.log('[E2E Runner] Starting VS Code integration test...');
    console.log('[E2E Runner] Extension path:', extensionDevelopmentPath);
    console.log('[E2E Runner] Tests path:', extensionTestsPath);

    await runTests({
      vscodeExecutablePath: process.env.VSCODE_EXECUTABLE_PATH,
      extensionDevelopmentPath,
      extensionTestsPath,
      extensionTestsEnv: {
        OPENCODE_REGISTRATION_TEST_USER_DATA: testUserData.root,
        OPENCODE_OFFLINE: '0',
      },
      launchArgs: [
        '--disable-gpu',
        '--disable-workspace-trust',
        '--disable-telemetry',
        `--user-data-dir=${testUserData.root}`,
      ],
    });

    console.log('[E2E Runner] Tests completed successfully!');
  } catch (err) {
    console.error('[E2E Runner] Failed to run tests:', err);
    process.exitCode = 1;
  } finally {
    testUserData.cleanup();
  }
}

main();
