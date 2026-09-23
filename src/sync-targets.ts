import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface SyncTargetDiscoveryContext {
  platform?: NodeJS.Platform;
  homeDir?: string;
  appDataPath?: string;
  activeExtensionStoragePath?: string;
  associatedWslHome?: string;
  additionalTargetPaths?: readonly string[];
  isWsl?: boolean;
}

export interface SyncTarget {
  path: string;
  source: 'primary' | 'current-user' | 'associated-wsl' | 'explicit';
}

export type AssociatedWslHomeResult =
  | { status: 'not-applicable' }
  | { status: 'resolved'; homeDir: string }
  | { status: 'warning'; warning: string };

export interface AssociatedWslHomeContext {
  platform?: NodeJS.Platform;
  queryHome?: (distro: string) => string;
}

type AssociatedWslDistro = { distro: string } | { warning: string } | undefined;

function pathApi(platform: NodeJS.Platform): typeof path.posix {
  return platform === 'win32' ? path.win32 : path.posix;
}

export function sameSyncTargetPath(
  left: string,
  right: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  const pathOps = pathApi(platform);
  const normalizedLeft = pathOps.resolve(left);
  const normalizedRight = pathOps.resolve(right);
  return platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function isPathInside(root: string, candidate: string, pathOps: typeof path.posix): boolean {
  const relative = pathOps.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${pathOps.sep}`) && !pathOps.isAbsolute(relative));
}

function addTarget(targets: SyncTarget[], filePath: string, source: SyncTarget['source'], platform: NodeJS.Platform): void {
  const normalized = pathApi(platform).normalize(filePath);
  const key = platform === 'win32' ? normalized.toLowerCase() : normalized;
  if (!targets.some((target) => {
    const candidate = pathApi(platform).normalize(target.path);
    return (platform === 'win32' ? candidate.toLowerCase() : candidate) === key;
  })) {
    targets.push({ path: normalized, source });
  }
}

function isWSLProcess(): boolean {
  if (process.platform !== 'linux') return false;
  if (process.env.WSL_DISTRO_NAME) return true;
  try {
    const version = fs.readFileSync('/proc/version', 'utf8');
    return version.toLowerCase().includes('microsoft') || version.toLowerCase().includes('wsl');
  } catch {
    return false;
  }
}

export function isWSL(): boolean {
  return isWSLProcess();
}

function getMacChatLanguageModelsPath(homeDir: string, pathOps: typeof path.posix): string {
  const appSupport = pathOps.join(homeDir, 'Library', 'Application Support');
  const insiders = pathOps.join(appSupport, 'Code - Insiders', 'User', 'chatLanguageModels.json');
  if (
    fs.existsSync(pathOps.dirname(insiders)) &&
    !fs.existsSync(pathOps.join(appSupport, 'Code', 'User'))
  ) {
    return insiders;
  }
  return pathOps.join(appSupport, 'Code', 'User', 'chatLanguageModels.json');
}

function getWindowsChatLanguageModelsPath(
  homeDir: string,
  appDataPath: string | undefined,
  pathOps: typeof path.posix
): string {
  const appData =
    appDataPath ?? process.env.APPDATA ?? pathOps.join(homeDir, 'AppData', 'Roaming');
  return pathOps.join(appData, 'Code', 'User', 'chatLanguageModels.json');
}

function getLinuxChatLanguageModelsPath(
  homeDir: string,
  isWsl: boolean,
  pathOps: typeof path.posix
): string {
  const serverDir = pathOps.join(homeDir, '.vscode-server');
  const serverPath = pathOps.join(serverDir, 'data', 'User', 'chatLanguageModels.json');
  if (fs.existsSync(serverDir) || fs.existsSync(pathOps.dirname(serverPath))) {
    return serverPath;
  }

  const insidersDir = pathOps.join(homeDir, '.vscode-server-insiders');
  const insidersPath = pathOps.join(insidersDir, 'data', 'User', 'chatLanguageModels.json');
  if (fs.existsSync(insidersDir) || fs.existsSync(pathOps.dirname(insidersPath))) {
    return insidersPath;
  }

  if (isWsl) return serverPath;
  return pathOps.join(homeDir, '.config', 'Code', 'User', 'chatLanguageModels.json');
}

export function getChatLanguageModelsPath(
  activeExtensionStoragePath?: string,
  context: Pick<SyncTargetDiscoveryContext, 'platform' | 'homeDir' | 'appDataPath' | 'isWsl'> = {}
): string {
  const platform = context.platform ?? process.platform;
  const pathOps = pathApi(platform);
  const homeDir = context.homeDir ?? os.homedir();

  if (activeExtensionStoragePath) {
    return pathOps.resolve(activeExtensionStoragePath, '..', '..', 'chatLanguageModels.json');
  }

  if (platform === 'darwin') {
    return getMacChatLanguageModelsPath(homeDir, pathOps);
  }

  if (platform === 'win32') {
    return getWindowsChatLanguageModelsPath(homeDir, context.appDataPath, pathOps);
  }

  return getLinuxChatLanguageModelsPath(homeDir, context.isWsl ?? isWSLProcess(), pathOps);
}

interface UserProfileRoot {
  userDir: string;
  machineDir?: string;
}

function profileRootsForHome(
  homeDir: string,
  platform: NodeJS.Platform,
  appDataPath?: string,
  isWslHome = false
): UserProfileRoot[] {
  const pathOps = pathApi(platform);

  if (platform === 'darwin' && !isWslHome) {
    const appSupport = pathOps.join(homeDir, 'Library', 'Application Support');
    return ['Code', 'Code - Insiders'].map((variant) => ({
      userDir: pathOps.join(appSupport, variant, 'User'),
    }));
  }

  if (platform === 'win32' && !isWslHome) {
    const appData = appDataPath ?? process.env.APPDATA ?? pathOps.join(homeDir, 'AppData', 'Roaming');
    return ['Code', 'Code - Insiders'].map((variant) => ({
      userDir: pathOps.join(appData, variant, 'User'),
    }));
  }

  // Associated WSL homes retain Linux profile paths when discovered on Windows.
  return [
    { userDir: pathOps.join(homeDir, '.vscode-server', 'data', 'User'), machineDir: pathOps.join(homeDir, '.vscode-server', 'data', 'Machine') },
    { userDir: pathOps.join(homeDir, '.vscode-server-insiders', 'data', 'User'), machineDir: pathOps.join(homeDir, '.vscode-server-insiders', 'data', 'Machine') },
    { userDir: pathOps.join(homeDir, '.config', 'Code', 'User') },
    { userDir: pathOps.join(homeDir, '.config', 'Code - Insiders', 'User') },
  ];
}

function addProfileRootTargets(
  targets: SyncTarget[],
  root: UserProfileRoot,
  source: 'current-user' | 'associated-wsl',
  primaryPath: string,
  platform: NodeJS.Platform
): void {
  const pathOps = pathApi(platform);
  const userRootExists = fs.existsSync(root.userDir);
  if (userRootExists || isPathInside(root.userDir, primaryPath, pathOps)) {
    addTarget(targets, pathOps.join(root.userDir, 'chatLanguageModels.json'), source, platform);

    const profilesDir = pathOps.join(root.userDir, 'profiles');
    if (fs.existsSync(profilesDir)) {
      for (const profile of fs.readdirSync(profilesDir, { withFileTypes: true })) {
        if (profile.isDirectory()) {
          addTarget(
            targets,
            pathOps.join(profilesDir, profile.name, 'chatLanguageModels.json'),
            source,
            platform
          );
        }
      }
    }
  }

  if (root.machineDir && fs.existsSync(root.machineDir)) {
    addTarget(targets, pathOps.join(root.machineDir, 'chatLanguageModels.json'), source, platform);
  }
}

function addHomeProfileTargets(
  targets: SyncTarget[],
  homeDir: string,
  source: 'current-user' | 'associated-wsl',
  primaryPath: string,
  platform: NodeJS.Platform,
  appDataPath?: string,
  isWslHome = false
): void {
  for (const root of profileRootsForHome(homeDir, platform, appDataPath, isWslHome)) {
    addProfileRootTargets(targets, root, source, primaryPath, platform);
  }
}

function addExplicitTargets(
  targets: SyncTarget[],
  targetPaths: readonly string[],
  platform: NodeJS.Platform
): void {
  const pathOps = pathApi(platform);
  for (const targetPath of targetPaths) {
    if (
      typeof targetPath !== 'string' ||
      !pathOps.isAbsolute(targetPath) ||
      pathOps.basename(targetPath) !== 'chatLanguageModels.json'
    ) {
      throw new Error('Additional sync targets must be absolute chatLanguageModels.json paths.');
    }
    addTarget(targets, targetPath, 'explicit', platform);
  }
}

export function discoverSyncTargets(context: SyncTargetDiscoveryContext): SyncTarget[] {
  const platform = context.platform ?? process.platform;
  const pathOps = pathApi(platform);
  const homeDir = context.homeDir ?? os.homedir();
  const primaryPath = getChatLanguageModelsPath(context.activeExtensionStoragePath, {
    platform,
    homeDir,
    appDataPath: context.appDataPath,
    isWsl: context.isWsl,
  });
  const targets: SyncTarget[] = [];

  addTarget(targets, primaryPath, 'primary', platform);
  addHomeProfileTargets(targets, homeDir, 'current-user', primaryPath, platform, context.appDataPath);

  if (context.associatedWslHome) {
    if (!pathOps.isAbsolute(context.associatedWslHome)) {
      throw new Error('The associated WSL home must be an absolute path.');
    }
    addHomeProfileTargets(
      targets,
      context.associatedWslHome,
      'associated-wsl',
      primaryPath,
      platform,
      undefined,
      true
    );
  }

  addExplicitTargets(targets, context.additionalTargetPaths ?? [], platform);

  return targets;
}

export function getAllChatLanguageModelsPaths(
  activeExtensionStoragePath?: string,
  context: Omit<SyncTargetDiscoveryContext, 'activeExtensionStoragePath'> = {}
): string[] {
  return discoverSyncTargets({ ...context, activeExtensionStoragePath }).map((target) => target.path);
}

function parseAssociatedWslDistro(remoteName?: string): AssociatedWslDistro {
  const match = /^wsl\+(.+)$/i.exec(remoteName ?? '');
  if (!match) return undefined;

  const distro = match[1];
  if (!/^[A-Za-z0-9 ._-]+$/.test(distro)) {
    return { warning: 'Could not resolve the associated WSL target because its distro name is invalid.' };
  }
  return { distro };
}

function queryDefaultWslHome(distro: string): string {
  return childProcess.execFileSync(
    'wsl.exe',
    ['--distribution', distro, '--exec', 'sh', '-lc', 'printf "%s" "$HOME"'],
    { encoding: 'utf8', timeout: 5000, windowsHide: true }
  ).trim();
}

function toAssociatedWslUncHome(distro: string, homeDir: string): string {
  const segments = homeDir.split('/').filter(Boolean);
  if (!homeDir.startsWith('/') || segments.some((segment) => segment === '.' || segment === '..')) {
    throw new Error('WSL returned a non-absolute or unsafe home path.');
  }
  return path.win32.join(`\\\\wsl.localhost\\${distro}`, ...segments);
}

export function resolveAssociatedWslHome(
  remoteName?: string,
  context: AssociatedWslHomeContext = {}
): AssociatedWslHomeResult {
  if ((context.platform ?? process.platform) !== 'win32') return { status: 'not-applicable' };

  const associatedDistro = parseAssociatedWslDistro(remoteName);
  if (!associatedDistro) return { status: 'not-applicable' };
  if ('warning' in associatedDistro) return { status: 'warning', warning: associatedDistro.warning };

  try {
    const homeDir = context.queryHome
      ? context.queryHome(associatedDistro.distro)
      : queryDefaultWslHome(associatedDistro.distro);
    return {
      status: 'resolved',
      homeDir: toAssociatedWslUncHome(associatedDistro.distro, homeDir),
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      status: 'warning',
      warning: `Could not resolve the current WSL distro "${associatedDistro.distro}" (${detail}). Add its exact chatLanguageModels.json path to opencode.additionalSyncTargets to opt in.`,
    };
  }
}
