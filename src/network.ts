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

/** Merge a proxy dispatcher (if applicable) into a fetch init object. */
export async function withProxy(
  url: string,
  init: Record<string, any> = {}
): Promise<Record<string, any>> {
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

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
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

function isRetryableError(err: any): boolean {
  const code = err?.cause?.code || err?.code;
  return typeof code === 'string' && RETRYABLE_ERROR_CODES.has(code);
}

export interface FetchWithRetryOptions {
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

/**
 * fetch() wrapper that is proxy-aware and retries transient failures
 * (network errors, 429, 502/503/504) with exponential backoff, honoring
 * Retry-After when present. Intended for connection-establishment only
 * (model listing, metadata fetches, and the initial chat request) — never
 * wrap a call after you've started reading a response body, since retrying
 * there could duplicate already-streamed content.
 */
export async function fetchWithRetry(
  url: string,
  init: Record<string, any> = {},
  opts: FetchWithRetryOptions = {}
): Promise<Response> {
  const retries = opts.retries ?? 2;
  const baseDelayMs = opts.baseDelayMs ?? 300;
  const maxDelayMs = opts.maxDelayMs ?? 4000;

  let lastErr: any;
  for (let attempt = 0; attempt <= retries; attempt++) {
    // If the caller passed its own AbortSignal and it's already aborted, don't retry.
    if (init.signal?.aborted) {
      throw init.signal.reason ?? new Error('Aborted');
    }
    try {
      const res = await fetch(url, await withProxy(url, init));
      if (RETRYABLE_STATUS.has(res.status) && attempt < retries) {
        const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
        const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt) + Math.random() * 100;
        await sleep(retryAfterMs ?? backoff, init.signal as AbortSignal | undefined);
        continue;
      }
      return res;
    } catch (err: any) {
      lastErr = err;
      if (attempt < retries && isRetryableError(err) && !init.signal?.aborted) {
        const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt) + Math.random() * 100;
        await sleep(backoff, init.signal as AbortSignal | undefined);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}
