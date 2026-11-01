import { Buffer } from 'node:buffer';
import * as vscode from 'vscode';
import type { LanguageModelV3ToolResultOutput } from '@ai-sdk/provider';

export interface HostDataPart {
  mimeType: string;
  data: unknown;
}

type ToolContent = Extract<LanguageModelV3ToolResultOutput, { type: 'content' }>['value'][number];

function recordObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function marshalledData(value: unknown): boolean {
  return value instanceof vscode.LanguageModelDataPart || recordObject(value)?.$mid === 24;
}

export function hostDataPart(value: unknown): HostDataPart | undefined {
  const candidate = recordObject(value);
  if (!candidate || !marshalledData(value)) return undefined;
  if (typeof candidate.mimeType !== 'string' || !('data' in candidate)) {
    throw new Error('Invalid VS Code language model data part.');
  }
  return { mimeType: candidate.mimeType, data: candidate.data };
}

export function hostDataBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (typeof data !== 'string' || !/^[A-Za-z0-9+/_-]*={0,2}$/.test(data) ||
    (data.includes('=') && data.length % 4 !== 0)) throw new Error('Invalid base64 data part.');
  const bytes = Buffer.from(data, 'base64');
  const normalized = data.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  if (bytes.toString('base64').replace(/=+$/, '') !== normalized) throw new Error('Invalid base64 data part.');
  return bytes;
}

export function textDataMime(mimeType: string): boolean {
  return mimeType.startsWith('text/') || mimeType === 'application/json' || mimeType.endsWith('+json');
}

function validContentType(mimeType: string): string {
  const normalized = mimeType.split(';', 1)[0].trim().toLowerCase();
  if (!normalized || normalized.includes(' ')) throw new Error(`Invalid tool-result data type: ${mimeType}.`);
  return normalized;
}

function dataToolContent(part: HostDataPart): ToolContent | undefined {
  const mimeType = validContentType(part.mimeType);
  if (mimeType === 'cache_control') return undefined;
  const bytes = hostDataBytes(part.data);
  if (textDataMime(mimeType)) return { type: 'text', text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  const data = Buffer.from(bytes).toString('base64');
  if (mimeType.startsWith('image/')) return { type: 'image-data', mediaType: mimeType, data };
  return { type: 'file-data', mediaType: mimeType, data };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function knownTextPart(part: unknown): ToolContent | undefined {
  if (part instanceof vscode.LanguageModelTextPart) return { type: 'text', text: part.value };
  if (typeof part === 'string') return { type: 'text', text: part };
  const value = stringValue(recordObject(part)?.value);
  return value === undefined ? undefined : { type: 'text', text: value };
}

function rejectedContent(part: unknown): ToolContent {
  if (typeof part === 'undefined' || typeof part === 'function' || typeof part === 'symbol') {
    throw new Error('Unsupported tool-result content.');
  }
  return { type: 'text', text: JSON.stringify(part) };
}

function textToolContent(part: unknown): ToolContent {
  return knownTextPart(part) ?? rejectedContent(part);
}

export function toolResultOutput(content: readonly unknown[]): LanguageModelV3ToolResultOutput {
  const parts: ToolContent[] = [];
  for (const part of content) {
    const data = hostDataPart(part);
    const mapped = data ? dataToolContent(data) : textToolContent(part);
    if (mapped) parts.push(mapped);
  }
  if (parts.every((part) => part.type === 'text')) {
    return { type: 'text', value: parts.map((part) => part.text).join('\n') };
  }
  return { type: 'content', value: parts };
}
