// Chat infrastructure: reasoning effort and stale-reasoning guards.
import * as vscode from 'vscode';

const VALID_REASONING_EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh']);

export function normalizeReasoningEffort(
  effort: string | undefined,
  isResponses: boolean
): Record<string, unknown> {
  if (!effort) return {};
  const lower = String(effort).toLowerCase().trim();
  if (lower === 'none' || lower === 'off') {
    return {};
  }
  // Standard OpenAI API across both Responses and Chat Completions protocols
  // strictly defines: 'low' | 'medium' | 'high' (and 'minimal'/'xhigh' on select providers).
  // Non-standard 'max' causes HTTP 400 Bad Request on upstream providers (e.g. Muse, MiMo).
  // Map 'max' to 'high' for guaranteed compatibility while maximizing reasoning depth.
  const mappedEffort = lower === 'max' ? 'high' : lower;

  // Defense in depth: never forward a value the upstream API doesn't recognize.
  // An unrecognized effort (garbage config, future VS Code UI values, etc.)
  // reliably causes a 400 Bad Request upstream — omitting the param is safer
  // than guessing, and lets the model fall back to its own default.
  if (!VALID_REASONING_EFFORTS.has(mappedEffort)) {
    return {};
  }

  return isResponses ? { reasoning: { effort: mappedEffort } } : { reasoning_effort: mappedEffort };
}

export function getReasoningEffort(options: vscode.ProvideLanguageModelChatResponseOptions): string | undefined {
  // The documented channel comes first: ProvideLanguageModelChatResponseOptions.modelOptions
  // is where a spec-conformant caller sets per-model knobs (typed as an open
  // string map, so its values are unknown by design). The remaining shapes are
  // observed-not-documented — Copilot and related hosts pass these today, so
  // they stay as fallbacks rather than being dropped.
  const documented = documentedEffort(options.modelOptions);
  if (documented) return documented;
  return legacyEffort(options as unknown as Record<string, unknown>);
}

function asEffortString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function documentedEffort(modelOptions: Record<string, unknown> | undefined): string | undefined {
  return asEffortString(modelOptions?.reasoningEffort) ?? asEffortString(modelOptions?.thinkingLevel);
}

function configEffort(configuration: Record<string, unknown> | undefined): string | undefined {
  return (
    asEffortString(configuration?.reasoningEffort) ??
    asEffortString(configuration?.thinkingLevel)
  );
}

function legacyEffort(legacy: Record<string, unknown>): string | undefined {
  const modelConfiguration = legacy.modelConfiguration as Record<string, unknown> | undefined;
  const configuration = legacy.configuration as Record<string, unknown> | undefined;
  return (
    configEffort(modelConfiguration) ??
    configEffort(configuration) ??
    asEffortString(legacy.reasoningEffort) ??
    asEffortString(legacy.thinkingLevel)
  );
}

export function isStaleReasoningInput(item: unknown): boolean {
  if (typeof item !== 'object' || item === null) return false;
  const rec = item as Record<string, unknown>;
  if (
    rec.type === 'reasoning' ||
    rec.type === 'thought' ||
    rec.type === 'thinking' ||
    typeof rec.encrypted_content === 'string'
  ) {
    return true;
  }
  if (Array.isArray(rec.content)) {
    return rec.content.some((part: unknown) => {
      if (typeof part !== 'object' || part === null) return false;
      const p = part as Record<string, unknown>;
      return (
        p.type === 'reasoning' ||
        p.type === 'thought' ||
        p.type === 'thinking' ||
        typeof p.encrypted_content === 'string'
      );
    });
  }
  return false;
}
