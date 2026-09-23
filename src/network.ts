// `undici` is imported dynamically (not statically) and only inside
// `loadProxyAgentCtor()` below. undici's package eagerly requires a Cache API
// polyfill at load time that throws on Node < 22.19 (see its `engines` field),
// so a top-level `import { ProxyAgent } from 'undici'` here would crash
// extension activation entirely on any older Node runtime. Deferring the
// import to first actual use means a missing/incompatible undici only
// disables proxy support, never activation. `import type` is erased at
// compile time and carries no runtime cost or risk.
import type { ProxyAgent as ProxyAgentType } from 'undici';

let proxyAgentCtor: typeof ProxyAgentType | undefined;
let proxyAgentLoadAttempted = false;

async function loadProxyAgentCtor(): Promise<typeof ProxyAgentType | undefined> {
  if (proxyAgentLoadAttempted) return proxyAgentCtor;
  proxyAgentLoadAttempted = true;
  try {
    const undici = await import('undici');
    proxyAgentCtor = undici.ProxyAgent;
  } catch (err) {
    console.warn(
      'OpenCode: proxy support unavailable (failed to load undici); requests will bypass the configured proxy.',
      err
    );
    proxyAgentCtor = undefined;
  }
  return proxyAgentCtor;
}

// Optional proxy URL sourced from VS Code's `http.proxy` setting. Env vars are
// always consulted as a fallback so the extension works in plain Node/CI too.
let vscodeProxyUrl: string | undefined;

export function isOfflineMode(): boolean {
  return process.env.OPENCODE_OFFLINE === '1';
}

export function setVSCodeProxyUrl(url: string | undefined): void {
  vscodeProxyUrl = url || undefined;
  // Config may have changed which proxy to use; drop any cached dispatcher.
  cachedDispatcher = undefined;
  cachedProxyUrl = undefined;
}

function isNoProxyHost(hostname: string, noProxyEnv: string | undefined): boolean {
  if (!noProxyEnv) return false;
  return noProxyEnv
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .some((pattern) => {
      if (pattern === '*') return true;
      const normalized = pattern.replace(/^\./, '');
      return hostname === normalized || hostname.endsWith(`.${normalized}`);
    });
}

export function resolveProxyUrl(targetUrl: string): string | undefined {
  let hostname: string;
  try {
    hostname = new URL(targetUrl).hostname;
  } catch {
    return undefined;
  }

  const noProxy = process.env.NO_PROXY ?? process.env.no_proxy;
  if (isNoProxyHost(hostname, noProxy)) {
    return undefined;
  }

  return (
    vscodeProxyUrl ||
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    undefined
  );
}

let cachedDispatcher: ProxyAgentType | undefined;
let cachedProxyUrl: string | undefined;

export async function getProxyDispatcher(targetUrl: string): Promise<ProxyAgentType | undefined> {
  const proxyUrl = resolveProxyUrl(targetUrl);
  if (!proxyUrl) return undefined;
  if (!cachedDispatcher || cachedProxyUrl !== proxyUrl) {
    const Ctor = await loadProxyAgentCtor();
    if (!Ctor) return undefined;
    cachedDispatcher?.close().catch(() => {});
    cachedDispatcher = new Ctor(proxyUrl);
    cachedProxyUrl = proxyUrl;
  }
  return cachedDispatcher;
}

/**
 * Loosely-typed fetch init bag: standard `RequestInit` fields, plus the
 * non-standard `dispatcher` property Node's undici-backed global `fetch`
 * accepts for proxy routing. Kept as `Record<string, unknown>` (rather than
 * extending `RequestInit`) because the dynamically-imported `undici`
 * package's own `Dispatcher` type doesn't structurally match the one
 * bundled with `@types/node`'s global fetch types — a type-source mismatch
 * between two copies of undici's types, not a real behavioral difference.
 * Callers get real `RequestInit` field names/types via normal object-literal
 * checking against `fetch()`'s overloads; only this bag itself is untyped.
 */
export type FetchInit = Record<string, unknown>;

