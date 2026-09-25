import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { fetchWithRetry } from './network.js';
import {
  buildResponsesInput,
  createOpenCodeRequestHeaders,
  createProviderRequest,
  formatProviderMessages,
  formatProviderTools,
  getReasoningEffort,
  isFreeOrZenModel,
  isResponsesModel,
  isStaleReasoningInput,
  resolveModelTokenLimits,
  sanitizeResponsesInput,
} from './provider-protocol.js';
import type {
  FormattedMessage,
  OpenCodeModelMeta,
  WireToolDefinition,
} from './provider-protocol.js';
import { consumeProviderStream } from './provider-stream.js';

export {
  buildResponsesInput,
  injectOpenCodeVerificationTools,
  isFreeOrZenModel,
  isResponsesModel,
  isSyntheticVerificationTool,
  isStaleReasoningInput,
  normalizeReasoningEffort,
  OPENCODE_CLIENT_VERIFICATION_TOOLS_CHAT,
  OPENCODE_CLIENT_VERIFICATION_TOOLS_RESPONSES,
  sanitizeResponsesInput,
  ThinkTagStreamParser,
} from './provider-protocol.js';
export type {
  FormattedMessage,
  FormattedToolCall,
  OpenCodeModelMeta,
  ResponsesInputFunctionCall,
  ResponsesInputFunctionCallOutput,
  ResponsesInputItem,
  ResponsesInputMessage,
  WireToolDefinition,
} from './provider-protocol.js';

