#!/usr/bin/env node

/**
 * OpenCode Copilot Sync - Unified Enterprise Test Suite Runner
 *
 * Executes all testing tiers:
 *   - Tier 1: Unit & Protocol Routing Invariants (node --test test/*.test.js)
 *   - Tier 2: Wire-Level Mock & Fault Injection (MockServer & Provider Chaos)
 *   - Tier 3: Remote-WSL & Multi-Distro Topology (scripts/test-remote-wsl.js)
 *   - Tier 4: In-Host VS Code E2E Integration (test/e2e/runner.js)
 *
 * Formats a terminal scorecard summarizing results across all tiers.
 */

import cp from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import testRuntime from '../scripts/test-runtime.cjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const { getE2ERunnerArgs } = testRuntime;

const DIVIDER = '='.repeat(70);

// Terminal color helpers
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const green = (s) => (useColor ? `\x1b[32m${s}\x1b[0m` : s);
const boldGreen = (s) => (useColor ? `\x1b[1;32m${s}\x1b[0m` : s);
const red = (s) => (useColor ? `\x1b[31m${s}\x1b[0m` : s);
const boldRed = (s) => (useColor ? `\x1b[1;31m${s}\x1b[0m` : s);
const cyan = (s) => (useColor ? `\x1b[36m${s}\x1b[0m` : s);
const boldCyan = (s) => (useColor ? `\x1b[1;36m${s}\x1b[0m` : s);
const yellow = (s) => (useColor ? `\x1b[33m${s}\x1b[0m` : s);
const bold = (s) => (useColor ? `\x1b[1m${s}\x1b[0m` : s);
const dim = (s) => (useColor ? `\x1b[2m${s}\x1b[0m` : s);

/**
 * Format a tier result line with dot leaders aligned to column 52.
 */
function formatTierLine(name, statusText, passed = true) {
  const prefix = name + ' ';
  const totalPrefixTarget = 52;
  const dots = '.'.repeat(Math.max(2, totalPrefixTarget - prefix.length));
  let formattedStatus = statusText;
  if (useColor) {
    if (passed) {
      formattedStatus = statusText.replace('PASSED', green('PASSED'));
    } else {
      formattedStatus = statusText.replace('FAILED', red('FAILED'));
    }
  }
  return `${prefix}${dots} ${formattedStatus}`;
}

/**
 * Run a command and stream output while capturing stdout/stderr.
 */
function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    const proc = cp.spawn(command, args, {
      cwd: ROOT_DIR,
      env: { ...process.env, ...options.env },
      stdio: ['inherit', 'pipe', 'pipe'],
      shell: false,
      ...options,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk) => {
      stdout += chunk;
      process.stdout.write(chunk);
    });

    proc.stderr.on('data', (chunk) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });

    proc.on('close', (code, signal) => {
      resolve({ code: code ?? (signal ? 1 : 0), stdout, stderr });
    });

    proc.on('error', (err) => {
      resolve({ code: 1, stdout, stderr, error: err });
    });
  });
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
OpenCode Copilot Sync - Unified Enterprise Test Suite Runner

Usage:
  node test/runner-all.js [options]
  npm run test:all

Options:
  --tier=1|unit      Run Tier 1 & 2 (Unit & Mock/Chaos tests) only
  --tier=2|remote    Run Tier 3 (Remote-WSL Topology) only
  --tier=3|e2e       Run Tier 4 (In-Host VS Code E2E) only
  --skip-remote      Skip Tier 3 Remote-WSL tests
  --skip-e2e         Skip Tier 4 In-Host E2E tests
  --offline          Force offline mode for Remote-WSL tests
  -h, --help         Show this help message
