export interface OpenCodeSyncConfiguration {
  get<T>(section: string, defaultValue: T): T | undefined;
}

export interface ExtensionSyncOptions {
  includeGo: boolean;
  includeZen: boolean;
  storagePath: string;
  remoteName?: string;
  additionalTargetPaths: string[];
}

function getBooleanSetting(
  configuration: OpenCodeSyncConfiguration,
  section: string,
  defaultValue: boolean
): boolean {
  const value = configuration.get<unknown>(section, defaultValue);
  if (typeof value !== 'boolean') {
    throw new Error(`opencode.${section} must be a boolean.`);
  }
  return value;
}

function getAdditionalTargetPaths(configuration: OpenCodeSyncConfiguration): string[] {
  const value = configuration.get<unknown>('additionalSyncTargets', []);
  if (!Array.isArray(value)) {
    throw new Error('opencode.additionalSyncTargets must be an array of absolute chatLanguageModels.json paths.');
  }

  const paths: string[] = [];
  for (const target of value) {
    if (typeof target !== 'string') {
      throw new Error('opencode.additionalSyncTargets must contain only absolute path strings.');
    }
    paths.push(target);
  }

  return paths;
}

export function buildSyncOptions(
  configuration: OpenCodeSyncConfiguration,
  storagePath: string,
  remoteName: string | undefined
): ExtensionSyncOptions {
  return {
    includeGo: getBooleanSetting(configuration, 'includeGoModels', true),
    includeZen: getBooleanSetting(configuration, 'includeZenModels', true),
    storagePath,
    remoteName,
    additionalTargetPaths: getAdditionalTargetPaths(configuration),
  };
}

export function shouldPromptForApiKey(interactive: boolean, isCI: boolean): boolean {
  return interactive && !isCI;
}
