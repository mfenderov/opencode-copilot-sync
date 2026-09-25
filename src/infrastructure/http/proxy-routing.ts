// Shared infrastructure: proxy routing.
// `undici` is imported dynamically (not statically) and only inside
// `loadProxyAgentCtor()` below. undici's package eagerly requires a Cache API
// polyfill at load time that throws on Node < 22.19 (see its `engines` field),
// so a top-level `import { ProxyAgent } from 'undici'` here would crash
// extension activation entirely on any older Node runtime. Deferring the
// import to first actual use means a missing/incompatible undici only
// disables proxy support, never activation. `import type` is erased at
// compile time and carries no runtime cost or risk.
import type { ProxyAgent as ProxyAgentType } from 'undici';
import type { FetchInit } from './fetch-policy.js';

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
export async function withProxy(url: string, init: FetchInit = {}): Promise<FetchInit> {
  const dispatcher = await getProxyDispatcher(url);
  return dispatcher ? { ...init, dispatcher } : init;
}
