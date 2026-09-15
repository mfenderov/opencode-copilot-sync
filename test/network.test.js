import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveProxyUrl,
  setVSCodeProxyUrl,
  withProxy,
  getProxyDispatcher,
  fetchWithRetry,
} from '../out/network.js';

// Snapshot/restore proxy-related env vars around every test so a developer's
// real shell environment (or CI runner) can't leak into assertions, and so
// tests don't leak into each other.
const PROXY_ENV_KEYS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy'];

function withCleanProxyEnv(fn) {
  return async () => {
    const saved = {};
    for (const k of PROXY_ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    setVSCodeProxyUrl(undefined);
    try {
      await fn();
    } finally {
      for (const k of PROXY_ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      setVSCodeProxyUrl(undefined);
    }
  };
}

// ============================================================================
// resolveProxyUrl
// ============================================================================

test(
  'resolveProxyUrl returns undefined when no proxy is configured anywhere',
  withCleanProxyEnv(() => {
    assert.equal(resolveProxyUrl('https://opencode.ai/zen/v1/models'), undefined);
  })
);

test(
  'resolveProxyUrl falls back to HTTPS_PROXY env var',
  withCleanProxyEnv(() => {
    process.env.HTTPS_PROXY = 'http://env-proxy.example:8080';
    assert.equal(resolveProxyUrl('https://opencode.ai/zen/v1/models'), 'http://env-proxy.example:8080');
  })
);

test(
  'resolveProxyUrl falls back to HTTP_PROXY when HTTPS_PROXY is absent',
  withCleanProxyEnv(() => {
    process.env.HTTP_PROXY = 'http://http-only-proxy.example:3128';
    assert.equal(resolveProxyUrl('https://opencode.ai/zen/v1/models'), 'http://http-only-proxy.example:3128');
  })
);

test(
  'resolveProxyUrl prefers the VS Code http.proxy setting over env vars',
  withCleanProxyEnv(() => {
    process.env.HTTPS_PROXY = 'http://env-proxy.example:8080';
    setVSCodeProxyUrl('http://vscode-proxy.example:9999');
    assert.equal(resolveProxyUrl('https://opencode.ai/zen/v1/models'), 'http://vscode-proxy.example:9999');
  })
);

test(
  'resolveProxyUrl honors NO_PROXY exact-host and suffix matches',
  withCleanProxyEnv(() => {
    process.env.HTTPS_PROXY = 'http://env-proxy.example:8080';
    process.env.NO_PROXY = 'opencode.ai,.internal.example';
    assert.equal(resolveProxyUrl('https://opencode.ai/zen/v1/models'), undefined);
    assert.equal(resolveProxyUrl('https://api.internal.example/foo'), undefined);
    // Unrelated host is still proxied.
    assert.equal(resolveProxyUrl('https://other.example/foo'), 'http://env-proxy.example:8080');
  })
);

test(
  'resolveProxyUrl treats NO_PROXY="*" as bypassing the proxy for every host',
  withCleanProxyEnv(() => {
    process.env.HTTPS_PROXY = 'http://env-proxy.example:8080';
    process.env.NO_PROXY = '*';
    assert.equal(resolveProxyUrl('https://opencode.ai/zen/v1/models'), undefined);
  })
);

test(
  'resolveProxyUrl returns undefined for an unparsable URL instead of throwing',
  withCleanProxyEnv(() => {
    process.env.HTTPS_PROXY = 'http://env-proxy.example:8080';
    assert.equal(resolveProxyUrl('not a url'), undefined);
  })
);

// ============================================================================
// withProxy / getProxyDispatcher
// ============================================================================

test(
  'withProxy leaves init untouched when no proxy is configured',
  withCleanProxyEnv(async () => {
    const init = { method: 'GET' };
    const result = await withProxy('https://opencode.ai/zen/v1/models', init);
    assert.equal(result, init);
    assert.equal(result.dispatcher, undefined);
  })
);

test(
  'withProxy attaches a dispatcher when a proxy is configured, without mutating the original init',
  withCleanProxyEnv(async () => {
    setVSCodeProxyUrl('http://127.0.0.1:1');
    const init = { method: 'GET' };
    const result = await withProxy('https://opencode.ai/zen/v1/models', init);
    assert.notEqual(result, init);
    assert.equal(init.dispatcher, undefined, 'must not mutate the caller-supplied init object');
    assert.ok(result.dispatcher, 'expected a dispatcher to be attached');
    const dispatcher = await getProxyDispatcher('https://opencode.ai/zen/v1/models');
    await dispatcher?.close().catch(() => {});
  })
);

// ============================================================================
// fetchWithRetry
// ============================================================================

test(
  'fetchWithRetry returns immediately on a successful first attempt without retrying',
  withCleanProxyEnv(async () => {
    let calls = 0;
    const original = globalThis.fetch;
    globalThis.fetch = async () => {
      calls++;
      return new Response('ok', { status: 200 });
    };
    try {
      const res = await fetchWithRetry('https://opencode.ai/zen/v1/models', {}, { retries: 2, baseDelayMs: 1 });
      assert.equal(res.status, 200);
      assert.equal(calls, 1);
    } finally {
      globalThis.fetch = original;
    }
  })
);

test('fetchWithRetry retries on a 503 and succeeds once the upstream recovers', async () => {
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    calls++;
    if (calls < 3) return new Response('unavailable', { status: 503 });
    return new Response('ok', { status: 200 });
  };
  try {
    const res = await fetchWithRetry('https://opencode.ai/zen/v1/models', {}, { retries: 3, baseDelayMs: 1, maxDelayMs: 5 });
    assert.equal(res.status, 200);
    assert.equal(calls, 3);
  } finally {
    globalThis.fetch = original;
  }
});

test('fetchWithRetry gives up and returns the last non-OK response after exhausting retries', async () => {
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    calls++;
    return new Response('still down', { status: 502 });
  };
  try {
    const res = await fetchWithRetry('https://opencode.ai/zen/v1/models', {}, { retries: 2, baseDelayMs: 1, maxDelayMs: 5 });
    assert.equal(res.status, 502);
    assert.equal(calls, 3, 'expected 1 initial attempt + 2 retries');
  } finally {
    globalThis.fetch = original;
  }
});

