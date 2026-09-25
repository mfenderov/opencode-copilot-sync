// Models domain: token budget calculation.
export interface ModelTokenLimits {
  contextWindow: number;
  maxInputTokens: number;
  maxOutputTokens: number;
}

const DEFAULT_CONTEXT_WINDOW = 1_048_576;
const DEFAULT_MAX_OUTPUT_TOKENS = 65_536;
const MIN_SAFE_CONTEXT_WINDOW = 4;
const MAX_OUTPUT_CONTEXT_RATIO = 0.25;

export function resolveModelTokenLimits(
  contextWindow: unknown,
  maxOutputTokens: unknown
): ModelTokenLimits {
  const context = typeof contextWindow === 'number' &&
    Number.isSafeInteger(contextWindow) &&
    contextWindow >= MIN_SAFE_CONTEXT_WINDOW
    ? contextWindow
    : DEFAULT_CONTEXT_WINDOW;
  const output = typeof maxOutputTokens === 'number' &&
    Number.isSafeInteger(maxOutputTokens) &&
    maxOutputTokens > 0
    ? maxOutputTokens
    : DEFAULT_MAX_OUTPUT_TOKENS;
  const safeOutput = Math.min(output, Math.floor(context * MAX_OUTPUT_CONTEXT_RATIO));

  return {
    contextWindow: context,
    maxInputTokens: context - safeOutput,
    maxOutputTokens: safeOutput,
  };
}
