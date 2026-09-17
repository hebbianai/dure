import { describe, expect, it } from "vitest";
import {
  consumeDesktopTransitionIntent,
  markDesktopTransitionIntent,
} from "@/lib/workspace/desktop/desktopTransitionIntent";

describe("desktopTransitionIntent", () => {
  it("hands the pre-store timestamp to the matching transition exactly once", () => {
    markDesktopTransitionIntent("gesto", 100);
    expect(consumeDesktopTransitionIntent("gesto", 140)).toBe(100);
    expect(consumeDesktopTransitionIntent("gesto", 150)).toBeUndefined();
  });

  it("drops mismatched and stale intents", () => {
    markDesktopTransitionIntent("main", 100);
    expect(consumeDesktopTransitionIntent("gesto", 110)).toBeUndefined();

    markDesktopTransitionIntent("gesto", 100);
    expect(consumeDesktopTransitionIntent("gesto", 10_101)).toBeUndefined();
  });
});
