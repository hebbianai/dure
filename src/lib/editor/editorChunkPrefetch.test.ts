import { describe, expect, it, vi } from "vitest";
import {
  createPreloadableModule,
  scheduleIdlePrefetch,
} from "@/lib/editor/editorChunkPrefetch";

function createHost() {
  let idleCallback: (() => void) | undefined;
  let timeoutCallback: (() => void) | undefined;
  const host = {
    requestIdleCallback: vi.fn((callback: () => void) => {
      idleCallback = callback;
      return 17;
    }),
    cancelIdleCallback: vi.fn(),
    setTimeout: vi.fn((callback: () => void) => {
      timeoutCallback = callback;
      return 23;
    }),
    clearTimeout: vi.fn(),
  };
  return {
    host,
    runIdle: () => idleCallback?.(),
    runTimeout: () => timeoutCallback?.(),
  };
}

describe("scheduleIdlePrefetch", () => {
  it("loads once through requestIdleCallback with a bounded timeout", () => {
    const { host, runIdle } = createHost();
    const prefetch = vi.fn(() => Promise.resolve());

    scheduleIdlePrefetch(prefetch, host, { idleTimeoutMs: 1_500 });
    expect(host.requestIdleCallback).toHaveBeenCalledWith(
      expect.any(Function),
      { timeout: 1_500 },
    );
    expect(host.setTimeout).not.toHaveBeenCalled();

    runIdle();
    runIdle();
    expect(prefetch).toHaveBeenCalledTimes(1);
  });

  it("cancels an idle callback and fences an already queued callback", () => {
    const { host, runIdle } = createHost();
    const prefetch = vi.fn(() => Promise.resolve());

    const cancel = scheduleIdlePrefetch(prefetch, host);
    cancel();
    runIdle();

    expect(host.cancelIdleCallback).toHaveBeenCalledWith(17);
    expect(prefetch).not.toHaveBeenCalled();
  });

  it("falls back to a cancellable timeout when the idle API is unavailable", () => {
    const { host, runTimeout } = createHost();
    const prefetch = vi.fn(() => Promise.resolve());
    const fallbackHost = {
      setTimeout: host.setTimeout,
      clearTimeout: host.clearTimeout,
    };

    const cancel = scheduleIdlePrefetch(prefetch, fallbackHost, {
      fallbackDelayMs: 400,
    });
    expect(host.setTimeout).toHaveBeenCalledWith(expect.any(Function), 400);

    cancel();
    runTimeout();
    expect(host.clearTimeout).toHaveBeenCalledWith(23);
    expect(prefetch).not.toHaveBeenCalled();
  });

  it("contains a rejected best-effort preload", async () => {
    const { host, runIdle } = createHost();
    const prefetch = vi.fn(() => Promise.reject(new Error("offline")));

    scheduleIdlePrefetch(prefetch, host);
    runIdle();
    await Promise.resolve();

    expect(prefetch).toHaveBeenCalledTimes(1);
  });
});

describe("createPreloadableModule", () => {
  it("shares an in-flight import and becomes synchronously readable", async () => {
    let resolveModule: ((value: { name: string }) => void) | undefined;
    const importer = vi.fn(
      () =>
        new Promise<{ name: string }>((resolve) => {
          resolveModule = resolve;
        }),
    );
    const module = createPreloadableModule(importer);

    const first = module.preload();
    const second = module.preload();
    expect(second).toBe(first);
    expect(() => module.read()).toThrow(first);

    resolveModule?.({ name: "editor" });
    await first;
    expect(module.read()).toEqual({ name: "editor" });
    expect(importer).toHaveBeenCalledTimes(1);
  });

  it("allows a later user-driven retry after preload failure", async () => {
    const importer = vi
      .fn<() => Promise<{ name: string }>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ name: "editor" });
    const module = createPreloadableModule(importer);

    await expect(module.preload()).rejects.toThrow("offline");
    await expect(module.preload()).resolves.toEqual({ name: "editor" });
    expect(module.read()).toEqual({ name: "editor" });
    expect(importer).toHaveBeenCalledTimes(2);
  });
});
