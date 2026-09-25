import { enrichModel, type CustomEndpointModel } from './models/infrastructure/model-enricher.js';

export interface ProviderEntry {
  name: string;
  vendor: 'customendpoint';
  apiKey: string;
  apiType: 'chat-completions';
  models: CustomEndpointModel[];
  settings?: Record<string, unknown>;
}

declare const secretInputReferenceBrand: unique symbol;
export type VSCodeSecretInputReference = string & {
  readonly [secretInputReferenceBrand]: true;
};

export type TargetProviderEntry = Omit<ProviderEntry, 'apiKey'> & {
  apiKey: VSCodeSecretInputReference;
};

export type OpenCodeTargetMergeResult =
  | { status: 'updated'; config: unknown[] }
  | { status: 'skipped'; config: unknown[]; warning: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUnifiedOpenCodeProvider(entry: unknown): entry is Record<string, unknown> {
  return isRecord(entry) && entry.name === 'OpenCode' && entry.vendor === 'customendpoint';
}

const VS_CODE_SECRET_INPUT_REFERENCE = /^\$\{input:chat\.lm\.secret\.[0-9a-f]+\}$/;

export function parseVSCodeSecretInputReference(value: unknown): VSCodeSecretInputReference | undefined {
  if (typeof value !== 'string' || !VS_CODE_SECRET_INPUT_REFERENCE.test(value)) return undefined;
  return value as VSCodeSecretInputReference;
}

function hasOpenCodeModelUrl(entry: Record<string, unknown>): boolean {
  const models = entry.models;
  return (
    Array.isArray(models) &&
    models.some((model: unknown) => {
      const modelRecord = isRecord(model) ? model : undefined;
      return typeof modelRecord?.url === 'string' && modelRecord.url.includes('opencode.ai');
    })
  );
}

function isLegacyOpenCodeName(name: string): boolean {
  return name === 'OpenCode Go' || name === 'OpenCode Zen Free';
}

export function buildProviderEntry(
  name: string,
  apiKey: string,
  modelIds: string[],
  options: { isGo?: boolean; isFree?: boolean } = { isGo: true }
): ProviderEntry {
  const models = modelIds.map((id) => enrichModel(id, options));

  return {
    name,
    vendor: 'customendpoint',
    apiKey,
    apiType: 'chat-completions',
    models,
  };
}

export function isOpenCodeLegacyOrCustomEntry(entry: unknown): boolean {
  const record = isRecord(entry) ? entry : undefined;
  if (!record || record.vendor !== 'customendpoint') {
    return false;
  }
  const name = typeof record.name === 'string' ? record.name.trim() : '';
  return (
    isLegacyOpenCodeName(name) ||
    hasOpenCodeModelUrl(record)
  );
}

export function purgeOpenCodeFromChatLanguageModels(existingConfig: unknown[]): unknown[] {
  if (!Array.isArray(existingConfig)) return [];
  return existingConfig.filter((entry) => {
    if (!entry) return false;
    return !isOpenCodeLegacyOrCustomEntry(entry) && !isUnifiedOpenCodeProvider(entry);
  });
}

export function mergeChatLanguageModels(
  existingConfig: unknown[],
  newProviders: ProviderEntry[]
): unknown[] {
  const addingUnifiedOpenCode = newProviders.some((p) => p.name === 'OpenCode');
  const result = existingConfig.filter((entry) => {
    const record = isRecord(entry) ? entry : undefined;
    if (addingUnifiedOpenCode && isOpenCodeLegacyOrCustomEntry(entry) && record?.name !== 'OpenCode') {
      return false;
    }
    return true;
  });

  for (const newProvider of newProviders) {
    const idx = result.findIndex(
      (entry) => {
        const record = isRecord(entry) ? entry : undefined;
        return record?.name === newProvider.name && record.vendor === newProvider.vendor;
      }
    );

    if (idx >= 0) {
      const existingEntry = isRecord(result[idx]) ? result[idx] : undefined;
      if (!existingEntry) continue;

      const existingModels = Array.isArray(existingEntry.models) ? existingEntry.models : [];
      const incomingModels = newProvider.models;
      const modelsToKeep = incomingModels.length > 0 ? incomingModels : existingModels;

      // Preserve SecretStorage reference if VS Code migrated apiKey to ${input:...}
      const apiKey = parseVSCodeSecretInputReference(existingEntry.apiKey) ?? newProvider.apiKey;

      result[idx] = {
        ...existingEntry,
        ...newProvider,
        apiKey,
        models: modelsToKeep,
      };
    } else {
      result.push(newProvider);
    }
  }

  return result;
}

// VS Code generates this SecretStorage reference for custom endpoint apiKey fields.
export function mergeOpenCodeProviderForTarget(
  existingConfig: unknown[],
  provider: ProviderEntry
): OpenCodeTargetMergeResult {
  const matchingProviders = existingConfig.filter(isUnifiedOpenCodeProvider);
  if (matchingProviders.length !== 1) {
    return {
      status: 'skipped',
      config: existingConfig,
      warning:
        'OpenCode mirror skipped because this VS Code profile must contain exactly one OpenCode entry with a VS Code-generated SecretStorage reference. Configure one entry through Manage Language Models, enter the key locally, and remove any duplicates.',
    };
  }

  const existingOpenCode = matchingProviders[0];
  const secretReference = parseVSCodeSecretInputReference(existingOpenCode.apiKey);
  if (!secretReference) {
    return {
      status: 'skipped',
      config: existingConfig,
      warning:
        "OpenCode mirror skipped because this VS Code profile has no VS Code SecretStorage-backed API key reference. In that profile, open Manage Language Models, configure OpenCode, and enter the API key locally; the next sync can then reuse that profile's secret reference.",
    };
  }

  const targetProvider: TargetProviderEntry = { ...provider, apiKey: secretReference };
  return {
    status: 'updated',
    config: mergeChatLanguageModels(existingConfig, [targetProvider]),
  };
}

export function redactOpenCodeApiKeys(existingConfig: unknown[]): unknown[] {
  return existingConfig.map((entry) => {
    if (!isRecord(entry) || (!isUnifiedOpenCodeProvider(entry) && !isOpenCodeLegacyOrCustomEntry(entry))) {
      return entry;
    }
    if (parseVSCodeSecretInputReference(entry.apiKey)) return entry;

    const redacted = { ...entry };
    delete redacted.apiKey;
    return redacted;
  });
}
