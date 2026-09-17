import { describe, expect, it } from "vitest";
import { frameTimeline } from "../tools/media-capture/runtime/lossless-screencast.mjs";

describe("lossless screencast timeline", () => {
  it("preserves real frame intervals and the final stationary hold", () => {
    expect(frameTimeline([100, 100.125, 102], 5)).toBe([
      "ffconcat version 1.0",
      "file '0.png'", "option framerate 60", "duration 0.125000",
      "file '1.png'", "option framerate 60", "duration 1.875000",
      "file '2.png'", "option framerate 60", "duration 3.000000",
      "file '2.png'", "option framerate 60", "",
    ].join("\n"));
  });
  it("holds a completely static clip for its full duration", () => {
    expect(frameTimeline([100], 2)).toContain("duration 2.000000");
  });
  it.each([
    [[], 1], [[NaN], 1], [[1], 0], [[1], Infinity],
    [[2, 1], 2], [[1, 1], 2], [[1, 3], 2],
  ])("rejects missing or unordered frame timing: %j, %s", (timestamps, duration) => {
    expect(() => frameTimeline(timestamps, duration)).toThrow("ordered frames");
  });
});