/** Merge a proxy dispatcher (if applicable) into a fetch init object. */
export async function withProxy(url: string, init: FetchInit = {}): Promise<FetchInit> {
  const dispatcher = await getProxyDispatcher(url);
  return dispatcher ? { ...init, dispatcher } : init;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('Aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('Aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (!Number.isNaN(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(value);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
}

// 429 gets its own retry budget/schedule (see FetchWithRetryOptions below) since
// a rate-limit cooldown is a "come back later" signal, unlike 5xx which more
// often means the upstream is simply broken and unlikely to recover quickly.
const RATE_LIMIT_STATUS = 429;
const OTHER_RETRYABLE_STATUS = new Set([502, 503, 504]);
const RETRYABLE_ERROR_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
  'ECONNREFUSED',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/** Shape of the fields we look at on a caught error; the error itself is `unknown`. */
interface ErrorWithCode {
  code?: unknown;
  cause?: { code?: unknown };
}

function isRetryableError(err: unknown): boolean {
  const e = err as ErrorWithCode | null | undefined;
  const code = e?.cause?.code || e?.code;
  return typeof code === 'string' && RETRYABLE_ERROR_CODES.has(code);
}

function exponentialBackoffMs(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  return Math.min(maxDelayMs, baseDelayMs * 2 ** attempt) + Math.random() * 100;
}

function isRetryableRateLimit(status: number, rateLimitAttempt: number, rateLimitRetries: number): boolean {
  return status === RATE_LIMIT_STATUS && rateLimitAttempt < rateLimitRetries;
}

function isRetryableServerError(status: number, otherAttempt: number, retries: number): boolean {
  return OTHER_RETRYABLE_STATUS.has(status) && otherAttempt < retries;
}

function isRetryableNetworkError(
  err: unknown,
  otherAttempt: number,
  retries: number,
  aborted: boolean
): boolean {
  return otherAttempt < retries && !aborted && isRetryableError(err);
}

interface RateLimitDelayOptions {
  rateLimitImmediateAttempts: number;
  rateLimitDelayMs?: number;
  rateLimitMaxWaitMs: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

/** `FetchWithRetryOptions` with every default applied; see that type for field docs. */
interface ResolvedRetryConfig {
  retries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  rateLimitRetries: number;
  rateLimitImmediateAttempts: number;
  rateLimitDelayMs?: number;
  rateLimitMaxWaitMs: number;
}

// Isolated purely so the six `??` default-value picks (each its own decision
// point) don't count against fetchWithRetry's own complexity budget.
function resolveRetryConfig(opts: FetchWithRetryOptions): ResolvedRetryConfig {
  const retries = opts.retries ?? 2;
  return {
    retries,
    baseDelayMs: opts.baseDelayMs ?? 300,
    maxDelayMs: opts.maxDelayMs ?? 4000,
    rateLimitRetries: opts.rateLimitRetries ?? retries,
    rateLimitImmediateAttempts: opts.rateLimitImmediateAttempts ?? 0,
    rateLimitDelayMs: opts.rateLimitDelayMs,
    rateLimitMaxWaitMs: opts.rateLimitMaxWaitMs ?? Infinity,
  };
}

/** Outcome of a single fetch attempt, telling the retry loop what to do next. */
type AttemptOutcome =
  | { kind: 'done'; res: Response }
  | { kind: 'throw'; err: unknown }
  | { kind: 'retry'; bucket: 'rateLimit' | 'other'; delayMs: number; err?: unknown };

// One fetch call plus its retry classification, isolated so the loop driver
// (fetchWithRetry) doesn't carry the try/catch and status/error branching
// directly, which is most of what pushed its complexity over budget.
async function attemptOnce(
  url: string,
  init: FetchInit,
  signal: AbortSignal | undefined,
  rateLimitAttempt: number,
  otherAttempt: number,
  config: ResolvedRetryConfig
): Promise<AttemptOutcome> {
  // If the caller passed its own AbortSignal and it's already aborted, don't retry.
  if (signal?.aborted) {
    return { kind: 'throw', err: signal.reason ?? new Error('Aborted') };
  }
  try {
    const res = await fetch(url, await withProxy(url, init));

    if (isRetryableRateLimit(res.status, rateLimitAttempt, config.rateLimitRetries)) {
      const delayMs = computeRateLimitDelay(res, rateLimitAttempt, config);
      return { kind: 'retry', bucket: 'rateLimit', delayMs };
    }
    if (isRetryableServerError(res.status, otherAttempt, config.retries)) {
      const delayMs = exponentialBackoffMs(otherAttempt, config.baseDelayMs, config.maxDelayMs);
      return { kind: 'retry', bucket: 'other', delayMs };
    }
    return { kind: 'done', res };
  } catch (err) {
    if (isRetryableNetworkError(err, otherAttempt, config.retries, !!signal?.aborted)) {
      const delayMs = exponentialBackoffMs(otherAttempt, config.baseDelayMs, config.maxDelayMs);
      return { kind: 'retry', bucket: 'other', delayMs, err };
    }
    return { kind: 'throw', err };
  }
}

// Picks the wait before the next 429 retry, in priority order: (1) honor a
// server-provided Retry-After, capped at rateLimitMaxWaitMs; (2) the opt-in
// immediate-then-spaced schedule; (3) the same exponential backoff used for
// 5xx, which is what callers get today if they don't opt into (2).
function computeRateLimitDelay(res: Response, rateLimitAttempt: number, opts: RateLimitDelayOptions): number {
  const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
  if (retryAfterMs != null) {
    return Math.min(retryAfterMs, opts.rateLimitMaxWaitMs);
  }
  if (opts.rateLimitDelayMs != null) {
    return rateLimitAttempt < opts.rateLimitImmediateAttempts
      ? Math.random() * 100
      : opts.rateLimitDelayMs + Math.random() * 100;
  }
  return exponentialBackoffMs(rateLimitAttempt, opts.baseDelayMs, opts.maxDelayMs);
}

export interface FetchWithRetryOptions {
  /** Retry budget for 5xx and transient network errors. */
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /**
   * Retry budget specifically for 429 (Too Many Requests), independent of
   * `retries`. Defaults to `retries` (i.e. no special treatment) so callers
   * that don't opt in keep today's exact behavior.
   */
  rateLimitRetries?: number;
  /**
   * How many of the 429 retries fire back-to-back with only jitter (no
   * deliberate delay) before `rateLimitDelayMs` spacing kicks in. Only
   * meaningful when `rateLimitDelayMs` is also set.
   */
  rateLimitImmediateAttempts?: number;
  /**
   * Fixed delay used for 429 retries once past `rateLimitImmediateAttempts`,
   * when no `Retry-After` header is present. When omitted, 429 falls back to
   * the same exponential backoff used for 5xx (today's behavior).
   */
  rateLimitDelayMs?: number;
  /**
   * Upper bound applied to a server-provided `Retry-After` wait for 429.
   * Defaults to unbounded (today's behavior) so a long cooldown is honored
   * in full unless a caller explicitly wants to cap it for UX reasons.
   */
  rateLimitMaxWaitMs?: number;
}

/**
 * fetch() wrapper that is proxy-aware and retries transient failures with
 * two independent policies: a patient one for 429 (Too Many Requests, which
 * is expected to resolve after a cooldown) and a minimal one for 5xx/network
 * errors (which more often indicate a genuinely broken upstream). Honors
 * Retry-After when present. Intended for connection-establishment only
 * (model listing, metadata fetches, and the initial chat request) — never
 * wrap a call after you've started reading a response body, since retrying
 * there could duplicate already-streamed content.
 */
export async function fetchWithRetry(
  url: string,
  init: FetchInit = {},
  opts: FetchWithRetryOptions = {}
): Promise<Response> {
  if (isOfflineMode()) {
    throw new Error('Network requests are disabled while OPENCODE_OFFLINE=1.');
  }

  const config = resolveRetryConfig(opts);
  // Sum, not max: each class's own budget check is what actually stops
  // retrying, so the outer bound just needs to be generous enough to cover
  // the worst case where both budgets get consumed across a mixed sequence
  // (e.g. a few 429s followed by a 502). A single-class sequence still
  // exhausts at exactly its own budget, well before this bound is reached.
  const maxAttempts = config.retries + config.rateLimitRetries;
  // `init.signal` is read repeatedly below; extract and cast once here
  // since `init` is an untyped bag (see `FetchInit`).
  const signal = init.signal as AbortSignal | undefined;

  let lastErr: unknown;
  let rateLimitAttempt = 0;
  let otherAttempt = 0;
  for (let attempt = 0; attempt <= maxAttempts; attempt++) {
    // Abort is checked at the top of attemptOnce (before each new attempt).
    const outcome = await attemptOnce(url, init, signal, rateLimitAttempt, otherAttempt, config);
    if (outcome.kind === 'done') return outcome.res;
    if (outcome.kind === 'throw') throw outcome.err;

    await sleep(outcome.delayMs, signal);
    if (outcome.bucket === 'rateLimit') {
      rateLimitAttempt++;
    } else {
      otherAttempt++;
      // Only network-error retries carry `err`; a retried 5xx status leaves
      // it undefined so it never overwrites a real prior error (matches
      // pre-refactor behavior, where lastErr was only set inside `catch`).
      if (outcome.err !== undefined) lastErr = outcome.err;
    }
  }
  throw lastErr;
}
