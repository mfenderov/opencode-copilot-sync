#!/usr/bin/env node
// CRAP (Change Risk Anti-Pattern) score report.
//
// CRAP(m) = complexity(m)^2 * (1 - coverage(m))^3 + complexity(m)
//
// Combines two signals we already generate:
//   - per-function cyclomatic complexity, from ESLint's own `complexity` rule
//     (run here with threshold 0 so every function reports its real number)
//   - per-function statement coverage, from c8's Istanbul-format
//     `coverage/coverage-final.json` (produced by `npm run test:coverage`)
//
// Usage:
//   node scripts/crap-report.mjs                 print report, gate against crap-baseline.json
//   node scripts/crap-report.mjs --update-baseline   regenerate crap-baseline.json from current code
//   node scripts/crap-report.mjs --threshold=10      override the CRAP gate threshold (default 10)

import { ESLint } from 'eslint';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const COVERAGE_FILE = path.join(ROOT, 'coverage', 'coverage-final.json');
const BASELINE_FILE = path.join(ROOT, 'crap-baseline.json');

const args = process.argv.slice(2);
const updateBaseline = args.includes('--update-baseline');
const thresholdArg = args.find((a) => a.startsWith('--threshold='));
const THRESHOLD = thresholdArg ? Number(thresholdArg.split('=')[1]) : 10;

// Coverage percentages for functions sitting right at 100% are not perfectly
// reproducible across Node/V8 versions: different major versions instrument
// optional chaining, logical assignment, etc. as slightly different branch
// counts, which can shift a function a percent or two either side of "fully
// covered". A tiny relative tolerance absorbs that noise without letting real
// regressions (complexity growth or a real coverage drop) slip through, since
// those move CRAP by far more than 5%.
const GRANDFATHER_TOLERANCE = 0.05;

function crapScore(complexity, coverageFraction) {
  return complexity ** 2 * (1 - coverageFraction) ** 3 + complexity;
}

// Extracts a readable function label from the complexity rule's message text,
// e.g. "Function 'foo' has a complexity of 5..." -> "foo", "Arrow function has..." -> "<anonymous>".
function parseComplexity(message) {
  const named = message.match(/'([^']+)' has a complexity of (\d+)/);
  if (named) return { name: named[1], complexity: Number(named[2]) };
  const anon = message.match(/has a complexity of (\d+)/);
  return { name: '<anonymous>', complexity: anon ? Number(anon[1]) : 0 };
}

// Finds the innermost coverage-tracked function whose source range contains `line`,
// so nested/inline functions (e.g. arrow callbacks) inherit their enclosing
// tracked function's coverage as a reasonable approximation.
function findEnclosingFunction(fileCoverage, line) {
  let best = null;
  for (const [id, fn] of Object.entries(fileCoverage.fnMap)) {
    if (line < fn.loc.start.line || line > fn.loc.end.line) continue;
    const span = fn.loc.end.line - fn.loc.start.line;
    if (!best || span < best.span) best = { id, fn, span };
  }
  return best;
}

// % of statements within [startLine, endLine] that were hit at least once.
function statementCoverage(fileCoverage, startLine, endLine) {
  let covered = 0;
  let total = 0;
  for (const [id, stmt] of Object.entries(fileCoverage.statementMap)) {
    if (stmt.start.line < startLine || stmt.start.line > endLine) continue;
    total += 1;
    if (fileCoverage.s[id] > 0) covered += 1;
  }
  return total === 0 ? null : covered / total;
}

async function collectFunctions() {
  const eslint = new ESLint({
    cwd: ROOT,
    overrideConfig: { rules: { complexity: ['error', 0] } },
  });
  const results = await eslint.lintFiles(['src/**/*.ts']);

  let coverage = {};
  if (fs.existsSync(COVERAGE_FILE)) {
    coverage = JSON.parse(fs.readFileSync(COVERAGE_FILE, 'utf8'));
  }

  const functions = [];
  for (const result of results) {
    const relPath = path.relative(ROOT, result.filePath);
    const fileCoverage = coverage[result.filePath];

    for (const msg of result.messages) {
      if (msg.ruleId !== 'complexity') continue;
      const { name, complexity } = parseComplexity(msg.message);

      let coverageFraction = 0; // no coverage data at all (e.g. extension.ts, never required by unit tests) => treat as uncovered
      if (fileCoverage) {
        const enclosing = findEnclosingFunction(fileCoverage, msg.line);
        if (enclosing) {
          const pct = statementCoverage(fileCoverage, enclosing.fn.loc.start.line, enclosing.fn.loc.end.line);
          coverageFraction = pct ?? (fileCoverage.f[enclosing.id] > 0 ? 1 : 0);
        }
      }

      functions.push({
        id: `${relPath}:${msg.line}:${name}`,
        file: relPath,
        line: msg.line,
        name,
        complexity,
        coverage: Math.round(coverageFraction * 1000) / 1000,
        crap: Math.round(crapScore(complexity, coverageFraction) * 100) / 100,
      });
    }
  }
  return functions.sort((a, b) => b.crap - a.crap);
}

function loadBaseline() {
  if (!fs.existsSync(BASELINE_FILE)) return {};
  return JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'));
}

function printTable(functions) {
  const offenders = functions.filter((f) => f.crap >= THRESHOLD);
  console.log(`\nCRAP report: ${functions.length} functions analyzed, ${offenders.length} at or above threshold (${THRESHOLD})\n`);
  if (offenders.length > 0) {
    console.log('CRAP    complexity  coverage  location');
    for (const f of offenders) {
      console.log(
        `${String(f.crap).padEnd(8)}${String(f.complexity).padEnd(12)}${`${Math.round(f.coverage * 100)}%`.padEnd(10)}${f.file}:${f.line} ${f.name}`
      );
    }
  }
}

async function main() {
  const functions = await collectFunctions();
  const offenders = functions.filter((f) => f.crap >= THRESHOLD);

  if (updateBaseline) {
    const baseline = Object.fromEntries(offenders.map((f) => [f.id, { crap: f.crap, complexity: f.complexity, coverage: f.coverage }]));
    fs.writeFileSync(BASELINE_FILE, JSON.stringify(baseline, null, 2) + '\n');
    console.log(`Wrote ${offenders.length} grandfathered function(s) to ${path.relative(ROOT, BASELINE_FILE)}`);
    return;
  }

  printTable(functions);

  const baseline = loadBaseline();
  const failures = offenders.filter((f) => {
    const grandfathered = baseline[f.id];
    if (!grandfathered) return true; // New offender: fail the gate.
    // Existing offender that got worse beyond the cross-environment noise
    // tolerance: fail the gate.
    return f.crap > grandfathered.crap * (1 + GRANDFATHER_TOLERANCE);
  });

  if (failures.length > 0) {
    console.error(`\n✖ ${failures.length} function(s) exceed CRAP threshold (${THRESHOLD}) and are not grandfathered (or got worse):`);
    for (const f of failures) {
      console.error(`  ${f.file}:${f.line} ${f.name} (CRAP ${f.crap})`);
    }
    process.exitCode = 1;
    return;
  }

  console.log('\n✔ CRAP gate passed (all offenders are grandfathered in crap-baseline.json at or below their baseline score)');
}

main();