test('fetchWithRetry does not retry a non-retryable 4xx status like 404', async () => {
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    calls++;
    return new Response('not found', { status: 404 });
  };
  try {
    const res = await fetchWithRetry('https://opencode.ai/zen/v1/models', {}, { retries: 3, baseDelayMs: 1 });
    assert.equal(res.status, 404);
    assert.equal(calls, 1, 'a 404 must not trigger any retry attempts');
  } finally {
    globalThis.fetch = original;
  }
});

test('fetchWithRetry retries a retryable network error (ECONNRESET) and eventually throws once exhausted', async () => {
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    calls++;
    const err = new Error('socket hang up');
    err.code = 'ECONNRESET';
    throw err;
  };
  try {
    await assert.rejects(
      fetchWithRetry('https://opencode.ai/zen/v1/models', {}, { retries: 2, baseDelayMs: 1, maxDelayMs: 5 }),
      /socket hang up/
    );
    assert.equal(calls, 3, 'expected 1 initial attempt + 2 retries before giving up');
  } finally {
    globalThis.fetch = original;
  }
});

test('fetchWithRetry does not retry a non-retryable error code', async () => {
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    calls++;
    const err = new Error('bad request body');
    err.code = 'ERR_INVALID_ARG_TYPE';
    throw err;
  };
  try {
    await assert.rejects(
      fetchWithRetry('https://opencode.ai/zen/v1/models', {}, { retries: 3, baseDelayMs: 1 }),
      /bad request body/
    );
    assert.equal(calls, 1, 'a non-retryable error must not trigger any retry attempts');
  } finally {
    globalThis.fetch = original;
  }
});

test('fetchWithRetry honors Retry-After (seconds) instead of the default exponential backoff', async () => {
  let calls = 0;
  const timestamps = [];
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    timestamps.push(Date.now());
    calls++;
    if (calls === 1) {
      return new Response('rate limited', { status: 429, headers: { 'retry-after': '0.05' } });
    }
    return new Response('ok', { status: 200 });
  };
  try {
    const res = await fetchWithRetry('https://opencode.ai/zen/v1/models', {}, { retries: 2, baseDelayMs: 5000 });
    assert.equal(res.status, 200);
    assert.equal(calls, 2);
    const gap = timestamps[1] - timestamps[0];
    // Should honor the short Retry-After (~50ms), not the huge 5s baseDelayMs.
    assert.ok(gap < 2000, `expected Retry-After to short-circuit the backoff, gap was ${gap}ms`);
  } finally {
    globalThis.fetch = original;
  }
});

test('fetchWithRetry throws immediately without calling fetch if the signal is already aborted', async () => {
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    calls++;
    return new Response('ok', { status: 200 });
  };
  try {
    const controller = new AbortController();
    controller.abort(new Error('pre-aborted'));
    await assert.rejects(
      fetchWithRetry('https://opencode.ai/zen/v1/models', { signal: controller.signal }, { retries: 3 }),
      /pre-aborted/
    );
    assert.equal(calls, 0, 'fetch must not be called at all once the signal is already aborted');
  } finally {
    globalThis.fetch = original;
  }
});

