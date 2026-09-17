/**
 * The gesture that replaced the home screen's refresh button.
 *
 * These pin the arithmetic; `app.test.ts` drives real touch events through the
 * binder and checks that an armed release actually re-asks every computer.
 */

import { describe, expect, it } from "vitest";
import { PULL_ARM_PX, PULL_MAX_PX, pullReading } from "./pullToRefresh";

describe("pullReading", () => {
  /**
   * A list scrolled down is a list being read. Claiming that drag as a refresh
   * would take the reader's own scroll away from them.
   */
  it("refuses to start unless the list is already at its top", () => {
    expect(pullReading({ startY: 0, currentY: 400, scrollTop: 1 })).toEqual({
      distance: 0,
      armed: false,
    });
  });

  it("resists a short pull and becomes heavier as the finger travels", () => {
    const read = (currentY: number) => pullReading({ startY: 0, currentY, scrollTop: 0 });
    const short = read(60).distance;
    const medium = read(120).distance;
    const long = read(180).distance;
    expect(short).toBeGreaterThan(0);
    expect(medium).toBeLessThanOrEqual(40);
    expect(long - medium).toBeLessThan(medium - short);
    expect(medium - short).toBeLessThan(short);
  });

  it("arms at the threshold and not before", () => {
    const at = pullReading({ startY: 0, currentY: 160, scrollTop: 0 });
    const under = pullReading({ startY: 0, currentY: 120, scrollTop: 0 });

    expect(at.armed).toBe(true);
    expect(at.distance).toBeGreaterThanOrEqual(PULL_ARM_PX);
    expect(under.armed).toBe(false);
  });

  it("stops following past the end of the band", () => {
    expect(pullReading({ startY: 0, currentY: 10_000, scrollTop: 0 }).distance).toBe(PULL_MAX_PX);
  });

  /** The strip does not close past shut, so an upward drag reads as nothing. */
  it("reads an upward drag as no pull at all", () => {
    expect(pullReading({ startY: 300, currentY: 0, scrollTop: 0 })).toEqual({
      distance: 0,
      armed: false,
    });
  });
});
