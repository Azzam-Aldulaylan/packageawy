import { FetchError } from './http.js';
import type { HttpClient } from './http.js';
import { DEFAULT_CONCURRENCY } from './pool.js';

/** One scan's metadata GET budget. Slots cover transport only, never callers. */
export function limitMetadataRequests(client: HttpClient, limit = DEFAULT_CONCURRENCY): HttpClient {
  const capacity = Math.max(1, limit);
  const queue = new Set<() => void>();
  const cancellations = new Map<AbortSignal, { callbacks: Set<() => void>; abort: () => void }>();
  let active = 0;

  // Share a listener when many queued requests use the same scan signal.
  const onAbort = (signal: AbortSignal | undefined, callback: () => void): (() => void) => {
    if (signal === undefined) return () => {};
    let group = cancellations.get(signal);
    if (group === undefined) {
      const callbacks = new Set<() => void>();
      group = { callbacks, abort: () => { for (const cancel of [...callbacks]) cancel(); } };
      cancellations.set(signal, group);
      signal.addEventListener('abort', group.abort, { once: true });
    }
    group.callbacks.add(callback);
    return () => {
      group.callbacks.delete(callback);
      if (group.callbacks.size === 0) {
        signal.removeEventListener('abort', group.abort);
        cancellations.delete(signal);
      }
    };
  };

  return {
    get(url, options) {
      return new Promise((resolve, reject) => {
        const signal = options?.signal;
        const cancelled = (): void => {
          queue.delete(start);
          unsubscribe();
          reject(new FetchError('CANCELLED', 'aborted before metadata request started'));
        };
        let unsubscribe = (): void => {};
        const start = (): void => {
          queue.delete(start);
          unsubscribe();
          if (signal?.aborted === true) {
            cancelled();
            return;
          }
          active += 1;
          void (async () => {
            try {
              resolve(await client.get(url, options));
            } catch (cause) {
              reject(cause);
            } finally {
              active -= 1;
              const next = queue.values().next().value;
              next?.();
            }
          })();
        };
        if (signal?.aborted === true) {
          cancelled();
        } else if (active < capacity) {
          start();
        } else {
          queue.add(start);
          unsubscribe = onAbort(signal, cancelled);
        }
      });
    },
    post: (url, body, options) => client.post(url, body, options),
  };
}
