import { describe, expect, it } from "vitest";
import { DOUBLE_TAP_MS, DOUBLE_TAP_SLOP, attachDoubleTap, pairTap } from "./doubleTap";

describe("pairTap", () => {
  it("pairs two taps close in time and place", () => {
    const first = pairTap(undefined, { x: 100, y: 200, at: 0 });
    expect(first.double).toBe(false);
    const second = pairTap(first.pending, { x: 104, y: 196, at: 120 });
    expect(second.double).toBe(true);
    // Spent: a third tap starts over.
    expect(second.pending).toBeUndefined();
  });

  it("does not pair taps too far apart in time", () => {
    const first = pairTap(undefined, { x: 100, y: 200, at: 0 });
    const late = pairTap(first.pending, { x: 100, y: 200, at: DOUBLE_TAP_MS + 1 });
    expect(late.double).toBe(false);
    // The late tap is the new first.
    expect(late.pending?.at).toBe(DOUBLE_TAP_MS + 1);
  });

  it("does not pair taps too far apart on the screen", () => {
    const first = pairTap(undefined, { x: 100, y: 200, at: 0 });
    const far = pairTap(first.pending, { x: 100 + DOUBLE_TAP_SLOP + 1, y: 200, at: 50 });
    expect(far.double).toBe(false);
  });
});

describe("attachDoubleTap", () => {
  const tap = (node: HTMLElement, x = 10, y = 10): void => {
    node.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: x, clientY: y }));
  };
  const touch = (identifier: number, x: number, y: number): Touch =>
    ({ identifier, clientX: x, clientY: y }) as Touch;
  const touchList = (...touches: Touch[]): TouchList =>
    ({
      length: touches.length,
      item: (index: number) => touches[index] ?? null,
    }) as TouchList;
  const touchEvent = (
    type: string,
    options: { touches?: Touch[]; changed?: Touch[] },
  ): Event => {
    const event = new Event(type, { bubbles: true });
    Object.defineProperty(event, "touches", { value: touchList(...(options.touches ?? [])) });
    Object.defineProperty(event, "changedTouches", {
      value: touchList(...(options.changed ?? [])),
    });
    return event;
  };
  const withTouchDevice = (run: () => void): void => {
    const descriptor = Object.getOwnPropertyDescriptor(navigator, "maxTouchPoints");
    Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, value: 5 });
    try {
      run();
    } finally {
      if (descriptor === undefined) {
        delete (navigator as { maxTouchPoints?: number }).maxTouchPoints;
      } else {
        Object.defineProperty(navigator, "maxTouchPoints", descriptor);
      }
    }
  };
  const fingerStart = (node: HTMLElement, x = 10, y = 10): void => {
    const down = touch(7, x, y);
    node.dispatchEvent(touchEvent("touchstart", { touches: [down], changed: [down] }));
  };
  const fingerMove = (node: HTMLElement, x: number, y: number): void => {
    node.dispatchEvent(touchEvent("touchmove", { touches: [touch(7, x, y)] }));
  };
  const fingerEnd = (node: HTMLElement, x = 10, y = 10): void => {
    node.dispatchEvent(touchEvent("touchend", { changed: [touch(7, x, y)] }));
  };
  const fingerTap = (node: HTMLElement, x = 10, y = 10): void => {
    fingerStart(node, x, y);
    fingerEnd(node, x, y);
  };

  it("fires once for two taps, not for one, and not again for a third", () => {
    let clock = 0;
    let fired = 0;
    const node = document.createElement("div");
    const stop = attachDoubleTap(node, { onDouble: () => (fired += 1), now: () => clock });
    tap(node);
    expect(fired).toBe(0);
    clock = 100;
    tap(node);
    expect(fired).toBe(1);
    clock = 200;
    tap(node);
    expect(fired).toBe(1);
    stop();
    clock = 250;
    tap(node);
    expect(fired).toBe(1);
  });

  it("leaves taps on things that do their own job out of the count", () => {
    let fired = 0;
    const node = document.createElement("div");
    const button = document.createElement("button");
    node.append(button);
    attachDoubleTap(node, {
      onDouble: () => (fired += 1),
      counts: (target) => !(target instanceof HTMLButtonElement),
      now: () => 0,
    });
    tap(button);
    tap(button);
    expect(fired).toBe(0);
    tap(node);
    tap(node);
    expect(fired).toBe(1);
  });

  it("uses touch taps on touch devices and does not double count compatibility clicks", () => {
    withTouchDevice(() => {
      let clock = 0;
      let fired = 0;
      const node = document.createElement("div");
      attachDoubleTap(node, { onDouble: () => (fired += 1), now: () => clock });
      fingerTap(node);
      expect(fired).toBe(0);
      clock = 100;
      fingerTap(node);
      expect(fired).toBe(1);
      tap(node);
      tap(node);
      expect(fired).toBe(1);
    });
  });

  it("does not count touch drags or holds as taps", () => {
    withTouchDevice(() => {
      let clock = 0;
      let fired = 0;
      const node = document.createElement("div");
      attachDoubleTap(node, { onDouble: () => (fired += 1), now: () => clock });
      fingerStart(node, 10, 10);
      fingerMove(node, 10 + DOUBLE_TAP_SLOP + 1, 10);
      fingerEnd(node, 10, 10);
      clock = 100;
      fingerTap(node, 10, 10);
      expect(fired).toBe(0);

      clock = 500;
      fingerStart(node, 20, 20);
      clock += DOUBLE_TAP_MS + 1;
      fingerEnd(node, 20, 20);
      clock += 100;
      fingerTap(node, 20, 20);
      expect(fired).toBe(0);
    });
  });

  it("leaves touch taps on controls out of the count", () => {
    withTouchDevice(() => {
      let fired = 0;
      const node = document.createElement("div");
      const button = document.createElement("button");
      node.append(button);
      attachDoubleTap(node, {
        onDouble: () => (fired += 1),
        counts: (target) => !(target instanceof HTMLButtonElement),
        now: () => 0,
      });
      fingerTap(button);
      fingerTap(button);
      expect(fired).toBe(0);
      fingerTap(node);
      fingerTap(node);
      expect(fired).toBe(1);
    });
  });
});