test('fetchWithRetry aborts quickly during the backoff wait instead of waiting out the full delay', async () => {
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    calls++;
    return new Response('unavailable', { status: 503 });
  };
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('canceled mid-backoff')), 20);
    const start = Date.now();
    await assert.rejects(
      fetchWithRetry(
        'https://opencode.ai/zen/v1/models',
        { signal: controller.signal },
        { retries: 3, baseDelayMs: 60_000, maxDelayMs: 60_000 }
      ),
      /canceled mid-backoff/
    );
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 2000, `expected cancellation to short-circuit the long backoff, took ${elapsed}ms`);
    assert.equal(calls, 1, 'only the first attempt should have run before cancellation aborted the wait');
  } finally {
    globalThis.fetch = original;
  }
});

// ============================================================================
// fetchWithRetry — patient 429 schedule (independent rate-limit budget)
// ============================================================================

test('fetchWithRetry gives 429 its own immediate-then-spaced schedule, independent of the 5xx budget', async () => {
  let calls = 0;
  const timestamps = [];
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    timestamps.push(Date.now());
    calls++;
    // Fail with 429 for the first 4 attempts, then recover.
    if (calls <= 4) return new Response('rate limited', { status: 429 });
    return new Response('ok', { status: 200 });
  };
  try {
    const res = await fetchWithRetry(
      'https://opencode.ai/zen/v1/models',
      {},
      {
        retries: 0, // the 5xx/network-error budget is irrelevant to this test
        rateLimitRetries: 4,
        rateLimitImmediateAttempts: 2,
        rateLimitDelayMs: 500,
      }
    );
    assert.equal(res.status, 200);
    assert.equal(calls, 5, 'expected 1 initial attempt + 4 rate-limit retries');

    const gaps = [];
    for (let i = 1; i < timestamps.length; i++) gaps.push(timestamps[i] - timestamps[i - 1]);

    // The first 2 retries (rateLimitImmediateAttempts) should be near-instant.
    assert.ok(gaps[0] < 300, `expected immediate retry #1 to be fast, was ${gaps[0]}ms`);
    assert.ok(gaps[1] < 300, `expected immediate retry #2 to be fast, was ${gaps[1]}ms`);
    // The remaining retries should honor the full spaced-out delay.
    assert.ok(gaps[2] >= 450, `expected spaced retry #1 to wait ~500ms, was ${gaps[2]}ms`);
    assert.ok(gaps[3] >= 450, `expected spaced retry #2 to wait ~500ms, was ${gaps[3]}ms`);
  } finally {
    globalThis.fetch = original;
  }
});

test('fetchWithRetry returns the last 429 response once the rate-limit budget is exhausted, without throwing', async () => {
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    calls++;
    return new Response('still rate limited', { status: 429 });
  };
  try {
    const res = await fetchWithRetry(
      'https://opencode.ai/zen/v1/models',
      {},
      { retries: 0, rateLimitRetries: 3, rateLimitImmediateAttempts: 3, rateLimitDelayMs: 10 }
    );
    assert.equal(res.status, 429);
    assert.equal(calls, 4, 'expected 1 initial attempt + 3 rate-limit retries, then give up');
  } finally {
    globalThis.fetch = original;
  }
});

test('fetchWithRetry caps a large Retry-After value at rateLimitMaxWaitMs', async () => {
  let calls = 0;
  const timestamps = [];
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    timestamps.push(Date.now());
    calls++;
    if (calls === 1) {
      return new Response('rate limited', { status: 429, headers: { 'retry-after': '5' } }); // 5s
    }
    return new Response('ok', { status: 200 });
  };
  try {
    const res = await fetchWithRetry(
      'https://opencode.ai/zen/v1/models',
      {},
      { retries: 0, rateLimitRetries: 1, rateLimitMaxWaitMs: 50 }
    );
    assert.equal(res.status, 200);
    assert.equal(calls, 2);
    const gap = timestamps[1] - timestamps[0];
    assert.ok(gap < 1000, `expected the 5s Retry-After to be capped to ~50ms, gap was ${gap}ms`);
  } finally {
    globalThis.fetch = original;
  }
});

test('fetchWithRetry tracks 429 and 5xx retries with independent budgets in a mixed sequence', async () => {
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    calls++;
    // Two 429s (consumes the rate-limit budget), then one 502 (consumes the
    // separate 5xx budget), then success. This only succeeds if the two
    // classes are tracked independently rather than sharing one counter.
    if (calls <= 2) return new Response('rate limited', { status: 429 });
    if (calls === 3) return new Response('bad gateway', { status: 502 });
    return new Response('ok', { status: 200 });
  };
  try {
    const res = await fetchWithRetry(
      'https://opencode.ai/zen/v1/models',
      {},
      {
        retries: 1,
        baseDelayMs: 1,
        maxDelayMs: 5,
        rateLimitRetries: 2,
        rateLimitImmediateAttempts: 2,
        rateLimitDelayMs: 1,
      }
    );
    assert.equal(res.status, 200);
    assert.equal(calls, 4, 'expected 2 rate-limit retries + 1 server-error retry + the final success');
  } finally {
    globalThis.fetch = original;
  }
});
