// Models domain: token budget calculation.
export interface ModelTokenLimits {
  contextWindow: number;
  maxInputTokens: number;
  maxOutputTokens: number;
}

function toPositiveLimit(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`Invalid model ${name}.`);
  }
  return value;
}

export function resolveModelTokenLimits(
  contextWindow: unknown,
  maxOutputTokens: unknown,
  maxInputTokens?: unknown
): ModelTokenLimits {
  const context = toPositiveLimit(contextWindow, 'context window');
  const output = toPositiveLimit(maxOutputTokens, 'output token limit');
  const input = maxInputTokens === undefined ? context : toPositiveLimit(maxInputTokens, 'input token limit');

  return {
    contextWindow: context,
    maxInputTokens: Math.min(input, context),
    maxOutputTokens: Math.min(output, context),
  };
}
