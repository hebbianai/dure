import { describe, expect, it } from "vitest";
import { DRAG_THRESHOLD, dropIndex } from "./keyStripDrag";

/** Four chips, 40px wide, 4px apart, starting at x=0. */
const CENTERS = [20, 64, 108, 152];

describe("key strip drag", () => {
  it("stays put until the pointer passes a neighbour's centre", () => {
    expect(dropIndex(CENTERS, 1, 64)).toBe(1);
    // Just short of the left neighbour's centre, and just past it.
    expect(dropIndex(CENTERS, 1, 21)).toBe(1);
    expect(dropIndex(CENTERS, 1, 19)).toBe(0);
  });

  it("moves right one place per centre crossed", () => {
    expect(dropIndex(CENTERS, 0, 65)).toBe(1);
    expect(dropIndex(CENTERS, 0, 109)).toBe(2);
    expect(dropIndex(CENTERS, 0, 999)).toBe(3);
  });

  it("cannot be dragged off either end", () => {
    expect(dropIndex(CENTERS, 0, -400)).toBe(0);
    expect(dropIndex(CENTERS, 3, 999)).toBe(3);
  });

  it("answers with the index it was given when that index is not in the row", () => {
    expect(dropIndex(CENTERS, 9, 50)).toBe(9);
    expect(dropIndex([], 0, 50)).toBe(0);
  });

  /** A tap removes a chip, so the threshold is what stops a nudge deleting a key. */
  it("keeps the tap/drag split at the spec's 6px", () => {
    expect(DRAG_THRESHOLD).toBe(6);
  });
});
