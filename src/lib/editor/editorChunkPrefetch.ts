type IdlePrefetchHost = {
  requestIdleCallback?: (
    callback: () => void,
    options?: { timeout: number },
  ) => number;
  cancelIdleCallback?: (handle: number) => void;
  setTimeout: (callback: () => void, delay: number) => number;
  clearTimeout: (handle: number) => void;
};

type IdlePrefetchOptions = {
  idleTimeoutMs?: number;
  fallbackDelayMs?: number;
};

export function createPreloadableModule<T>(
  importer: () => Promise<T>,
): {
  preload: () => Promise<T>;
  read: () => T;
} {
  let loaded: { value: T } | undefined;
  let pending: Promise<T> | undefined;

  const preload = () => {
    if (loaded) return Promise.resolve(loaded.value);
    if (pending) return pending;
    pending = importer()
      .then((module) => {
        loaded = { value: module };
        return module;
      })
      .catch((error) => {
        pending = undefined;
        throw error;
      });
    return pending;
  };

  return {
    preload,
    read: () => {
      if (loaded) return loaded.value;
      throw preload();
    },
  };
}

/**
 * Schedule one best-effort module preload after startup work settles.
 * Cancellation fences callbacks that were already queued by the browser.
 */
export function scheduleIdlePrefetch(
  prefetch: () => Promise<unknown>,
  host: IdlePrefetchHost,
  {
    idleTimeoutMs = 2_000,
    fallbackDelayMs = 250,
  }: IdlePrefetchOptions = {},
): () => void {
  let cancelled = false;
  let started = false;
  const run = () => {
    if (cancelled || started) return;
    started = true;
    void prefetch().catch(() => {
      // A later user-driven dynamic import can surface or retry the failure.
    });
  };

  if (host.requestIdleCallback) {
    const handle = host.requestIdleCallback(run, { timeout: idleTimeoutMs });
    return () => {
      cancelled = true;
      host.cancelIdleCallback?.(handle);
    };
  }

  const handle = host.setTimeout(run, fallbackDelayMs);
  return () => {
    cancelled = true;
    host.clearTimeout(handle);
  };
}
