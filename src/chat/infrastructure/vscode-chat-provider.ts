// Chat infrastructure: native VS Code chat provider adapter.
import * as vscode from 'vscode';
import { fetchWithRetry } from '../../infrastructure/http/fetch-policy.js';
import type { OpenCodeModelMeta } from '../../models/domain/model.js';
import { readModelCache, writeModelCache } from '../../models/infrastructure/model-cache.js';
import { resolveModelTokenLimits } from '../../models/domain/token-budget.js';
import {
  buildResponsesInput,
  formatProviderMessages,
  sanitizeResponsesInput,
} from './message-mapper.js';
import type { FormattedMessage } from './message-mapper.js';
import { formatProviderTools } from './tool-mapper.js';
import type { WireToolDefinition } from './tool-mapper.js';
import {
  createOpenCodeRequestHeaders,
  createProviderRequest,
  isFreeOrZenModel,
  isResponsesModel,
} from './request-factory.js';
import {
  getReasoningEffort,
  isStaleReasoningInput,
} from './reasoning-controls.js';
import { consumeProviderStream } from '../application/send-chat-message.js';
import { getStreamIdleTimeoutMs } from '../application/recover-stream.js';
import { VERIFIED_OPENCODE_MODELS } from '../../models/infrastructure/verified-catalog.js';
import { ChatSessionCache, generateOpenCodeRequestId } from '../domain/chat-session.js';

function resolveValidEfforts(model: OpenCodeModelMeta): string[] | undefined {
  const supportsReasoning = model.thinking !== false;
  const rawEfforts = model.supportsReasoningEffort;
  if (supportsReasoning && Array.isArray(rawEfforts) && rawEfforts.length > 0) {
    return rawEfforts.filter((e) => e !== 'none');
  }
  return undefined;
}

