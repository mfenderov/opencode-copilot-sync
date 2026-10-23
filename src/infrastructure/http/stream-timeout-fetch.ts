export const OPEN_CODE_HEADER_TIMEOUT_MS = 300_000;
export const OPEN_CODE_CHUNK_TIMEOUT_MS = 900_000;

export interface StreamTimeoutOptions {
  headerTimeoutMs: number;
  chunkTimeoutMs: number;
}

export class StreamTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StreamTimeoutError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function createStreamTimeoutFetch(
  baseFetch: typeof fetch,
  options: StreamTimeoutOptions
): typeof fetch {
  const fetchWithTimeout = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    const callerSignal: AbortSignal | undefined = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const controller = new AbortController();
    let headerTimer: ReturnType<typeof setTimeout> | undefined;
    let chunkTimer: ReturnType<typeof setTimeout> | undefined;
    let rejectAbort!: (reason: unknown) => void;
    const abortPromise = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });

    const cleanup = () => {
      clearTimeout(headerTimer);
      clearTimeout(chunkTimer);
      callerSignal?.removeEventListener('abort', onCallerAbort);
    };
    const onCallerAbort = () => {
      const reason: unknown = (callerSignal?.reason as unknown) ?? new DOMException('The operation was aborted.', 'AbortError');
      cleanup();
      controller.abort(reason);
      rejectAbort(reason);
    };

    const headerTimeout = new Promise<never>((_resolve, reject) => {
      headerTimer = setTimeout(() => {
        const error = new StreamTimeoutError(`Timed out waiting for response headers after ${options.headerTimeoutMs} ms`);
        controller.abort(error);
        reject(error);
      }, options.headerTimeoutMs);
    });

    if (callerSignal?.aborted) onCallerAbort();
    else callerSignal?.addEventListener('abort', onCallerAbort, { once: true });

    let response: Response;
    try {
      response = await Promise.race([
        Promise.resolve().then(() => baseFetch(input, { ...init, signal: controller.signal })),
        headerTimeout,
        abortPromise,
      ]);
    } catch (error) {
      cleanup();
      throw error;
    }
    clearTimeout(headerTimer);

    if (!response.body) {
      cleanup();
      return response;
    }

    const reader = (response.body as unknown as ReadableStream<Uint8Array>).getReader();
    const body = new ReadableStream<Uint8Array>({
        async pull(streamController) {
        const idleTimeout = new Promise<never>((_resolve, reject) => {
          chunkTimer = setTimeout(() => {
            const error = new StreamTimeoutError(`Timed out waiting for a response body chunk after ${options.chunkTimeoutMs} ms`);
            controller.abort(error);
            reject(error);
          }, options.chunkTimeoutMs);
        });

        try {
          const result = await Promise.race([reader.read(), idleTimeout, abortPromise]);
          clearTimeout(chunkTimer);
          chunkTimer = undefined;
          if (result.done) {
            cleanup();
            reader.releaseLock();
            streamController.close();
          } else {
            streamController.enqueue(result.value);
          }
        } catch (error) {
          cleanup();
          void reader.cancel(error).catch(() => undefined);
          streamController.error(error);
        }
      },
      async cancel(reason) {
        cleanup();
        controller.abort(reason);
        await reader.cancel(reason).catch(() => undefined);
      },
    });

    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };

  return fetchWithTimeout;
}
