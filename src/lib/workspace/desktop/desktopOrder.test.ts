import { describe, expect, it } from "vitest";
import { reorderDesktopItems } from "@/lib/workspace/desktop/desktopOrder";

const spaces = ["a", "b", "c", "d"].map((id) => ({ id }));

describe("reorderDesktopItems", () => {
  it("moves a desktop after a later target", () => {
    expect(reorderDesktopItems(spaces, "a", "c", "after")?.map(({ id }) => id)).toEqual([
      "b",
      "c",
      "a",
      "d",
    ]);
  });

  it("moves a desktop before an earlier target", () => {
    expect(reorderDesktopItems(spaces, "d", "b", "before")?.map(({ id }) => id)).toEqual([
      "a",
      "d",
      "b",
      "c",
    ]);
  });

  it("returns null for invalid or unchanged moves", () => {
    expect(reorderDesktopItems(spaces, "a", "a", "before")).toBeNull();
    expect(reorderDesktopItems(spaces, "missing", "b", "before")).toBeNull();
    expect(reorderDesktopItems(spaces, "a", "b", "before")).toBeNull();
  });
});