function buildConfigurationSchema(
  validEfforts: string[] | undefined,
  contextWindow: number
): Record<string, unknown> | undefined {
  const properties: Record<string, unknown> = {};
  if (validEfforts && validEfforts.length > 0) {
    properties.reasoningEffort = {
      type: 'string',
      title: 'Thinking Effort',
      enum: validEfforts,
      enumItemLabels: validEfforts.map(effortLabel),
      enumDescriptions: validEfforts.map(effortDescription),
      default: validEfforts.includes('medium') ? 'medium' : validEfforts[0],
      group: 'navigation',
    };
  }
  if (contextWindow > 256000) {
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
  return Object.keys(properties).length > 0 ? { properties } : undefined;
}

function describeModel(model: OpenCodeModelMeta): Record<string, unknown> {
  const validEfforts = resolveValidEfforts(model);
  const tokenLimits = resolveModelTokenLimits(model.contextWindow, model.maxOutputTokens);
  return {
    id: model.id,
    name: model.name,
    family: model.family,
    version: '1.0.0',
    maxInputTokens: tokenLimits.maxInputTokens,
    maxOutputTokens: tokenLimits.maxOutputTokens,
    capabilities: {
      imageInput: model.vision,
      vision: model.vision,
      toolCalling: true,
      thinking: model.thinking !== false,
    },
    supportsReasoningEffort: validEfforts,
    supportedReasoningEfforts: validEfforts,
    defaultReasoningEffort: validEfforts?.includes('medium') ? 'medium' : validEfforts?.[0],
    configurationSchema: buildConfigurationSchema(validEfforts, model.contextWindow),
    isBYOK: true,
  };
}

interface ReasoningRepairInput {
  responsesInput: unknown[];
  formattedMessages: FormattedMessage[];
  requestBody: Record<string, unknown>;
}

interface StreamAttempt {
  url: string;
  clientHeaders: Record<string, string>;
  abortSignal: AbortSignal;
}

interface UpstreamErrorContext {
  model: vscode.LanguageModelChatInformation;
  isResponses: boolean;
}

/**
 * Transparent repair for Responses-API reasoning echoes: when an idle gap or
 * session rebind causes the upstream to reject replayed reasoning with
 * "reasoning `encrypted_content` was not issued to this caller", strip the
 * stale reasoning items and retry once. Returns the replacement response, or
 * undefined when no repair was attempted.
 */
async function tryRepairReasoningEcho(
  res: Response,
  userDetail: string,
  attempt: StreamAttempt,
  input: ReasoningRepairInput,
  ctx: UpstreamErrorContext,
  log: (message: string) => void
): Promise<Response | undefined> {
  if (res.status !== 400 || !ctx.isResponses || !userDetail.includes('encrypted_content')) {
    return undefined;
  }
  log(`Detected reasoning echo error for model=${ctx.model.id}, retrying without stale reasoning...`);
  const resanitized = sanitizeResponsesInput(input.responsesInput).filter((item) => !isStaleReasoningInput(item));
  const retryBody: Record<string, unknown> = {
    ...input.requestBody,
    input: resanitized.length > 0 ? resanitized : input.formattedMessages.filter((m) => !isStaleReasoningInput(m)),
  };
  try {
    const retryRes = await fetchWithRetry(
      attempt.url,
      {
        method: 'POST',
        headers: { ...attempt.clientHeaders, 'x-opencode-request': generateOpenCodeRequestId() },
        body: JSON.stringify(retryBody),
        signal: attempt.abortSignal,
      },
      { retries: 0 }
    );
    return retryRes;
  } catch {
    return undefined;
  }
}

interface AuthErrorInput {
  res: Response;
  userDetail: string;
  isFreeTierError: boolean;
}

/**
 * Auth errors throw NoPermissions so VS Code can trigger re-auth prompts —
 * except upstream FreeTierError policy errors, which would send Copilot into
 * an unhelpful 5-retry 16-second loop and are better served by the alert card.
 * Returns nothing when no auth error applies.
 */
function throwForAuthError(input: AuthErrorInput): void {
  // IMPORTANT: Do NOT throw NoPermissions for upstream FreeTierError (e.g.
  // policy/model restriction); let it fall through to the alert notice card
  // for immediate, helpful fail-fast resolution.
  if (input.isFreeTierError || (input.res.status !== 401 && input.res.status !== 403)) {
    return;
  }
  const LMError = (vscode as any).LanguageModelError;
  const cleanDetail = input.userDetail.replace(/^OpenCode authentication failed:\s*/i, '').trim();
  const errMessage = cleanDetail
    ? `OpenCode authentication failed: ${cleanDetail}`
    : 'OpenCode authentication failed: Invalid or expired API key.';
  if (LMError?.NoPermissions) {
    throw LMError.NoPermissions(errMessage);
  }
  throw new Error(errMessage);
}

function buildAlertNotice(res: Response, model: vscode.LanguageModelChatInformation, reason: string, userDetail: string): string {
  return [
    `> ⚠️ **OpenCode Model Alert (${res.status} ${res.statusText || 'Service Error'})**`,
    `>`,
    `> Unable to reach **${model.name}** (\`${model.id}\`): ${reason}.`,
    `>`,
    `> **Upstream detail:** \`${userDetail.slice(0, 300) || 'Internal server error'}\``,
  ].join('\n');
}

/**
 * Handles a non-ok upstream response: repairs stale reasoning once, throws for
 * auth failures, and otherwise streams an informative alert card and resolves
 * cleanly — a thrown Error makes Copilot retry 5 times for 32.4 seconds, and a
 * thrown NotFound turns one stale pin into a retry storm. Never throw for 404.
 * Returns 'handled' when the request is done, 'stream' when the caller should
 * consume the (possibly repaired) response.
 */
async function handleUpstreamError(
  res: Response,
  errText: string,
  attempt: StreamAttempt,
  input: ReasoningRepairInput,
  ctx: UpstreamErrorContext,
  progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  log: (message: string) => void
): Promise<{ outcome: 'handled' | 'stream'; res: Response; userDetail: string }> {
  let userDetail = extractErrorMessage(errText);
  log(`Upstream returned ${res.status} ${res.statusText}: ${userDetail.slice(0, 300)}`);

  const repaired = await tryRepairReasoningEcho(res, userDetail, attempt, input, ctx, log);
  if (repaired) {
    if (repaired.ok) {
      return { outcome: 'stream', res: repaired, userDetail };
    }
    errText = await repaired.text().catch(() => '');
    userDetail = extractErrorMessage(errText);
    res = repaired;
  }

  if (!res.ok) {
    const isFreeTierError =
      userDetail.includes('FreeTierError') || userDetail.toLowerCase().includes('free tier');
    throwForAuthError({ res, userDetail, isFreeTierError });

    const reason = classifyUpstreamAlert(res.status, userDetail, isFreeTierError);
    progress.report(new vscode.LanguageModelTextPart(buildAlertNotice(res, ctx.model, reason, userDetail)));
    return { outcome: 'handled', res, userDetail };
  }
  return { outcome: 'stream', res, userDetail };
}

interface StallAttemptInput {
  url: string;
  requestBody: Record<string, unknown>;
  apiKey: string;
  sessionId: string;
  abortSignal: AbortSignal;
}

const TRANSIENT_RETRY_POLICY = {
  // 5xx / network errors: treated as a likely-dead upstream, so we only give
  // it one quick courtesy retry before surfacing the alert.
  retries: 1,
  baseDelayMs: 300,
  maxDelayMs: 1000,
  // 429: a rate-limit cooldown is a "come back later" signal, not a dead
  // upstream, so it gets its own much more patient budget — 3 back-to-back
  // attempts, then 7 more spaced 1s apart (10 retries total), honoring
  // Retry-After up to a 3s cap per wait so a long server-requested cooldown
  // can't block the user for a full minute.
  rateLimitRetries: 10,
  rateLimitImmediateAttempts: 3,
  rateLimitDelayMs: 1000,
  rateLimitMaxWaitMs: 3000,
};

/**
 * One upstream POST attempt. Returns the response with its headers, or
 * 'cancelled' when the request died before receiving one and the caller was
 * the one who cancelled.
 */
interface AttemptOutcome {
  res: Response;
  clientHeaders: Record<string, string>;
}

async function postUpstreamRequest(
  input: StallAttemptInput,
  token: vscode.CancellationToken,
  log: (message: string) => void
): Promise<AttemptOutcome | 'cancelled'> {
  const clientHeaders = createOpenCodeRequestHeaders(
    input.apiKey,
    input.sessionId,
    generateOpenCodeRequestId()
  );
  let res: Response;
  try {
    res = await fetchWithRetry(
      input.url,
      {
        method: 'POST',
        headers: clientHeaders,
        body: JSON.stringify(input.requestBody),
        signal: input.abortSignal,
      },
      TRANSIENT_RETRY_POLICY
    );
    return { res, clientHeaders };
  } catch (err: any) {
    if (token.isCancellationRequested || input.abortSignal.aborted) {
      return 'cancelled';
    }
    log(`Request failed before receiving a response: ${err?.message || err}`);
    throw err;
  }
}

interface StallLoopInput {
  url: string;
  requestBody: Record<string, unknown>;
  apiKey: string;
  sessionId: string;
  model: vscode.LanguageModelChatInformation;
  options: vscode.ProvideLanguageModelChatResponseOptions;
  progress: vscode.Progress<vscode.LanguageModelResponsePart>;
  token: vscode.CancellationToken;
  abortSignal: AbortSignal;
  isResponses: boolean;
  formattedMessages: FormattedMessage[];
  responsesInput: unknown[];
  idleTimeoutMs: number;
  maxStallRetries: number;
}

/**
 * One pass through the stall-retry loop: POST, repair or surface any upstream
 * error, then consume the stream. Returns 'done' when the request is finished
 * and 'retry' when the stream asked for another attempt.
 */
async function runStallAttempt(
  input: StallLoopInput,
  stallAttempt: number,
  log: (message: string) => void
): Promise<'done' | 'retry'> {
  const posted = await postUpstreamRequest(
    {
      url: input.url,
      requestBody: input.requestBody,
      apiKey: input.apiKey,
      sessionId: input.sessionId,
      abortSignal: input.abortSignal,
    },
    input.token,
    log
  );
  if (posted === 'cancelled') {
    return 'done';
  }

  let res = posted.res;
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    const handled = await handleUpstreamError(
      res,
      errText,
      { url: input.url, clientHeaders: posted.clientHeaders, abortSignal: input.abortSignal },
      {
        responsesInput: input.responsesInput,
        formattedMessages: input.formattedMessages,
        requestBody: input.requestBody,
      },
      { model: input.model, isResponses: input.isResponses },
      input.progress,
      log
    );
    if (handled.outcome === 'handled') {
      return 'done';
    }
    res = handled.res;
  }

  const streamResult = await consumeProviderStream({
    response: res,
    modelId: input.model.id,
    tools: input.options.tools,
    progress: input.progress,
    token: input.token,
    abortSignal: input.abortSignal,
    idleTimeoutMs: input.idleTimeoutMs,
    stallAttempt,
    maxStallRetries: input.maxStallRetries,
    log,
  });
  return streamResult;
}

