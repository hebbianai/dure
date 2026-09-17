import { describe, expect, it } from "vitest";
import {
  shouldRestoreTerminalRecoveryFocus,
  TerminalRecoveryFocusTracker,
} from "@/lib/terminal/terminalRecoveryFocus";

const focusedContext = {
  requested: true,
  documentFocused: true,
  workspaceActive: true,
  paneVisible: true,
  paneActive: true,
  geometryVisible: true,
  focusTargetAvailable: true,
  focusOwnershipUnchanged: true,
};

describe("shouldRestoreTerminalRecoveryFocus", () => {
  it("restores the same active pane after its renderer remounts", () => {
    expect(shouldRestoreTerminalRecoveryFocus(focusedContext)).toBe(true);
  });

  it.each([
    "documentFocused",
    "workspaceActive",
    "paneVisible",
    "paneActive",
    "geometryVisible",
    "focusTargetAvailable",
    "focusOwnershipUnchanged",
  ] as const)("does not steal focus when %s changed", (key) => {
    expect(
      shouldRestoreTerminalRecoveryFocus({
        ...focusedContext,
        [key]: false,
      }),
    ).toBe(false);
  });

  it("invalidates a pending restore when another split receives focus intent", () => {
    const tracker = new TerminalRecoveryFocusTracker();
    const snapshot = tracker.snapshot();

    tracker.markFocusIntent();

    expect(tracker.unchanged(snapshot)).toBe(false);
  });
});
