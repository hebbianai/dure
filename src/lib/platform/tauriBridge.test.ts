import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({
  emit: vi.fn(),
  listen: vi.fn(),
}));

const REALM_EVENT_AUTHORITY_KEY = "__dureTauriWebviewEventAuthorityV1";

vi.mock("@tauri-apps/api/event", () => ({
  emit: tauri.emit,
  listen: tauri.listen,
}));

import {
  emitWhenReady,
  listenWhenReady,
  whenTauriBridgeReady,
} from "@/lib/platform/tauriBridge";

function injectBridge() {
  (globalThis as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    transformCallback: () => 0,
  };
}

function removeBridge() {
  delete (globalThis as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
}

describe("tauri bridge readiness", () => {
  beforeEach(() => {
    delete (globalThis as unknown as Record<string, unknown>)[
      REALM_EVENT_AUTHORITY_KEY
    ];
    tauri.emit.mockReset();
    tauri.emit.mockResolvedValue(undefined);
    tauri.listen.mockReset();
    tauri.listen.mockResolvedValue(() => {});
    removeBridge();
    vi.resetModules();
  });

  afterEach(() => {
    removeBridge();
  });

  it("resolves immediately when the bridge is already injected", async () => {
    injectBridge();
    await expect(whenTauriBridgeReady()).resolves.toBeUndefined();
  });

  /** The reload race this module exists for: the page runs before injection. */
  it("waits for a bridge that arrives after the caller does", async () => {
    const waiting = whenTauriBridgeReady(2_000);
    setTimeout(injectBridge, 60);
    await expect(waiting).resolves.toBeUndefined();
  });

  /** Failing loudly beats waiting forever — a silent wait looks identical to
   *  the blank window this is meant to prevent. */
  it("rejects instead of hanging when the bridge never arrives", async () => {
    await expect(whenTauriBridgeReady(80)).rejects.toThrow(/not injected/);
  });

  /**
   * The regression itself. `listen` reaches into
   * `__TAURI_INTERNALS__.transformCallback`, so before injection it throws and
   * the subscription is simply lost — which is how every startup listener died
   * silently and left the window blank. It must retry once the bridge lands.
   */
  it("retries the subscription after a bridge that was missing arrives", async () => {
    tauri.listen.mockImplementationOnce(() => {
      throw new TypeError("Cannot read properties of undefined (reading 'transformCallback')");
    });
    const unlisten = vi.fn();
    tauri.listen.mockResolvedValueOnce(unlisten);

    const subscribing = listenWhenReady("pane-request", () => {});
    setTimeout(injectBridge, 40);

    await expect(subscribing).resolves.toEqual(expect.any(Function));
    expect(tauri.listen).toHaveBeenCalledTimes(2);
    expect(unlisten).not.toHaveBeenCalled();
  });

  it("retries an emit after a bridge that was missing arrives", async () => {
    tauri.emit.mockImplementationOnce(() => {
      throw new TypeError("Cannot read properties of undefined (reading 'invoke')");
    });
    tauri.emit.mockResolvedValueOnce(undefined);

    const emitting = emitWhenReady("durable-store-changed", { generation: 1 });
    setTimeout(injectBridge, 40);

    await expect(emitting).resolves.toBeUndefined();
    expect(tauri.emit).toHaveBeenCalledTimes(2);
  });

  /** A failure with the bridge already up is not the race, and hiding it
   *  behind a retry would turn a real error into a ten-second stall. */
  it("rethrows a failure that is not the bridge race", async () => {
    injectBridge();
    tauri.listen.mockRejectedValueOnce(new Error("event name refused"));

    await expect(listenWhenReady("pane-request", () => {})).rejects.toThrow("event name refused");
    expect(tauri.listen).toHaveBeenCalledTimes(1);
  });

  it("rolls back a failed setup so a later local client can install it", async () => {
    injectBridge();
    let nativeHandler: ((event: {
      event: string;
      id: number;
      payload: string;
    }) => void) | undefined;
    tauri.listen
      .mockRejectedValueOnce(new Error("native listener refused"))
      .mockImplementationOnce((_event, handler) => {
        nativeHandler = handler;
        return Promise.resolve(vi.fn());
      });

    await expect(
      listenWhenReady("session:exit", vi.fn()),
    ).rejects.toThrow("native listener refused");
    const current = vi.fn();
    await listenWhenReady("session:exit", current);
    nativeHandler?.({ event: "session:exit", id: 42, payload: "live" });

    expect(tauri.listen).toHaveBeenCalledTimes(2);
    expect(current).toHaveBeenCalledWith({
      event: "session:exit",
      id: 42,
      payload: "live",
    });
  });

  it("keys retained subscriptions by both event and native target", async () => {
    injectBridge();
    const main = { kind: "Window" as const, label: "main" };
    await listenWhenReady("tauri://resize", vi.fn(), { target: main });
    await listenWhenReady("tauri://resize", vi.fn(), {
      target: { ...main },
    });
    await listenWhenReady("tauri://resize", vi.fn(), {
      target: { kind: "Window", label: "secondary" },
    });

    expect(tauri.listen).toHaveBeenCalledTimes(2);
    expect(tauri.listen.mock.calls.map(([, , options]) => options)).toEqual([
      { target: main },
      { target: { kind: "Window", label: "secondary" } },
    ]);
  });

  it("keeps one realm callback live when StrictMode retires an earlier local client", async () => {
    injectBridge();
    const nativeHandlers: Array<(event: {
      event: string;
      id: number;
      payload: string;
    }) => void> = [];
    const nativeStop = vi.fn(() => {
      throw new TypeError(
        "Cannot read properties of undefined (reading 'handlerId')",
      );
    });
    tauri.listen.mockImplementation(
      (_event: string, handler: (typeof nativeHandlers)[number]) => {
        nativeHandlers.push(handler);
        return Promise.resolve(nativeStop);
      },
    );

    const beforeReload = await import("@/lib/platform/tauriBridge");
    const oldHandler = vi.fn();
    const stopOld = await beforeReload.listenWhenReady<string>(
      "session:exit",
      oldHandler,
    );

    vi.resetModules();
    const afterReload = await import("@/lib/platform/tauriBridge");
    const replacementHandler = vi.fn();
    await afterReload.listenWhenReady<string>(
      "session:exit",
      replacementHandler,
    );

    let stopError: unknown;
    try {
      stopOld();
    } catch (error) {
      stopError = error;
    }
    nativeHandlers[0]?.({
      event: "session:exit",
      id: 41,
      payload: "current",
    });

    expect.soft(stopError).toBeUndefined();
    expect.soft(tauri.listen).toHaveBeenCalledTimes(1);
    expect.soft(nativeStop).not.toHaveBeenCalled();
    expect.soft(oldHandler).not.toHaveBeenCalled();
    expect(replacementHandler).toHaveBeenCalledOnce();
  });
});
