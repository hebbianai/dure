import { describe, expect, it } from "vitest";
import { tourPointerAt, validateTourInput } from "../tools/media-capture/compositor/tour-motion.mjs";

const events = [
  { kind: "move", atMs: 1000, x: .6, y: .7 },
  { kind: "move", atMs: 2000, x: .8, y: .5 },
  { kind: "down", atMs: 2200, x: .8, y: .5 },
  { kind: "up", atMs: 2300, x: .8, y: .5 },
];
describe("recorded product tour motion", () => {
  it("appears at the first relevant target instead of travelling from a fixed origin", () => {
    expect(tourPointerAt(events, 0)).toBeNull();
    expect(tourPointerAt(events, 1000)).toMatchObject({ x: .6, y: .7 });
  });
  it("draws distinct intermediate positions at 60 fps and reaches the real click target", () => {
    const frames = Array.from({ length: 15 }, (_, i) => tourPointerAt(events, 1750 + i * 1000 / 60));
    expect(new Set(frames.map((point) => point.x)).size).toBe(15);
    expect(frames.every((point, i) => i === 0 || point.x > frames[i - 1].x)).toBe(true);
    expect(tourPointerAt(events, 2200)).toMatchObject({ x: .8, y: .5 });
  });
  it("keeps drag movement linear between observed input samples", () => {
    const drag = [events[0], { ...events[0], kind: "down", atMs: 1100 }, { ...events[1], atMs: 1200 }];
    expect(tourPointerAt(drag, 1150).x).toBeCloseTo(.7);
    expect(tourPointerAt(drag, 1150).y).toBeCloseTo(.6);
  });
  it("fades the pointer after its final action", () => {
    expect(tourPointerAt(events, 4000).opacity).toBe(0);
    expect(tourPointerAt([], 2000)).toBeNull();
  });
  it("validates ordered, bounded gesture evidence", () => {
    const input = { schemaVersion: 1, number: 1, title: "Start an agent", intro: "Keep your work visible.", events };
    expect(validateTourInput(input, 3000)).toBe(input);
    for (const changed of [[{ ...events[0], x: NaN }], [{ ...events[0], x: 2 }], [events[1], events[0]], [{ ...events[0], atMs: 4000 }]]) {
      expect(() => validateTourInput({ ...input, events: changed }, 3000)).toThrow("Invalid recorded tour");
    }
  });
});