export const VERIFIED_OPENCODE_MODELS: OpenCodeModelMeta[] = [
  { id: 'minimax-m3', name: 'MiniMax M3 (OpenCode Go)', family: 'minimax-m3', catalog: 'go', contextWindow: 1048576, maxOutputTokens: 131072, vision: false, thinking: false },
  { id: 'minimax-m2.5', name: 'MiniMax M2.5 (OpenCode Go)', family: 'minimax-m2.5', catalog: 'go', contextWindow: 1048576, maxOutputTokens: 131072, vision: false, thinking: true },
  { id: 'kimi-k3', name: 'Kimi K3 (OpenCode Go)', family: 'kimi-k3', catalog: 'go', contextWindow: 1048576, maxOutputTokens: 65536, vision: true, thinking: true, supportsReasoningEffort: ['low', 'medium', 'high', 'max'] },
  { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code (OpenCode Go)', family: 'kimi-k2.7-code', catalog: 'go', contextWindow: 1048576, maxOutputTokens: 65536, vision: true, thinking: true, supportsReasoningEffort: ['low', 'medium', 'high', 'max'] },
  { id: 'kimi-k2.6', name: 'Kimi K2.6 (OpenCode Go)', family: 'kimi-k2.6', catalog: 'go', contextWindow: 1048576, maxOutputTokens: 65536, vision: true, thinking: true },
  { id: 'longcat-2.0', name: 'Longcat 2.0 (OpenCode Go)', family: 'longcat-2.0', catalog: 'go', contextWindow: 1048576, maxOutputTokens: 65536, vision: false, thinking: false },
  { id: 'glm-5.2', name: 'GLM 5.2 (OpenCode Go)', family: 'glm-5.2', catalog: 'go', contextWindow: 1048576, maxOutputTokens: 131072, vision: true, thinking: true, supportsReasoningEffort: ['high', 'max'] },
  { id: 'glm-5.3-flash', name: 'GLM 5.3 Flash (OpenCode Go)', family: 'glm-5.3-flash', catalog: 'go', contextWindow: 1048576, maxOutputTokens: 131072, vision: true, thinking: true, supportsReasoningEffort: ['low', 'high', 'max'] },
  { id: 'glm-5.3', name: 'GLM 5.3 (OpenCode Go)', family: 'glm-5.3', catalog: 'go', contextWindow: 1048576, maxOutputTokens: 131072, vision: true, thinking: true, supportsReasoningEffort: ['low', 'high', 'max'] },
  { id: 'glm-5.1', name: 'GLM 5.1 (OpenCode Go)', family: 'glm-5.1', catalog: 'go', contextWindow: 1048576, maxOutputTokens: 131072, vision: true, thinking: true },
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro (OpenCode Go)', family: 'deepseek-v4-pro', catalog: 'go', contextWindow: 1048576, maxOutputTokens: 131072, vision: false, thinking: true, supportsReasoningEffort: ['low', 'high', 'max'] },
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash (OpenCode Go)', family: 'deepseek-v4-flash', catalog: 'go', contextWindow: 1048576, maxOutputTokens: 131072, vision: false, thinking: true, supportsReasoningEffort: ['low', 'high', 'max'] },
  { id: 'deepseek-flash', name: 'DeepSeek Flash (OpenCode Go)', family: 'deepseek-flash', catalog: 'go', contextWindow: 1048576, maxOutputTokens: 131072, vision: false, thinking: true, supportsReasoningEffort: ['low', 'high', 'max'] },
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash (OpenCode Go)', family: 'deepseek-v4.1-flash', catalog: 'go', contextWindow: 1048576, maxOutputTokens: 131072, vision: false, thinking: true, supportsReasoningEffort: ['low', 'medium', 'high', 'max'] },
  { id: 'deepseek-v4-flash-vision-exp', name: 'DeepSeek V4 Flash Vision Exp (OpenCode Go)', family: 'deepseek-v4-flash-vision-exp', catalog: 'go', contextWindow: 1048576, maxOutputTokens: 131072, vision: true, thinking: true, supportsReasoningEffort: ['low', 'high', 'max'] },
  { id: 'qwen3.7-max', name: 'Qwen3.7 Max (OpenCode Go)', family: 'qwen3.7-max', catalog: 'go', contextWindow: 1000000, maxOutputTokens: 131072, vision: true, thinking: false },
  { id: 'qwen3.8-max', name: 'Qwen3.8 Max (OpenCode Go)', family: 'qwen3.8-max', catalog: 'go', contextWindow: 1000000, maxOutputTokens: 131072, vision: true, thinking: false },
  { id: 'qwen3.8-flash', name: 'Qwen3.8 Flash (OpenCode Go)', family: 'qwen3.8-flash', catalog: 'go', contextWindow: 1000000, maxOutputTokens: 131072, vision: true, thinking: false },
  { id: 'qwen3.6-plus', name: 'Qwen3.6 Plus (OpenCode Go)', family: 'qwen3.6-plus', catalog: 'go', contextWindow: 1000000, maxOutputTokens: 131072, vision: true, thinking: false },
  { id: 'mimo-v2.5-pro', name: 'MiMo V2.5 Pro (OpenCode Go)', family: 'mimo-v2.5-pro', catalog: 'go', contextWindow: 1048576, maxOutputTokens: 65536, vision: false, thinking: true, supportsReasoningEffort: ['low', 'medium', 'high'] },
  { id: 'mimo-v2.5', name: 'MiMo V2.5 (OpenCode Go)', family: 'mimo-v2.5', catalog: 'go', contextWindow: 1048576, maxOutputTokens: 65536, vision: false, thinking: true, supportsReasoningEffort: ['low', 'medium', 'high'] },
  { id: 'hy4-preview', name: 'Hy4 Preview (OpenCode Go)', family: 'hy4-preview', catalog: 'go', contextWindow: 1048576, maxOutputTokens: 65536, vision: false, thinking: true },
  { id: 'hy3', name: 'Hy3 (OpenCode Go)', family: 'hy3', catalog: 'go', contextWindow: 1048576, maxOutputTokens: 65536, vision: false, thinking: false },
  { id: 'omen-alpha', name: 'Omen Alpha (OpenCode Go)', family: 'omen-alpha', catalog: 'go', contextWindow: 1048576, maxOutputTokens: 65536, vision: false, thinking: true },
  // Verified OpenCode Free models (always available and visible)
  { id: 'big-pickle', name: 'Big Pickle (OpenCode Free)', family: 'big-pickle', catalog: 'zen', isFree: true, contextWindow: 1048576, maxOutputTokens: 65536, vision: false, thinking: false },
  { id: 'mimo-v2.5-free', name: 'MiMo V2.5 (OpenCode Free)', family: 'mimo-v2.5-free', catalog: 'zen', isFree: true, contextWindow: 1048576, maxOutputTokens: 65536, vision: false, thinking: true, supportsReasoningEffort: ['low', 'medium', 'high'] },
  { id: 'ling-3.0-flash-fin-free', name: 'Ling 3.0 Flash Fin (OpenCode Free)', family: 'ling-3.0-flash-fin-free', catalog: 'zen', isFree: true, contextWindow: 1048576, maxOutputTokens: 65536, vision: false, thinking: false },
  { id: 'nemotron-3-ultra-free', name: 'Nemotron 3 Ultra (OpenCode Free)', family: 'nemotron-3-ultra-free', catalog: 'zen', isFree: true, contextWindow: 1000000, maxOutputTokens: 128000, vision: false, thinking: true, supportsReasoningEffort: ['low', 'medium', 'high'] },
  { id: 'nemotron-3.5-lightning-free', name: 'Nemotron 3.5 Lightning (OpenCode Free)', family: 'nemotron-3.5-lightning-free', catalog: 'zen', isFree: true, contextWindow: 1000000, maxOutputTokens: 128000, vision: false, thinking: true, supportsReasoningEffort: ['low', 'medium', 'high'] },
  { id: 'deepseek-v4-flash-free', name: 'DeepSeek V4 Flash (OpenCode Free)', family: 'deepseek-v4-flash-free', catalog: 'zen', isFree: true, contextWindow: 1048576, maxOutputTokens: 131072, vision: false, thinking: true, supportsReasoningEffort: ['low', 'high', 'max'] },
  { id: 'muse-spark-1.3', name: 'Muse Spark 1.3 (OpenCode Zen)', family: 'muse-spark-1.3', catalog: 'zen', contextWindow: 1048576, maxOutputTokens: 65536, vision: true, thinking: true, supportsReasoningEffort: ['minimal', 'low', 'medium', 'high', 'xhigh'] },
  { id: 'muse-spark-1.3-contributor', name: 'Muse Spark 1.3 Contributor (OpenCode Go)', family: 'muse-spark-1.3-contributor', catalog: 'go', contextWindow: 1048576, maxOutputTokens: 65536, vision: true, thinking: true, supportsReasoningEffort: ['minimal', 'low', 'medium', 'high', 'xhigh'] },
  { id: 'muse-spark-1.3-contributor-free', name: 'Muse Spark 1.3 Contributor (OpenCode Free)', family: 'muse-spark-1.3-contributor-free', catalog: 'zen', isFree: true, contextWindow: 1048576, maxOutputTokens: 65536, vision: true, thinking: true, supportsReasoningEffort: ['minimal', 'low', 'medium', 'high', 'xhigh'] },
  { id: 'muse-spark-1.2-contributor-free', name: 'Muse Spark 1.2 Contributor (OpenCode Free)', family: 'muse-spark-1.2-contributor-free', catalog: 'zen', isFree: true, contextWindow: 1048576, maxOutputTokens: 65536, vision: true, thinking: true, supportsReasoningEffort: ['minimal', 'low', 'medium', 'high', 'xhigh'] },
];

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

/** Cheap, dependency-free string hash (djb2) used to bucket conversations by their first message. */
function djb2Hash(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0; // hash * 33 + c
  }
  return (hash >>> 0).toString(36);
}

