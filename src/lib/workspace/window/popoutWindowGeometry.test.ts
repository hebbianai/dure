import { describe, expect, it } from "vitest";
import {
  POPOUT_RESIZE_HANDLES,
  POPOUT_WINDOW_GEOMETRY,
} from "@/lib/workspace/window/popoutWindowGeometry";

describe("popout window geometry", () => {
  it("opens a detached pane at a comfortably large default size", () => {
    expect(POPOUT_WINDOW_GEOMETRY).toMatchObject({ width: 1200, height: 820 });
  });

  it("provides wide resize targets for every edge and corner", () => {
    expect(POPOUT_RESIZE_HANDLES.map((handle) => handle.direction)).toEqual([
      "North",
      "NorthEast",
      "East",
      "SouthEast",
      "South",
      "SouthWest",
      "West",
      "NorthWest",
    ]);
    expect(POPOUT_RESIZE_HANDLES.find((handle) => handle.direction === "East")?.className)
      .toContain("w-2");
    expect(
      POPOUT_RESIZE_HANDLES.find((handle) => handle.direction === "SouthEast")?.className,
    ).toContain("size-4");
  });
});
