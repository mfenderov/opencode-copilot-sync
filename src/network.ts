export { isOfflineMode, fetchWithRetry } from './infrastructure/http/fetch-policy.js';
export type { FetchInit, FetchWithRetryOptions } from './infrastructure/http/fetch-policy.js';
export {
  resolveProxyUrl,
  getProxyDispatcher,
  withProxy,
  setVSCodeProxyUrl,
} from './infrastructure/http/proxy-routing.js';