/**
 * Fingerprints a message's role + text content so the same opening message always
 * produces the same key, without retaining the full message text in memory.
 */
function fingerprintMessage(msg: vscode.LanguageModelChatRequestMessage | undefined): string {
  if (!msg) return 'empty';
  let text = '';
  try {
    for (const part of msg.content) {
      if (part instanceof vscode.LanguageModelTextPart) {
        text += part.value;
      } else if (part && typeof part === 'object') {
        text += JSON.stringify(part);
      }
    }
  } catch {
    // Malformed/unexpected content falls back to a role-only fingerprint below.
  }
  return `${msg.role}:${djb2Hash(text)}`;
}

/**
 * Fingerprints a full turn's message history as a per-message chain so a
 * conversation's growth can be prefix-matched (see `getConversationSessionId`).
 */
function fingerprintConversation(messages: readonly vscode.LanguageModelChatRequestMessage[]): string[] {
  return messages.map((msg) => fingerprintMessage(msg));
}

/**
 * True when the incoming chain continues the cached one: the cached chain is a
 * prefix of (or equal to) the incoming chain, i.e. the conversation grew by
 * appending turns. A shared root with a different next fingerprint means a
 * distinct chat that happens to share an opener — not a continuation.
 */
function isChainContinuation(cachedChain: string[], incomingChain: string[]): boolean {
  if (cachedChain.length > incomingChain.length) return false;
  for (let i = 0; i < cachedChain.length; i++) {
    if (cachedChain[i] !== incomingChain[i]) return false;
  }
  return true;
}

