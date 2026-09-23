import fs from 'node:fs';
import * as path from 'node:path';
import {
  mergeOpenCodeProviderForTarget,
  purgeOpenCodeFromChatLanguageModels,
  redactOpenCodeApiKeys,
  type OpenCodeTargetMergeResult,
  type ProviderEntry,
} from './config.js';
import {
  discoverSyncTargets,
  getChatLanguageModelsPath,
  resolveAssociatedWslHome,
  sameSyncTargetPath,
  type SyncTarget,
  type SyncTargetDiscoveryContext,
} from './sync-targets.js';
import { createBackup, readChatLanguageModels, safeWriteFileSync } from './sync-files.js';

export interface WriteProvidersOptions {
  remoteName?: string;
  additionalTargetPaths?: readonly string[];
  associatedWslHome?: string;
  discoveryContext?: Partial<SyncTargetDiscoveryContext>;
}

export interface WriteProvidersResult {
  targetPath: string;
  backupPath: string | null;
  warnings: string[];
  writtenPaths: string[];
}

interface WriteTargetPlan {
  primaryPath: string;
  paths: string[];
  warnings: string[];
}

function normalizedPaths(paths: readonly string[], platform: NodeJS.Platform): string[] {
  const pathOps = platform === 'win32' ? path.win32 : path.posix;
  const seen = new Set<string>();
  const result: string[] = [];

  for (const filePath of paths) {
    const normalized = pathOps.normalize(filePath);
    const key = platform === 'win32' ? normalized.toLowerCase() : normalized;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(normalized);
    }
  }

  return result;
}

function validateAdditionalTargetPaths(paths: readonly string[], platform: NodeJS.Platform): void {
  const pathOps = platform === 'win32' ? path.win32 : path.posix;
  for (const targetPath of paths) {
    if (
      typeof targetPath !== 'string' ||
      !pathOps.isAbsolute(targetPath) ||
      pathOps.basename(targetPath) !== 'chatLanguageModels.json'
    ) {
      throw new Error('Additional sync targets must be absolute chatLanguageModels.json paths.');
    }
  }
}

