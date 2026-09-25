// Chat application: stream recovery policy (idle timeout, stall retry).
import * as vscode from 'vscode';

const STREAM_IDLE_TIMEOUT_MS = Number(process.env.OPENCODE_STREAM_IDLE_TIMEOUT_MS) || 90_000;

export function getStreamIdleTimeoutMs(): number {
  if (process.env.OPENCODE_STREAM_IDLE_TIMEOUT_MS) {
    const envVal = Number(process.env.OPENCODE_STREAM_IDLE_TIMEOUT_MS);
    if (!isNaN(envVal) && envVal > 0) return envVal;
  }
  try {
    const configSec = vscode.workspace.getConfiguration('opencode').get<number>('streamIdleTimeoutSeconds');
    if (typeof configSec === 'number' && configSec > 0) {
      return configSec * 1000;
    }
  } catch {}
  return STREAM_IDLE_TIMEOUT_MS;
}

export function shouldRetryStall(attempt: number, maxRetries: number): boolean {
  return attempt < maxRetries;
}

export function stallInterruptionMessage(detail: string): string {
  return `\n\n*(Response stream interrupted: ${detail || 'Connection closed by upstream OpenCode service'})*`;
}