const OPENCODE_ID_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/**
 * Generates an OpenCode descending identifier (12 hex chars timestamp prefix + 14 base62 chars)
 * matching OpenCode client's `Identifier.descending()` format: `^[0-9a-f]{12}[0-9A-Za-z]{14}$`.
 */
export function generateOpenCodeDescendingId(): string {
  const now = Date.now();
  const counter = Math.floor(Math.random() * 0xfff) + 1;
  const val = (~(BigInt(now) * 4096n + BigInt(counter))) & 0xffffffffffffn;
  const hexPrefix = val.toString(16).padStart(12, '0');
  let randSuffix = '';
  for (let i = 0; i < 14; i++) {
    randSuffix += OPENCODE_ID_ALPHABET[Math.floor(Math.random() * OPENCODE_ID_ALPHABET.length)];
  }
  return `${hexPrefix}${randSuffix}`;
}

export function generateOpenCodeSessionId(): string {
  return `ses_${generateOpenCodeDescendingId()}`;
}

export function generateOpenCodeRequestId(): string {
  return `msg_${generateOpenCodeDescendingId()}`;
}

function extractErrorMessage(rawJson: string): string {
  try {
    const data: unknown = JSON.parse(rawJson);
    if (typeof data === 'object' && data !== null) {
      const rec = data as Record<string, unknown>;
      if (typeof rec.error === 'object' && rec.error !== null) {
        const errRec = rec.error as Record<string, unknown>;
        if (typeof errRec.message === 'string') {
          return errRec.message;
        }
      }
      if (typeof rec.message === 'string') {
        return rec.message;
      }
    }
  } catch {}
  return rawJson;
}

export class OpenCodeChatProvider implements vscode.LanguageModelChatProvider {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this._onDidChange.event;
  private _models: OpenCodeModelMeta[] = [...VERIFIED_OPENCODE_MODELS];

