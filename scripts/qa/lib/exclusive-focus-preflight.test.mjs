import { describe, expect, test } from "vitest";
import {
  evaluateExclusiveFocus,
  parseHidIdleNanoseconds,
} from "./exclusive-focus-preflight.mjs";

describe("exclusive OS-focus QA preflight", () => {
  test("requires an explicit opt-in even on an idle desktop", () => {
    expect(
      evaluateExclusiveFocus({
        explicitOptIn: undefined,
        idleNanoseconds: 60_000_000_000n,
        requiredIdleMs: 15_000,
      }),
    ).toEqual({
      action: "skip",
      reason: "explicit_opt_in_required",
    });
  });

  test("skips while recent HID activity indicates an active user", () => {
    expect(
      evaluateExclusiveFocus({
        explicitOptIn: "1",
        idleNanoseconds: 2_000_000_000n,
        requiredIdleMs: 15_000,
      }),
    ).toEqual({
      action: "skip",
      reason: "interactive_desktop_active",
      idleMs: 2_000,
      requiredIdleMs: 15_000,
    });
  });

  test("runs only after the requested idle interval", () => {
    expect(
      evaluateExclusiveFocus({
        explicitOptIn: "1",
        idleNanoseconds: 15_000_000_000n,
        requiredIdleMs: 15_000,
      }),
    ).toEqual({
      action: "run",
      idleMs: 15_000,
      requiredIdleMs: 15_000,
    });
  });

  test("parses the bounded IOHIDSystem idle counter", () => {
    expect(
      parseHidIdleNanoseconds('    | | |   "HIDIdleTime" = 457756208\n'),
    ).toBe(457756208n);
    expect(parseHidIdleNanoseconds("unrelated output")).toBeUndefined();
  });
});
