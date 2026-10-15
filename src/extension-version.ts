// Build-injected extension version (single source of truth for our User-Agent).
//
// The release build (scripts/build.mjs) defines `__EXTENSION_VERSION__` from
// package.json via esbuild `--define`, so the shipped bundle always carries
// the tagged version. Unbundled runs (tsc `out/` used by tests) fall back to
// 'dev'.
declare const __EXTENSION_VERSION__: string | undefined;

/** Either a build-injected `major.minor.patch` or the unbundled-run fallback. */
export type ExtensionVersion = `${number}.${number}.${number}` | 'dev';

export const EXTENSION_VERSION: ExtensionVersion =
  typeof __EXTENSION_VERSION__ !== 'undefined'
    ? (__EXTENSION_VERSION__ as ExtensionVersion)
    : 'dev';

/** True when running unbundled (tsc `out/`, tests) without the build define.
 * Consumers must never treat a `dev` UA as a release version. */
export const IS_DEV_VERSION: boolean = EXTENSION_VERSION === 'dev';

export function extensionUserAgent(): string {
  return `vscode-opencode-copilot-sync/${EXTENSION_VERSION}`;
}
