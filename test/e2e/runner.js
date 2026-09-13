import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTests } from '@vscode/test-electron';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  try {
    const extensionDevelopmentPath = path.resolve(__dirname, '../../');
    const extensionTestsPath = path.resolve(__dirname, './suite.cjs');

    console.log('[E2E Runner] Starting VS Code integration test...');
    console.log('[E2E Runner] Extension path:', extensionDevelopmentPath);
    console.log('[E2E Runner] Tests path:', extensionTestsPath);

    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [
        '--disable-gpu',
        '--disable-workspace-trust',
        '--disable-telemetry',
        '--user-data-dir=' + path.resolve(__dirname, '../../.test-user-data'),
      ],
    });

    console.log('[E2E Runner] Tests completed successfully!');
  } catch (err) {
    console.error('[E2E Runner] Failed to run tests:', err);
    process.exit(1);
  }
}

main();