  // Copilot resends full conversation history each turn, so a conversation's first message
  // stays constant across its turns. We use that as a cheap, heuristic conversation identity
  // since VS Code's chat provider API exposes no native conversation/session id.
  //
  // Same-opener chats fork on divergence: entries track the longest fingerprint chain
  // seen so far, and a new chain that extends a different branch of the same root
  // gets its own session instead of bleeding into the first chat's upstream context.
  private readonly sessionCache = new Map<string, { sessionId: string; lastUsedAt: number; chain: string[] }>();
  private static readonly SESSION_CACHE_MAX_SIZE = 50;
  private static readonly SESSION_CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly outputChannel?: vscode.OutputChannel
  ) {
    try {
      if (this.context.globalStorageUri.fsPath) {
        const cacheFile = path.join(this.context.globalStorageUri.fsPath, 'models_cache.json');
        if (fs.existsSync(cacheFile)) {
          const parsed = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
          if (Array.isArray(parsed) && parsed.length > 0) {
            this._models = parsed;
          }
        }
      }
    } catch {}
  }

  private log(message: string): void {
    this.outputChannel?.appendLine(`[Provider] ${message}`);
  }

  /**
   * Returns a stable x-opencode-session id for this conversation, reused across all
   * turns so OpenCode's routing/prompt caching sees one session instead of a fresh
   * one per request. Conversations are identified by fingerprinting their first
   * message (see `fingerprintMessage`), since VS Code's API exposes no session id.
   *
   * Same-opener chats fork on divergence: when the incoming fingerprint chain
   * extends the cached chain it is a continuation; when it shares only the root
   * (or a shorter common prefix) with a different next fingerprint it is a
   * distinct chat that happens to share an opener, and it gets its own session.
   */
  private getConversationSessionId(messages: readonly vscode.LanguageModelChatRequestMessage[]): string {
    const chain = fingerprintConversation(messages);
    const rootKey = chain[0] ?? 'empty';
    const now = Date.now();

    const cached = this.sessionCache.get(rootKey);
    if (cached && now - cached.lastUsedAt < OpenCodeChatProvider.SESSION_CACHE_TTL_MS) {
      if (isChainContinuation(cached.chain, chain)) {
        cached.lastUsedAt = now;
        cached.chain = chain;
        return cached.sessionId;
      }
      // Same opener, diverged history: look for an existing fork whose chain
      // this request continues; otherwise mint a new forked session.
      for (const [forkKey, fork] of this.sessionCache) {
        if (!forkKey.startsWith(`${rootKey}::`) || now - fork.lastUsedAt >= OpenCodeChatProvider.SESSION_CACHE_TTL_MS) {
          continue;
        }
        if (isChainContinuation(fork.chain, chain)) {
          fork.lastUsedAt = now;
          fork.chain = chain;
          return fork.sessionId;
        }
      }
      const sessionId = generateOpenCodeSessionId();
      this.evictSessionIfFull();
      this.sessionCache.set(`${rootKey}::${chain.length > 1 ? chain[1] : 'turn1'}::${djb2Hash(chain.join('|'))}`, { sessionId, lastUsedAt: now, chain });
      return sessionId;
    }

    this.evictStaleSessions(now);
    this.evictSessionIfFull();

    const sessionId = generateOpenCodeSessionId();
    this.sessionCache.set(rootKey, { sessionId, lastUsedAt: now, chain });
    return sessionId;
  }

  private evictStaleSessions(now: number): void {
    // Drop stale entries, then evict the least-recently-used one if still at capacity.
    for (const [k, v] of this.sessionCache) {
      if (now - v.lastUsedAt >= OpenCodeChatProvider.SESSION_CACHE_TTL_MS) {
        this.sessionCache.delete(k);
      }
    }
  }

  private evictSessionIfFull(): void {
    if (this.sessionCache.size >= OpenCodeChatProvider.SESSION_CACHE_MAX_SIZE) {
      let oldestKey: string | undefined;
      let oldestAt = Infinity;
      for (const [k, v] of this.sessionCache) {
        if (v.lastUsedAt < oldestAt) {
          oldestAt = v.lastUsedAt;
          oldestKey = k;
        }
      }
      if (oldestKey !== undefined) {
        this.sessionCache.delete(oldestKey);
      }
    }
  }

  refresh(): void {
    this._onDidChange.fire();
  }

  updateModels(models: OpenCodeModelMeta[]): void {
    if (Array.isArray(models) && models.length > 0) {
      this._models = models;
      this.refresh();
      try {
        if (this.context.globalStorageUri.fsPath) {
          const cacheDir = this.context.globalStorageUri.fsPath;
          if (!fs.existsSync(cacheDir)) {
            fs.mkdirSync(cacheDir, { recursive: true });
          }
          fs.writeFileSync(path.join(cacheDir, 'models_cache.json'), JSON.stringify(models), 'utf-8');
        }
      } catch {}
    }
  }

  async provideLanguageModelChatInformation(
    _options: vscode.PrepareLanguageModelChatModelOptions,
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelChatInformation[]> {
    return this._models.map((m) => {
      const supportsReasoning = m.thinking !== false;
      const properties: Record<string, any> = {};

      // Dynamic reasoning effort options based on actual model metadata
      const rawEfforts = m.supportsReasoningEffort;
      const validEfforts = supportsReasoning && Array.isArray(rawEfforts) && rawEfforts.length > 0
        ? rawEfforts.filter((e) => e !== 'none')
        : undefined;
      const defaultReasoningEffort = validEfforts?.includes('medium') ? 'medium' : validEfforts?.[0];

      if (validEfforts && validEfforts.length > 0) {
        const enumItemLabels = validEfforts.map((e) => {
          if (e === 'minimal') return 'Minimal';
          if (e === 'low') return 'Low';
          if (e === 'medium') return 'Medium';
          if (e === 'high') return 'High';
          if (e === 'xhigh') return 'Extra High';
          if (e === 'max') return 'Max';
          return e.charAt(0).toUpperCase() + e.slice(1);
        });

        const enumDescriptions = validEfforts.map((e) => {
          if (e === 'minimal') return 'Minimal reasoning';
          if (e === 'low') return 'Faster responses with light reasoning';
          if (e === 'medium') return 'Balanced reasoning and speed';
          if (e === 'high') return 'Deep reasoning';
          if (e === 'xhigh') return 'Extra deep reasoning';
          if (e === 'max') return 'Maximum reasoning depth';
          return `${e} reasoning`;
        });

        properties.reasoningEffort = {
          type: 'string',
          title: 'Thinking Effort',
          enum: validEfforts,
          enumItemLabels,
          enumDescriptions,
          default: defaultReasoningEffort,
          group: 'navigation',
        };
      }

      if (m.contextWindow > 256000) {
        properties.contextTier = {
          type: 'string',
          title: 'Context Size',
          enum: ['default', 'long_context'],
          enumItemLabels: ['Standard (128K)', 'Extended (1M)'],
          enumDescriptions: [
            'Standard context window for faster generation and lower token usage',
            'Full extended context window for large codebase analysis',
          ],
          default: 'default',
          group: 'tokens',
        };
      }

      const configurationSchema = Object.keys(properties).length > 0 ? { properties } : undefined;

      const tokenLimits = resolveModelTokenLimits(m.contextWindow, m.maxOutputTokens);
      return {
        id: m.id,
        name: m.name,
        family: m.family,
        version: '1.0.0',
        maxInputTokens: tokenLimits.maxInputTokens,
        maxOutputTokens: tokenLimits.maxOutputTokens,
        capabilities: {
          imageInput: m.vision,
          vision: m.vision,
          toolCalling: true,
          thinking: supportsReasoning,
        },
        supportsReasoningEffort: validEfforts,
        supportedReasoningEfforts: validEfforts,
        defaultReasoningEffort,
        configurationSchema,
        isBYOK: true,
      } as any;
    });
  }

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): Promise<void> {
    const apiKey =
      (await this.context.secrets.get('opencode_api_key')) ||
      (process.env.OPENCODE_API_KEY && process.env.OPENCODE_API_KEY.trim().length > 0
        ? process.env.OPENCODE_API_KEY.trim()
        : undefined);

    if (!apiKey) {
      throw new Error(
        'OpenCode API key not found. Please run "OpenCode: Set API Key" command to configure your key.'
      );
    }

    const formattedMessages = formatProviderMessages(messages);

    const lowerId = model.id.toLowerCase();
    const meta = this._models.find((m) => m.id === model.id || model.id.endsWith('/' + m.id));
    const isResponses = isResponsesModel(model.id, meta?.apiType);
    const isFreeOrZen = isFreeOrZenModel(model.id, meta);

    const toolsPayload = formatProviderTools(options.tools, isResponses, isFreeOrZen);

    const responsesInput: any[] = isResponses ? buildResponsesInput(formattedMessages) : [];

    const abortController = new AbortController();
    const cancelListener = token.onCancellationRequested(() => { abortController.abort(); });
    const sessionId = this.getConversationSessionId(messages);

    try {
      await this.streamResponse(
        model,
        options,
        progress,
        token,
        abortController,
        meta,
        isResponses,
        lowerId,
        formattedMessages,
        toolsPayload,
        responsesInput,
        apiKey,
        sessionId
      ); return;
    } finally {
      cancelListener.dispose();
    }
  }

  private async streamResponse(
    model: vscode.LanguageModelChatInformation,
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
    abortController: AbortController,
    meta: OpenCodeModelMeta | undefined,
    isResponses: boolean,
    lowerId: string,
    formattedMessages: FormattedMessage[],
    toolsPayload: WireToolDefinition[] | undefined,
    responsesInput: any[],
    apiKey: string,
    sessionId: string
  ): Promise<void> {
    // Free models and Zen-exclusive models route to zen/v1, flat-rate Go models route to zen/go/v1
    const isFreeOrZen = isFreeOrZenModel(model.id, meta);

    const reasoningEffort = getReasoningEffort(options);
    const { url, body: requestBody } = createProviderRequest({
      modelId: model.id,
      isResponses,
      isFreeOrZen,
      formattedMessages,
      toolsPayload,
      responsesInput,
      reasoningEffort,
    });

    this.log(
      `Request: model=${model.id} protocol=${isResponses ? 'responses' : 'chat-completions'} url=${url} reasoningEffort=${reasoningEffort || 'none'} tools=${toolsPayload?.length ?? 0} session=${sessionId.slice(0, 12)}`
    );

    const maxStallRetries = 1;
    const idleTimeoutMs = getStreamIdleTimeoutMs();

    for (let stallAttempt = 0; stallAttempt <= maxStallRetries; stallAttempt++) {
      const clientHeaders = createOpenCodeRequestHeaders(
        apiKey,
        sessionId,
        generateOpenCodeRequestId()
      );

      let res: Response;
      try {
        res = await fetchWithRetry(
          url,
          {
            method: 'POST',
            headers: clientHeaders,
            body: JSON.stringify(requestBody),
            signal: abortController.signal,
          },
          {
            // 5xx / network errors: treated as a likely-dead upstream, so we
            // only give it one quick courtesy retry before surfacing the alert.
            retries: 1,
            baseDelayMs: 300,
            maxDelayMs: 1000,
            // 429: a rate-limit cooldown is a "come back later" signal, not a
            // dead upstream, so it gets its own much more patient budget — 3
            // back-to-back attempts, then 7 more spaced 1s apart (10 retries
            // total), honoring Retry-After up to a 3s cap per wait so a long
            // server-requested cooldown can't block the user for a full minute.
            rateLimitRetries: 10,
            rateLimitImmediateAttempts: 3,
            rateLimitDelayMs: 1000,
            rateLimitMaxWaitMs: 3000,
          }
        );
      } catch (err: any) {
        if (token.isCancellationRequested || abortController.signal.aborted) {
          return;
        }
        this.log(`Request failed before receiving a response: ${err?.message || err}`);
        throw err;
      }

      if (!res.ok) {
        let errText = await res.text().catch(() => '');
        let userDetail = extractErrorMessage(errText);

        this.log(`Upstream returned ${res.status} ${res.statusText}: ${userDetail.slice(0, 300)}`);

        // 0. Responses-API reasoning echo repair: when an idle gap or session rebind causes
        // the upstream to reject replayed reasoning with "reasoning `encrypted_content` was not issued to this caller",
        // strip stale reasoning items from input and retry once transparently.
        if (res.status === 400 && isResponses && userDetail.includes('encrypted_content')) {
          this.log(`Detected reasoning echo error for model=${model.id}, retrying without stale reasoning...`);
          const resanitized = sanitizeResponsesInput(responsesInput).filter((item) => !isStaleReasoningInput(item));
          const retryBody: Record<string, unknown> = {
            ...requestBody,
            input: resanitized.length > 0 ? resanitized : formattedMessages.filter((m) => !isStaleReasoningInput(m)),
          };
          try {
            const retryRes = await fetchWithRetry(
              url,
              {
                method: 'POST',
                headers: {
                  ...clientHeaders,
                  'x-opencode-request': generateOpenCodeRequestId(),
                },
                body: JSON.stringify(retryBody),
                signal: abortController.signal,
              },
              { retries: 0 }
            );
            if (retryRes.ok) {
              res = retryRes;
            } else {
              errText = await retryRes.text().catch(() => '');
              userDetail = extractErrorMessage(errText);
            }
          } catch {}
        }

        if (!res.ok) {
          const isFreeTierError =
            userDetail.includes('FreeTierError') ||
            userDetail.toLowerCase().includes('free tier');

          // 1. Auth errors: throw NoPermissions to let VS Code trigger re-auth prompts if configured.
          // IMPORTANT: Do NOT throw NoPermissions for upstream FreeTierError (e.g. policy/model restriction);
          // doing so causes Copilot to enter an unhelpful 5-retry 16-second loop. Let FreeTierError fall
          // through to the alert notice card for immediate, helpful fail-fast resolution.
          if (!isFreeTierError && (res.status === 401 || res.status === 403)) {
            const LMError = (vscode as any).LanguageModelError;
            const cleanDetail = userDetail.replace(/^OpenCode authentication failed:\s*/i, '').trim();
            const errMessage = cleanDetail
              ? `OpenCode authentication failed: ${cleanDetail}`
              : 'OpenCode authentication failed: Invalid or expired API key.';
            if (LMError?.NoPermissions) {
              throw LMError.NoPermissions(errMessage);
            }
            throw new Error(errMessage);
          }

          // 2. Stale model ID (404 — requested ID was renamed/removed by a later sync,
          // or resurrected from a stale models_cache.json) and 3. upstream server errors
          // (500, 502 Bad Gateway, 503, 504), rate limits, or FreeTierError policy alerts:
          // stream an informative Markdown alert card and resolve cleanly (return void).
          // Instead of throwing an Error (which causes Copilot's runtime to retry 5 times
          // for 32.4 seconds). A thrown NotFound here turns one stale pin into a retry
          // storm, so 404 must take this path too — never throw for it.
          const reason = res.status === 404
            ? 'stale model ID (renamed or removed by a later sync — re-run sync and re-pick the model)'
            : isFreeTierError
              ? 'upstream free-tier policy error'
              : 'upstream server error';
          const alertNotice = [
            `> ⚠️ **OpenCode Model Alert (${res.status} ${res.statusText || 'Service Error'})**`,
            `>`,
            `> Unable to reach **${model.name}** (\`${model.id}\`): ${reason}.`,
            `>`,
            `> **Upstream detail:** \`${userDetail.slice(0, 300) || 'Internal server error'}\``,
          ].join('\n');

          progress.report(new vscode.LanguageModelTextPart(alertNotice));
          return; // Clean resolution bypasses Copilot's 5-retry 32-second loop!
        }
      }

      const streamResult = await consumeProviderStream({
        response: res,
        modelId: model.id,
        tools: options.tools,
        progress,
        token,
        abortSignal: abortController.signal,
        idleTimeoutMs,
        stallAttempt,
        maxStallRetries,
        log: (message) => {
          this.log(message);
        },
      });
      if (streamResult === 'retry') continue;
      return;
    }
  }

  provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken
  ): Thenable<number> {
    const raw = typeof text === 'string' ? text : JSON.stringify(text);
    return Promise.resolve(Math.ceil(raw.length / 4));
  }
}
