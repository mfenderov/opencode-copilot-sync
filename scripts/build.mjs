#!/usr/bin/env node
// Build: bundle the extension with the package version injected as
// `__EXTENSION_VERSION__`, so the shipped User-Agent always carries the
// tagged release version (see src/extension-version.ts).
import { buildSync } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = String(pkg.version ?? 'dev');

// In-process esbuild (no child process): `npx` is a `.cmd` shim on Windows
// that execFileSync cannot resolve, so spawning it breaks `npm run package`
// there. The JS API is identical on every platform.
buildSync({
  entryPoints: [path.join(root, 'src', 'extension.ts')],
  bundle: true,
  outfile: path.join(root, 'dist', 'extension.cjs'),
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  define: { __EXTENSION_VERSION__: JSON.stringify(version) },
  absWorkingDir: root,
});