function isPathWithin(root: string, candidate: string, platform: NodeJS.Platform): boolean {
  const pathOps = platform === 'win32' ? path.win32 : path.posix;
  const relative = pathOps.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${pathOps.sep}`) && !pathOps.isAbsolute(relative));
}

function readRaw(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return '';
  }
}

function createSafeConfigBackup(filePath: string, existingConfig: unknown[]): string | null {
  const redacted = redactOpenCodeApiKeys(existingConfig);
  const backupContent =
    JSON.stringify(redacted) === JSON.stringify(existingConfig)
      ? undefined
      : JSON.stringify(redacted, null, 4);
  return createBackup(filePath, backupContent);
}

function mergeForTarget(
  existingConfig: unknown[],
  providers: ProviderEntry[],
  isPrimary: boolean
): OpenCodeTargetMergeResult {
  if (isPrimary) {
    return { status: 'updated', config: purgeOpenCodeFromChatLanguageModels(existingConfig) };
  }

  const openCodeProvider = providers.find((provider) => provider.name === 'OpenCode');
  if (!openCodeProvider) {
    return {
      status: 'skipped',
      config: existingConfig,
      warning: 'No unified OpenCode provider was supplied for this compatibility mirror.',
    };
  }

  return mergeOpenCodeProviderForTarget(existingConfig, openCodeProvider);
}

type PreparedTargetWrite =
  | { status: 'updated'; existingConfig: unknown[]; mergedConfig: unknown[] }
  | { status: 'skipped'; warning: string };

interface TargetWriteOutcome {
  written: boolean;
  backupPath: string | null;
  warning?: string;
}

function prepareTargetWrite(
  filePath: string,
  providers: ProviderEntry[],
  isPrimary: boolean
): PreparedTargetWrite {
  const beforeRaw = readRaw(filePath);
  let existingConfig = readChatLanguageModels(filePath);
  let mergeResult = mergeForTarget(existingConfig, providers, isPrimary);

  if (mergeResult.status === 'skipped') {
    return { status: 'skipped', warning: `${filePath}: ${mergeResult.warning}` };
  }

  // Re-read once if another VS Code window updated this file during our merge.
  if (readRaw(filePath) !== beforeRaw) {
    existingConfig = readChatLanguageModels(filePath);
    mergeResult = mergeForTarget(existingConfig, providers, isPrimary);
    if (mergeResult.status === 'skipped') {
      return { status: 'skipped', warning: `${filePath}: ${mergeResult.warning}` };
    }
  }

  return {
    status: 'updated',
    existingConfig,
    mergedConfig: mergeResult.config,
  };
}

function writeTargetConfig(
  providers: ProviderEntry[],
  filePath: string,
  isPrimary: boolean
): TargetWriteOutcome {
  try {
    const prepared = prepareTargetWrite(filePath, providers, isPrimary);
    if (prepared.status === 'skipped') {
      return { written: false, backupPath: null, warning: prepared.warning };
    }
    if (JSON.stringify(prepared.mergedConfig) === JSON.stringify(prepared.existingConfig)) {
      return { written: false, backupPath: null };
    }

    const backupPath = createSafeConfigBackup(filePath, prepared.existingConfig);
    safeWriteFileSync(filePath, JSON.stringify(prepared.mergedConfig, null, 4));
    return { written: true, backupPath };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isPrimary) {
      throw new Error(`Failed to update the primary OpenCode configuration at ${filePath}: ${message}`);
    }
    return {
      written: false,
      backupPath: null,
      warning: `Failed to update compatibility mirror ${filePath}: ${message}`,
    };
  }
}

export function writeProvidersToTargets(
  providers: ProviderEntry[],
  targetPaths: readonly string[],
  primaryPath: string,
  initialWarnings: readonly string[] = [],
  platform: NodeJS.Platform = process.platform
): Omit<WriteProvidersResult, 'targetPath'> {
  validateAdditionalTargetPaths(targetPaths, platform);
  const warnings = [...initialWarnings];
  const writtenPaths: string[] = [];
  let backupPath: string | null = null;

  for (const filePath of targetPaths) {
    const isPrimary = sameSyncTargetPath(filePath, primaryPath, platform);
    const outcome = writeTargetConfig(providers, filePath, isPrimary);
    if (outcome.warning) warnings.push(outcome.warning);
    if (outcome.written) writtenPaths.push(filePath);
    if (isPrimary) backupPath = outcome.backupPath;
  }

  return { backupPath, warnings, writtenPaths };
}

export function syncWslMirror(
  providers: ProviderEntry[],
  targetPaths: readonly string[],
  primaryPath: string,
  initialWarnings: readonly string[] = [],
  platform: NodeJS.Platform = process.platform
): Omit<WriteProvidersResult, 'targetPath'> {
  return writeProvidersToTargets(
    providers,
    targetPaths.filter((targetPath) => !sameSyncTargetPath(targetPath, primaryPath, platform)),
    primaryPath,
    initialWarnings,
    platform
  );
}

interface ResolvedWriteContext {
  platform: NodeJS.Platform;
  additionalTargetPaths: readonly string[];
  associatedWsl: ReturnType<typeof resolveAssociatedWslHome>;
  discoveryContext: SyncTargetDiscoveryContext;
  primaryPath: string;
}

function resolveWriteContext(
  storagePath: string | undefined,
  options: WriteProvidersOptions
): ResolvedWriteContext {
  const context = options.discoveryContext ?? {};
  const platform = context.platform ?? process.platform;
  const additionalTargetPaths = options.additionalTargetPaths ?? context.additionalTargetPaths ?? [];
  validateAdditionalTargetPaths(additionalTargetPaths, platform);

  const associatedWslHome =
    options.associatedWslHome ?? context.associatedWslHome;
  const associatedWsl = associatedWslHome
    ? { status: 'resolved' as const, homeDir: associatedWslHome }
    : resolveAssociatedWslHome(options.remoteName);
  const resolvedWslHome =
    associatedWsl.status === 'resolved' ? associatedWsl.homeDir : undefined;
  const discoveryContext: SyncTargetDiscoveryContext = {
    ...context,
    activeExtensionStoragePath: storagePath ?? context.activeExtensionStoragePath,
    associatedWslHome: resolvedWslHome,
    additionalTargetPaths,
  };
  const primaryPath = getChatLanguageModelsPath(discoveryContext.activeExtensionStoragePath, discoveryContext);
  return { platform, additionalTargetPaths, associatedWsl, discoveryContext, primaryPath };
}

function resolveWritePaths(
  targetPath: string | undefined,
  additionalTargetPaths: readonly string[],
  discoveryContext: SyncTargetDiscoveryContext,
  platform: NodeJS.Platform
): { paths: string[]; discoveredTargets: SyncTarget[] | undefined } {
  const discoveredTargets = targetPath ? undefined : discoverSyncTargets(discoveryContext);
  const targetPaths = targetPath
    ? normalizedPaths([targetPath, ...additionalTargetPaths], platform)
    : (discoveredTargets ?? []).map((target) => target.path);
  return { paths: normalizedPaths(targetPaths, platform), discoveredTargets };
}

function getWriteTargetWarnings(
  targetPath: string | undefined,
  additionalTargetPaths: readonly string[],
  discoveredTargets: SyncTarget[] | undefined,
  associatedWsl: ReturnType<typeof resolveAssociatedWslHome>,
  platform: NodeJS.Platform
): string[] {
  const warnings = associatedWsl.status === 'warning' ? [associatedWsl.warning] : [];
  const associatedWslHomePath =
    associatedWsl.status === 'resolved' ? associatedWsl.homeDir : undefined;
  const explicitlyTargetingAssociatedWsl = associatedWslHomePath
    ? additionalTargetPaths.some((additionalPath) => isPathWithin(associatedWslHomePath, additionalPath, platform))
    : false;
  const hasAssociatedTarget =
    Boolean(discoveredTargets?.some((target) => target.source === 'associated-wsl')) ||
    explicitlyTargetingAssociatedWsl;
  if (!targetPath && associatedWslHomePath && !hasAssociatedTarget) {
    warnings.push(
      `No existing VS Code profile was found under the associated WSL home "${associatedWslHomePath}". Open that distro in VS Code or add its exact chatLanguageModels.json path to opencode.additionalSyncTargets.`
    );
  }
  return warnings;
}

function createWriteTargetPlan(
  targetPath?: string,
  storagePath?: string,
  options: WriteProvidersOptions = {}
): WriteTargetPlan {
  const context = resolveWriteContext(storagePath, options);
  if (targetPath) validateAdditionalTargetPaths([targetPath], context.platform);
  const { paths, discoveredTargets } = resolveWritePaths(
    targetPath,
    context.additionalTargetPaths,
    context.discoveryContext,
    context.platform
  );
  return {
    primaryPath: context.primaryPath,
    paths,
    warnings: getWriteTargetWarnings(
      targetPath,
      context.additionalTargetPaths,
      discoveredTargets,
      context.associatedWsl,
      context.platform
    ),
  };
}

export function writeProvidersToConfig(
  providers: ProviderEntry[],
  targetPath?: string,
  storagePath?: string,
  options: WriteProvidersOptions = {}
): WriteProvidersResult {
  const plan = createWriteTargetPlan(targetPath, storagePath, options);
  const result = writeProvidersToTargets(providers, plan.paths, plan.primaryPath, plan.warnings, options.discoveryContext?.platform ?? process.platform);
  return {
    targetPath: plan.paths[0] ?? plan.primaryPath,
    backupPath: result.backupPath,
    warnings: result.warnings,
    writtenPaths: result.writtenPaths,
  };
}

function cleanupLegacyFile(filePath: string): boolean {
  if (!fs.existsSync(filePath)) return false;
  const existing = readChatLanguageModels(filePath);
  const purged = purgeOpenCodeFromChatLanguageModels(existing);
  if (purged.length === existing.length) return false;
  createSafeConfigBackup(filePath, existing);
  safeWriteFileSync(filePath, JSON.stringify(purged, null, 4));
  return true;
}

export function cleanupLegacyOpenCodeCustomEndpoints(
  storagePath?: string,
  options: Pick<WriteProvidersOptions, 'remoteName' | 'additionalTargetPaths' | 'associatedWslHome' | 'discoveryContext'> = {}
): string[] {
  const plan = createWriteTargetPlan(undefined, storagePath, options);
  const cleaned: string[] = [];

  for (const warning of plan.warnings) {
    console.warn(`[Legacy sync cleanup] ${warning}`);
  }

  for (const filePath of plan.paths) {
    try {
      if (cleanupLegacyFile(filePath)) cleaned.push(filePath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed cleaning legacy customendpoints in ${filePath}: ${message}`);
    }
  }

  return cleaned;
}
