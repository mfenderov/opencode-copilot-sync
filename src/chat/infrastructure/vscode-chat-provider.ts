import * as vscode from 'vscode';
import { fetchWithRetry } from '../../infrastructure/http/fetch-policy.js';
import type { OpenCodeModelMeta } from '../../models/domain/model.js';
import { readModelCache, writeModelCache } from '../../models/infrastructure/model-cache.js';
import { resolveModelTokenLimits } from '../../models/domain/token-budget.js';
import {
  buildResponsesInput,
  formatProviderMessages,
  sanitizeResponsesInput,
} from '../infrastructure/message-mapper.js';
import type { FormattedMessage } from '../infrastructure/message-mapper.js';
import { formatProviderTools } from '../infrastructure/tool-mapper.js';
import type { WireToolDefinition } from '../infrastructure/tool-mapper.js';
import {
  createOpenCodeRequestHeaders,
  createProviderRequest,
  isFreeOrZenModel,
  isResponsesModel,
} from '../infrastructure/request-factory.js';
import {
  getReasoningEffort,
  isStaleReasoningInput,
} from '../infrastructure/reasoning-controls.js';
import { consumeProviderStream } from '../application/send-chat-message.js';
import { getStreamIdleTimeoutMs } from '../application/recover-stream.js';
import { VERIFIED_OPENCODE_MODELS } from '../../models/infrastructure/verified-catalog.js';
import { ChatSessionCache, generateOpenCodeRequestId } from '../domain/chat-session.js';

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

          // 2. Stale model ID (404: requested ID was renamed or removed by a later sync,
          // or resurrected from a stale models_cache.json) and 3. upstream server errors
          // (500, 502 Bad Gateway, 503, 504), rate limits, or FreeTierError policy alerts:
          // stream an informative Markdown alert card and resolve cleanly (return void).
          // A thrown Error makes Copilot retry 5 times for 32.4 seconds. A thrown
          // NotFound here turns one stale pin into a retry storm. Never throw for 404.
          const reason = res.status === 404
            ? 'stale model ID (renamed or removed by a later sync; re-run sync and re-pick the model)'
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
          return; // Clean resolution bypasses the Copilot retry loop.
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
