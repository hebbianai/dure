import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COL_PX, HOLD_MS, HOLD_SLOP, ROW_PX, attachHoldDrag, cellsFrom } from "./holdDrag";
import type { TrackpadDirection } from "./spaceTrackpad";

describe("cellsFrom", () => {
  it("counts whole rows and columns from where the hold began", () => {
    const origin = { x: 100, y: 300 };
    expect(cellsFrom(origin, 100, 300)).toEqual({ rows: 0, cols: 0 });
    expect(cellsFrom(origin, 100, 300 - ROW_PX * 2)).toEqual({ rows: -2, cols: 0 });
    expect(cellsFrom(origin, 100 + COL_PX * 3 + 5, 300)).toEqual({ rows: 0, cols: 3 });
  });
});

describe("attachHoldDrag", () => {
  let node: HTMLElement;
  let pressed: TrackpadDirection[];
  let shown: (TrackpadDirection | undefined)[];
  let clock: number;
  let stop: () => void;

  const fire = (type: string, x: number, y: number): void => {
    node.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y }));
  };

  beforeEach(() => {
    vi.useFakeTimers();
    clock = 0;
    node = document.createElement("div");
    document.body.append(node);
    pressed = [];
    shown = [];
    stop = attachHoldDrag(node, {
      press: (direction) => pressed.push(direction),
      direction: (direction) => shown.push(direction),
      now: () => clock,
    });
  });

  afterEach(() => {
    stop();
    node.remove();
    vi.useRealTimers();
  });

  it("arms after the hold and turns rows into ↑", () => {
    fire("pointerdown", 100, 400);
    vi.advanceTimersByTime(HOLD_MS);
    clock = HOLD_MS;
    fire("pointermove", 100, 400 - ROW_PX * 2);
    expect(pressed).toEqual(["up", "up"]);
    expect(shown).toEqual(["up"]);
    clock += 16;
    fire("pointermove", 100, 400 - ROW_PX * 3);
    expect(pressed).toEqual(["up", "up", "up"]);
    fire("pointerup", 100, 400 - ROW_PX * 3);
    expect(shown[shown.length - 1]).toBeUndefined();
  });

  it("is a scroll, not a drag, if the finger moves before the hold", () => {
    fire("pointerdown", 100, 400);
    fire("pointermove", 100, 400 - HOLD_SLOP - 1);
    vi.advanceTimersByTime(HOLD_MS);
    fire("pointermove", 100, 400 - ROW_PX * 3);
    expect(pressed).toEqual([]);
    expect(shown).toEqual([]);
  });

  it("turns columns into ←→ once armed", () => {
    fire("pointerdown", 200, 400);
    vi.advanceTimersByTime(HOLD_MS);
    clock = HOLD_MS;
    fire("pointermove", 200 + COL_PX * 2, 400);
    expect(pressed).toEqual(["right", "right"]);
  });

  it("cancels a touchmove on a child once armed, before the child hears it", () => {
    const child = document.createElement("div");
    node.append(child);
    let cancelledWhenChildHeard: boolean | undefined;
    child.addEventListener("touchmove", (event) => {
      cancelledWhenChildHeard = event.defaultPrevented;
    });
    fire("pointerdown", 100, 400);
    vi.advanceTimersByTime(HOLD_MS);
    const move = new Event("touchmove", { bubbles: true, cancelable: true });
    child.dispatchEvent(move);
    expect(move.defaultPrevented).toBe(true);
    expect(cancelledWhenChildHeard).toBe(true);
  });

  it("sends nothing after it is stopped", () => {
    stop();
    fire("pointerdown", 100, 400);
    vi.advanceTimersByTime(HOLD_MS);
    fire("pointermove", 100, 400 - ROW_PX * 2);
    expect(pressed).toEqual([]);
    stop = () => {};
  });
});
