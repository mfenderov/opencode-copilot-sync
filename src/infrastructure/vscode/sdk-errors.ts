import { APICallError } from '@ai-sdk/provider';
import * as vscode from 'vscode';

function recordObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function errorMessage(body: unknown): string | undefined {
  const recordBody = recordObject(body);
  const nested = recordObject(recordBody?.error);
  if (typeof nested?.message === 'string') return nested.message;
  return typeof recordBody?.message === 'string' ? recordBody.message : undefined;
}

function upstreamDetail(error: APICallError): string {
  if (!error.responseBody) return error.message;
  try {
    return errorMessage(JSON.parse(error.responseBody)) ?? error.message;
  } catch {
    return error.responseBody;
  }
}

export function reportSDKError(
  error: unknown,
  modelId: string,
  progress: vscode.Progress<vscode.LanguageModelResponsePart>
): boolean {
  if (!APICallError.isInstance(error) || error.statusCode === undefined) return false;
  const detail = upstreamDetail(error);
  const isFreeTier = /FreeTierError|free tier/i.test(`${error.responseBody ?? ''}\n${detail}`);
  if ((error.statusCode === 401 || error.statusCode === 403) && !isFreeTier) {
    throw vscode.LanguageModelError.NoPermissions(`OpenCode authentication failed: ${detail}`);
  }
  const lines = (detail.slice(0, 300) || 'Service Error').split(/\r\n|\r|\n/);
  const safeId = modelId.replace(/[`\\\r\n]/g, '_');
  progress.report(new vscode.LanguageModelTextPart([
    `> ⚠️ \`${safeId}\` (${error.statusCode}): ${lines[0]}`,
    ...lines.slice(1).map((line) => `> ${line}`),
  ].join('\n')));
  return true;
}
