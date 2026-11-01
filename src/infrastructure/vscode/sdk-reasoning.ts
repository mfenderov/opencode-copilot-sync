import type { SharedV3ProviderOptions } from '@ai-sdk/provider';
import type { OpenCodeModel } from '../../models/domain/model.js';
import { providerSpec } from './open-code-chat-adapter.js';

function normalizedEffort(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const effort = value.trim().toLowerCase();
  return effort && effort !== 'off' && effort !== 'none' ? effort : undefined;
}

function knownEffort(
  effort: string | undefined,
  model: Pick<OpenCodeModel, 'id' | 'supportsReasoningEffort'>
): string | undefined {
  if (!effort) return undefined;
  if (!model.supportsReasoningEffort?.some((supported) => supported.toLowerCase() === effort)) {
    throw new Error(`Unsupported reasoning effort ${effort} for ${model.id}.`);
  }
  return effort;
}

function selectedEffort(model: OpenCodeModel, value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error('Unsupported reasoning effort value.');
  return knownEffort(normalizedEffort(value), model);
}

export function sdkProviderOptions(model: OpenCodeModel, selected: unknown): SharedV3ProviderOptions {
  return providerSpec(model.providerPackage).reasoning(selectedEffort(model, selected), model);
}
