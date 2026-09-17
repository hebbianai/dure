import { describe, expect, it, vi } from "vitest";
import { createPushSync } from "./pushNotifications";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("push registration lifetime", () => {
  it("registers without any mounted terminal attachment", async () => {
    const changed = vi.fn();
    const synchronize = vi.fn(async () => ({ supported: true, outcomes: [{ id: "computer", error: null }] }));
    const sync = createPushSync({ permission: async () => "granted", synchronize, changed });
    sync.request({ preference: "all", language: "ko" });
    await tick();
    expect(synchronize).toHaveBeenCalledWith("all", "ko");
    expect(changed).toHaveBeenLastCalledWith({ kind: "registered" });
    sync.dispose();
  });

  it("does not report an old registration as ready after choosing Off", async () => {
    let complete: ((result: { supported: boolean; outcomes: { id: string; error: null }[] }) => void) | undefined;
    const changed = vi.fn();
    const synchronize = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }))
      .mockResolvedValue({ supported: true, outcomes: [{ id: "computer", error: null }] });
    const sync = createPushSync({ permission: async () => "granted", synchronize, changed });
    sync.request({ preference: "all", language: "en" });
    await tick();
    sync.request({ preference: "off", language: "ko" });
    complete?.({ supported: true, outcomes: [{ id: "computer", error: null }] });
    await tick();
    expect(synchronize).toHaveBeenLastCalledWith(null, "ko");
    expect(changed).not.toHaveBeenCalledWith({ kind: "registered" });
    expect(changed).toHaveBeenLastCalledWith({ kind: "off" });
  });

  it("shows failed Off synchronization instead of claiming delivery stopped", async () => {
    const changed = vi.fn();
    const sync = createPushSync({ permission: async () => "granted", changed,
      synchronize: async () => ({ supported: true, outcomes: [{ id: "computer", error: "Computer offline" }] }),
    });
    sync.request({ preference: "off", language: "en" });
    await tick();
    expect(changed).toHaveBeenLastCalledWith({ kind: "error", detail: "Computer offline" });
  });

  it("clears stale remote consent when OS permission is denied", async () => {
    const synchronize = vi.fn(async () => ({ supported: true, outcomes: [{ id: "computer", error: null }] }));
    const sync = createPushSync({ permission: async () => "denied", synchronize, changed: vi.fn() });
    sync.request({ preference: "approvals", language: "en" });
    await tick();
    expect(synchronize).toHaveBeenCalledWith(null, "en");
  });

  it("does not publish a late result after the app is disposed", async () => {
    let complete: (() => void) | undefined;
    const changed = vi.fn();
    const sync = createPushSync({ permission: async () => "granted", changed,
      synchronize: () => new Promise((resolve) => { complete = () => resolve({ supported: true, outcomes: [] }); }),
    });
    sync.request({ preference: "all", language: "en" });
    await tick();
    sync.dispose();
    changed.mockClear();
    complete?.();
    await tick();
    expect(changed).not.toHaveBeenCalled();
  });
});