function effortLabel(effort: string): string {
  switch (effort) {
    case 'minimal': return 'Minimal';
    case 'low': return 'Low';
    case 'medium': return 'Medium';
    case 'high': return 'High';
    case 'xhigh': return 'Extra High';
    case 'max': return 'Max';
    default: return effort.charAt(0).toUpperCase() + effort.slice(1);
  }
}

function effortDescription(effort: string): string {
  switch (effort) {
    case 'minimal': return 'Minimal reasoning';
    case 'low': return 'Faster responses with light reasoning';
    case 'medium': return 'Balanced reasoning and speed';
    case 'high': return 'Deep reasoning';
    case 'xhigh': return 'Extra deep reasoning';
    case 'max': return 'Maximum reasoning depth';
    default: return `${effort} reasoning`;
  }
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

export function isSchemaValidationError(status: number, detail: string): boolean {
  // A schema-validation 400 means we sent something the gateway refuses, not
  // that the gateway is unhealthy. Reporting it as a server error sends the
  // user looking at the wrong thing — and a recurring one here means the
  // sanitizer did not cover every schema position.
  return status === 400 && /\benum\b|\bschema\b|too many|exceeds|invalid_request/i.test(detail);
}

export function classifyUpstreamAlert(status: number, detail: string, isFreeTierError: boolean): string {
  if (status === 404) {
    return 'stale model ID (renamed or removed by a later sync; re-run sync and re-pick the model)';
  }
  if (isFreeTierError) {
    return 'upstream free-tier policy error';
  }
  if (isSchemaValidationError(status, detail)) {
    return 'tool schema rejected by upstream (an attached tool declares a constraint the gateway cannot accept; retry without that tool, or re-run sync)';
  }
  return 'upstream server error';
}

export class OpenCodeChatProvider implements vscode.LanguageModelChatProvider {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this._onDidChange.event;
  private _models: OpenCodeModelMeta[] = [...VERIFIED_OPENCODE_MODELS];

  // Copilot resends full conversation history each turn, so a conversation's first message
  // stays constant across its turns. Conversations are bucketed by a fingerprint of that
  // first message, since VS Code's chat provider API exposes no native conversation/session id.
  //
  // Same-opener chats fork on divergence: entries track the longest fingerprint chain
  // seen so far, and a new chain that extends a different branch of the same root
  // gets its own session instead of bleeding into the first chat's upstream context.
  private readonly sessionCache = new ChatSessionCache();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly outputChannel?: vscode.OutputChannel
  ) {
    try {
      const cached = readModelCache(this.context.globalStorageUri.fsPath);
      if (cached) {
        this._models = cached;
      }
    } catch {}
  }

  private log(message: string): void {
    this.outputChannel?.appendLine(`[Provider] ${message}`);
  }

  refresh(): void {
    this._onDidChange.fire();
  }

  updateModels(models: OpenCodeModelMeta[]): void {
    if (Array.isArray(models) && models.length > 0) {
      this._models = models;
      this.refresh();
      try {
        writeModelCache(this.context.globalStorageUri.fsPath, models);
      } catch {}
    }
  }

  async provideLanguageModelChatInformation(
    _options: vscode.PrepareLanguageModelChatModelOptions,
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelChatInformation[]> {
    return this._models.map((m) => describeModel(m) as any);
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

    const meta = this._models.find((m) => m.id === model.id || model.id.endsWith('/' + m.id));
    const isResponses = isResponsesModel(model.id, meta?.apiType);
    const isFreeOrZen = isFreeOrZenModel(model.id, meta);

    const toolsPayload = formatProviderTools(options.tools, isResponses, isFreeOrZen, (message) => {
      this.log(message);
    });

    const responsesInput: any[] = isResponses ? buildResponsesInput(formattedMessages) : [];

    const abortController = new AbortController();
    const cancelListener = token.onCancellationRequested(() => { abortController.abort(); });
    const sessionId = this.sessionCache.getConversationSessionId(messages);

    try {
      await this.streamResponse(
        model,
        options,
        progress,
        token,
        abortController,
        meta,
        isResponses,
        isFreeOrZen,
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
    isFreeOrZen: boolean,
    formattedMessages: FormattedMessage[],
    toolsPayload: WireToolDefinition[] | undefined,
    responsesInput: any[],
    apiKey: string,
    sessionId: string
  ): Promise<void> {
    // Free models and Zen-exclusive models route to zen/v1, flat-rate Go models route to zen/go/v1
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
    const logger = (message: string): void => {
      this.log(message);
    };
    const loopInput: StallLoopInput = {
      url,
      requestBody,
      apiKey,
      sessionId,
      model,
      options,
      progress,
      token,
      abortSignal: abortController.signal,
      isResponses,
      formattedMessages,
      responsesInput,
      idleTimeoutMs,
      maxStallRetries,
    };

    for (let stallAttempt = 0; stallAttempt <= maxStallRetries; stallAttempt++) {
      const outcome = await runStallAttempt(loopInput, stallAttempt, logger);
      if (outcome === 'retry') continue;
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