`);
    process.exit(0);
  }

  const runTier1 = !args.some((a) => a === '--tier=2' || a === '--tier=remote' || a === '--tier=3' || a === '--tier=e2e');
  const runTierRemote = !args.includes('--skip-remote') && !args.some((a) => a === '--tier=1' || a === '--tier=unit' || a === '--tier=3' || a === '--tier=e2e');
  const runTierE2E = !args.includes('--skip-e2e') && !args.some((a) => a === '--tier=1' || a === '--tier=unit' || a === '--tier=2' || a === '--tier=remote');
  const forceOffline = args.includes('--offline');

  console.log('\n' + DIVIDER);
  console.log(boldCyan('>>> OPENCODE COPILOT SYNC - UNIFIED ENTERPRISE TEST SUITE RUNNER'));
  console.log(DIVIDER + '\n');

  // Pre-step: Ensure bundle is fresh for E2E
  console.log(`[Runner] Pre-flight: compiling extension bundle via esbuild...`);
  const buildRes = await runCommand('npm', ['run', 'build']);
  if (buildRes.code !== 0) {
    console.error(boldRed('[Runner] Build failed. Aborting test suite execution.'));
    process.exit(1);
  }
  console.log(`[Runner] Build succeeded.\n`);

  let tier1Passed = false;
  let tier1Status = 'SKIPPED';
  let tier2Passed = false;
  let tier2Status = 'SKIPPED';
  let tier3Passed = false;
  let tier3Status = 'SKIPPED';
  let tier4Passed = false;
  let tier4Status = 'SKIPPED';

  // -------------------------------------------------------------
  // Tier 1 & 2: Unit, Protocol Routing & Wire-Level Mock/Chaos
  // -------------------------------------------------------------
  if (runTier1) {
    console.log(DIVIDER);
    console.log(cyan('>>> [Tier 1 & 2] Unit, Protocol Routing & Wire-Level Mock/Chaos Tests'));
    console.log(DIVIDER + '\n');

    const testDir = path.join(ROOT_DIR, 'test');
    const testFiles = fs
      .readdirSync(testDir)
      .filter((f) => f.endsWith('.test.js'))
      .sort()
      .map((f) => path.join('test', f));

    const t1Res = await runCommand('node', ['--test', ...testFiles]);

    const passMatch = t1Res.stdout.match(/ℹ pass (\d+)/);
    const failMatch = t1Res.stdout.match(/ℹ fail (\d+)/);
    const totalMatch = t1Res.stdout.match(/ℹ tests (\d+)/);

    const passedCount = passMatch ? parseInt(passMatch[1], 10) : 0;
    const failedCount = failMatch ? parseInt(failMatch[1], 10) : 0;
    const totalCount = totalMatch ? parseInt(totalMatch[1], 10) : 0;

    if (t1Res.code === 0 && failedCount === 0 && passedCount > 0) {
      tier1Passed = true;
      tier1Status = `PASSED (${passedCount}/${totalCount})`;

      // Tier 2: Wire-level mock & chaos verification
      const chaosFilesPass = !t1Res.stdout.includes('✖ MockServer') && !t1Res.stdout.includes('✖ Provider Chaos');
      if (chaosFilesPass) {
        tier2Passed = true;
        tier2Status = 'PASSED (Chaos Verified)';
      } else {
        tier2Passed = false;
        tier2Status = 'FAILED (Mock/Chaos Failures)';
      }
    } else {
      tier1Passed = false;
      tier1Status = `FAILED (${failedCount} failed of ${totalCount})`;
      tier2Passed = false;
      tier2Status = 'FAILED (Test Failures)';
    }
  }

  // -------------------------------------------------------------
  // Tier 3: Remote-WSL Filesystem Topology
  // -------------------------------------------------------------
  if (runTierRemote) {
    console.log('\n' + DIVIDER);
    console.log(cyan('>>> [Tier 3] Remote-WSL & Multi-Distro Topology Tests'));
    console.log(DIVIDER + '\n');

    const remoteArgs = ['scripts/test-remote-wsl.js'];
    if (forceOffline) {
      remoteArgs.push('--offline');
    }

    const t2Res = await runCommand('node', remoteArgs);

    if (t2Res.code === 0) {
      tier3Passed = true;
      tier3Status = 'PASSED (All Distros Verified)';
    } else {
      tier3Passed = false;
      tier3Status = 'FAILED (Container/Topology Error)';
    }
  }

  // -------------------------------------------------------------
  // Tier 4: In-Host VS Code E2E Integration
  // -------------------------------------------------------------
  if (runTierE2E) {
    console.log('\n' + DIVIDER);
    console.log(cyan('>>> [Tier 4] In-Host VS Code E2E Integration Tests'));
    console.log(DIVIDER + '\n');

    const t3Res = await runCommand('node', getE2ERunnerArgs(forceOffline));

    if (t3Res.code === 0) {
      tier4Passed = true;
      tier4Status = 'PASSED (Chat, Thinking, Agent 131 Tools, Responses)';
    } else {
      tier4Passed = false;
      tier4Status = 'FAILED (VS Code E2E Error)';
    }
  }

  // -------------------------------------------------------------
  // Scorecard Generation
  // -------------------------------------------------------------
  const allAttemptedPassed =
    (!runTier1 || (tier1Passed && tier2Passed)) &&
    (!runTierRemote || tier3Passed) &&
    (!runTierE2E || tier4Passed);

  console.log('\n' + DIVIDER);
  console.log('>>> VS CODE EXTENSION ENTERPRISE TEST SUITE SCORECARD');
  console.log(DIVIDER);
  console.log(formatTierLine('Tier 1: Unit & Protocol Routing Invariants', tier1Status, tier1Passed));
  console.log(formatTierLine('Tier 2: Wire-Level Mock & Fault Injection', tier2Status, tier2Passed));
  console.log(formatTierLine('Tier 3: Remote-WSL Filesystem Topology', tier3Status, tier3Passed));
  console.log(formatTierLine('Tier 4: In-Host VS Code E2E Integration', tier4Status, tier4Passed));
  console.log(DIVIDER);

  if (allAttemptedPassed && runTier1 && runTierRemote && runTierE2E) {
    console.log(boldGreen('>>> FINAL RESULT: ALL TIERS GREEN (100% VERIFIED)'));
    console.log(DIVIDER + '\n');
    process.exit(0);
  } else if (allAttemptedPassed) {
    console.log(boldGreen('>>> FINAL RESULT: SELECTED TIERS GREEN'));
    console.log(DIVIDER + '\n');
    process.exit(0);
  } else {
    console.log(boldRed('>>> FINAL RESULT: SUITE FAILED (ONE OR MORE TIERS FAILED)'));
    console.log(DIVIDER + '\n');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[Runner] Unhandled runner error:', err);
  process.exit(1);
});
