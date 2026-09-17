import { describe, expect, it } from "vitest";
import { visibleActiveDesktopId } from "@/lib/workspace/desktop/activeDesktop";

describe("visibleActiveDesktopId", () => {
  const spaces = [{ id: "a" }, { id: "b" }];

  it("returns the stored active desktop when it exists", () => {
    expect(visibleActiveDesktopId(spaces, "b")).toBe("b");
  });

  it("falls back to the first desktop when the stored id is stale", () => {
    expect(visibleActiveDesktopId(spaces, "removed")).toBe("a");
    expect(visibleActiveDesktopId(spaces, undefined)).toBe("a");
  });

  it("returns undefined with no spaces", () => {
    expect(visibleActiveDesktopId([], "a")).toBeUndefined();
  });
});
