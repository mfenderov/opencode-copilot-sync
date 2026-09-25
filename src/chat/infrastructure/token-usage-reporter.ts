// Chat infrastructure: stream token-usage reporting.
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function isTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function readReasoningTokens(details: unknown): number | undefined {
  if (!isRecord(details)) return undefined;
  return isTokenCount(details.reasoning_tokens) ? details.reasoning_tokens : undefined;
}

export function buildUsagePayload(event: unknown): Record<string, unknown> | undefined {
  if (!isRecord(event) || !isRecord(event.response) || !isRecord(event.response.usage)) return undefined;

  const usage = event.response.usage;
  if (!isTokenCount(usage.input_tokens) || !isTokenCount(usage.output_tokens)) return undefined;

  const payload: Record<string, unknown> = {
    prompt_tokens: usage.input_tokens,
    completion_tokens: usage.output_tokens,
  };
  const details = isRecord(usage.output_tokens_details)
    ? usage.output_tokens_details
    : usage.completion_tokens_details;
  const reasoningTokens = readReasoningTokens(details);
  if (reasoningTokens !== undefined) {
    payload.completion_tokens_details = { reasoning_tokens: reasoningTokens };
  }
  return payload;
}
