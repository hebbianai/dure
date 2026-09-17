import { AsyncLocalStorage } from "node:async_hooks";

export function createBoundedConcurrentTests(testApi, limit) {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new TypeError("concurrent test limit must be a positive integer");
  }

  const waiters = [];
  const cleanupScope = new AsyncLocalStorage();
  let active = 0;
  let exclusiveActive = false;

  async function withOwnedCleanup(callback) {
    const cleanups = [];
    let failure;
    let result;
    try {
      result = await cleanupScope.run(cleanups, callback);
    } catch (error) {
      failure = error;
    }

    const cleanupFailures = [];
    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup();
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    if (failure && cleanupFailures.length > 0) {
      throw new AggregateError(
        [failure, ...cleanupFailures],
        "bounded test failed and cleanup was incomplete",
      );
    }
    if (failure) throw failure;
    if (cleanupFailures.length > 0) {
      throw new AggregateError(cleanupFailures, "bounded test cleanup failed");
    }
    return result;
  }

  function drainQueue() {
    if (exclusiveActive) return;
    while (waiters.length > 0) {
      const next = waiters[0];
      if (next.exclusive) {
        if (active !== 0) return;
        waiters.shift();
        exclusiveActive = true;
        next.resolve();
        return;
      }
      if (active >= limit) return;
      waiters.shift();
      active += 1;
      next.resolve();
    }
  }

  function acquireSlot(exclusive) {
    return new Promise((resolve) => {
      waiters.push({ exclusive, resolve });
      drainQueue();
    });
  }

  async function withSlot(callback, exclusive = false) {
    await acquireSlot(exclusive);
    try {
      return await callback();
    } finally {
      if (exclusive) {
        exclusiveActive = false;
      } else {
        active -= 1;
      }
      drainQueue();
    }
  }

  return Object.freeze({
    assertIdle() {
      if (active !== 0 || exclusiveActive || waiters.length !== 0) {
        throw new Error("bounded concurrent tests did not release every slot");
      }
    },
    deferCleanup(callback) {
      if (typeof callback !== "function") {
        throw new TypeError("bounded test cleanup must be a function");
      }
      const cleanups = cleanupScope.getStore();
      if (!cleanups) {
        throw new Error("bounded test cleanup must be registered inside its callback");
      }
      cleanups.push(callback);
    },
    each(cases, name, callback, timeout) {
      return testApi.concurrent.each(cases)(
        name,
        (...arguments_) =>
          withSlot(() =>
            withOwnedCleanup(() => callback(...arguments_)),
          ),
        timeout,
      );
    },
    exclusiveTest(name, callback, timeout) {
      return testApi.concurrent(
        name,
        () => withSlot(() => withOwnedCleanup(callback), true),
        timeout,
      );
    },
    sequentialTest(name, callback, timeout) {
      return testApi(name, () => withOwnedCleanup(callback), timeout);
    },
    test(name, callback, timeout) {
      return testApi.concurrent(
        name,
        () => withSlot(() => withOwnedCleanup(callback)),
        timeout,
      );
    },
  });
}
