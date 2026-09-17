import { describe, expect, it } from "vitest";
import {
  resolveDesktopActivationTarget,
  resolveSpaceActivationTarget,
} from "@/lib/workspace/desktop/desktopActivation";

describe("desktop activation target", () => {
  const spaces = [
    { id: "desk-a", name: "A" },
    { id: "desk-b", name: "B" },
  ];

  it("resolves one exact existing Space", () => {
    expect(resolveSpaceActivationTarget(spaces, " desk-b ")).toEqual(
      spaces[1],
    );
  });

  it("rejects missing, blank, and unknown identities", () => {
    expect(() => resolveSpaceActivationTarget(spaces, undefined)).toThrow(
      "spaceId is required",
    );
    expect(() => resolveSpaceActivationTarget(spaces, " ")).toThrow(
      "spaceId is required",
    );
    expect(() => resolveSpaceActivationTarget(spaces, "desk-c")).toThrow(
      "Space desk-c was not found",
    );
  });

  it("keeps the deprecated Desktop resolver as an equal compatibility alias", () => {
    expect(resolveDesktopActivationTarget(spaces, "desk-a")).toBe(spaces[0]);
  });
});
