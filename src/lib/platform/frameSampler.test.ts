import { describe, expect, it } from "vitest";
import { sampleFrames, summarizeFrameIntervals } from "@/lib/platform/frameSampler";

describe("summarizeFrameIntervals", () => {
  it("computes fps, percentiles, and jank from frame intervals", () => {
    // 10 frames over 200ms: nine 16ms frames + one 56ms hitch.
    const intervals = [16, 16, 16, 16, 16, 16, 16, 16, 16, 56];
    const stats = summarizeFrameIntervals(intervals, 200);
    expect(stats.frames).toBe(10);
    expect(stats.fps).toBeCloseTo(50, 5); // 10 / 200ms * 1000
    expect(stats.medianFrameMs).toBe(16);
    expect(stats.worstFrameMs).toBe(56);
    expect(stats.longFrames).toBe(1); // only the 56ms frame exceeds 33ms
    expect(stats.jankRatio).toBeCloseTo(0.1, 5);
  });

  it("returns null stats for an empty sample", () => {
    const stats = summarizeFrameIntervals([], 0);
    expect(stats.frames).toBe(0);
    expect(stats.fps).toBeNull();
    expect(stats.medianFrameMs).toBeNull();
    expect(stats.jankRatio).toBeNull();
  });
});

describe("sampleFrames", () => {
  it("collects intervals from injected raf/now and drops the biased first frame", async () => {
    // Deterministic clock advancing 16ms per rAF; sample until >=48ms elapsed.
    let t = 0;
    const raf = (cb: (t: number) => void) => {
      t += 16;
      // fire synchronously on a microtask so the promise resolves in-test.
      Promise.resolve().then(() => cb(t));
      return 0;
    };
    const stats = await sampleFrames(48, raf, () => 0);
    // frames at t=16,32,48,64; first interval dropped → intervals from 32,48,64.
    expect(stats.frames).toBeGreaterThanOrEqual(2);
    expect(stats.medianFrameMs).toBe(16);
  });
});
