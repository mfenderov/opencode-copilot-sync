export function formatSyncFailureTooltip(): string {
  return 'OpenCode sync failed. Click to retry.';
}

export function formatSyncFailureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
