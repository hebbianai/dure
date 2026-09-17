import { describe, expect, it, vi } from "vitest";
import { type Impact, keyTapFeedback } from "./haptics";

describe("keyTapFeedback", () => {
  it("ticks once, lightly, when haptics are on", () => {
    const impact = vi.fn<Impact>(() => Promise.resolve(null));
    keyTapFeedback(true, impact);
    expect(impact).toHaveBeenCalledTimes(1);
    expect(impact).toHaveBeenCalledWith("light");
  });

  it("stays silent when haptics are off", () => {
    const impact = vi.fn<Impact>(() => Promise.resolve(null));
    keyTapFeedback(false, impact);
    expect(impact).not.toHaveBeenCalled();
  });

  /**
   * A missing permission or a desktop no-op must never break a key press: the
   * plugin can reject (no plugin at all) or resolve `{ status: "error" }` (the
   * tauri-specta binding's way of refusing) — both are ignored.
   */
  it("swallows a rejecting impact without an unhandled rejection", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      keyTapFeedback(true, () => Promise.reject(new Error("plugin not found")));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("ignores an impact that resolves with a refusal", async () => {
    const impact = vi.fn<Impact>(() => Promise.resolve({ status: "error", error: "denied" }));
    expect(() => keyTapFeedback(true, impact)).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(impact).toHaveBeenCalledTimes(1);
  });
});
