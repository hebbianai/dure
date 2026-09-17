import { beforeEach, describe, expect, it } from "vitest";

import {
  DRAWER_LIFT_PROPERTY,
  KEYBOARD_LIFT_PROPERTY,
  STAGE_TOP_PROPERTY,
  TRAY_INSET_PROPERTY,
  publishTranscriptLift,
} from "./transcriptLift";

/** A node that reports a height, the way a laid-out one does. */
function boxOf(height: number): HTMLElement {
  const node = document.createElement("div");
  node.getBoundingClientRect = () => ({ height }) as DOMRect;
  return node;
}

/** The pill, its 8px gap and a 34px home indicator. */
const TRAY_AT_REST = 90;
/** The same tray with the keys up: it stops clearing the home indicator. */
const TRAY_WITH_KEYS = 60;

describe("publishTranscriptLift", () => {
  let root: HTMLElement;

  beforeEach(() => {
    root = document.createElement("html");
    // Every screen starts with the keys down, which is where the resting tray
    // is learnt from.
    publishTranscriptLift(root, { tray: boxOf(TRAY_AT_REST), drawer: null, covered: 0 });
  });

  it("publishes where the stage begins, for the space-bar pad, and clears it without one", () => {
    const stage = document.createElement("div");
    stage.getBoundingClientRect = () => ({ top: 108.4, height: 500 }) as DOMRect;
    publishTranscriptLift(root, { tray: boxOf(TRAY_AT_REST), drawer: null, covered: 0, stage });
    expect(root.style.getPropertyValue(STAGE_TOP_PROPERTY)).toBe("108px");
    publishTranscriptLift(root, { tray: boxOf(TRAY_AT_REST), drawer: null, covered: 0 });
    expect(root.style.getPropertyValue(STAGE_TOP_PROPERTY)).toBe("");
  });

  const reserved = () => root.style.getPropertyValue(TRAY_INSET_PROPERTY);
  const drawer = () => root.style.getPropertyValue(DRAWER_LIFT_PROPERTY);
  const keyboard = () => root.style.getPropertyValue(KEYBOARD_LIFT_PROPERTY);

  it("reserves the tray and lifts nothing at rest", () => {
    expect(reserved()).toBe("90px");
    expect(drawer()).toBe("");
    expect(keyboard()).toBe("");
  });

  it("lifts the floor by an open drawer without touching the reservation", () => {
    publishTranscriptLift(root, {
      tray: boxOf(TRAY_AT_REST + 300),
      drawer: boxOf(300),
      covered: 0,
    });
    // The reservation is the tray *without* its drawer: the pill is still all
    // the session is sized against, which is what keeps a drawer from resizing
    // it.
    expect(reserved()).toBe("90px");
    expect(drawer()).toBe("300px");
  });

  it("lifts by what the keys cover, less what the tray gave back", () => {
    publishTranscriptLift(root, { tray: boxOf(TRAY_WITH_KEYS), drawer: null, covered: 336 });
    expect(reserved()).toBe("60px");
    // 336 covered, 30 of tray handed back. Lifting the full 336 would leave the
    // last line sitting 30px further from the pill than a drawer leaves it.
    expect(keyboard()).toBe("306px");
  });

  it("gives it all back when the keys go down", () => {
    publishTranscriptLift(root, { tray: boxOf(TRAY_WITH_KEYS), drawer: null, covered: 336 });
    publishTranscriptLift(root, { tray: boxOf(TRAY_AT_REST), drawer: null, covered: 0 });
    expect(reserved()).toBe("90px");
    expect(keyboard()).toBe("");
  });

  it("relearns the resting tray after a rotation", () => {
    // Landscape has a shorter home indicator, so the tray at rest is shorter
    // and the keys hand back less. A remembered portrait tray would over-lift.
    publishTranscriptLift(root, { tray: boxOf(77), drawer: null, covered: 0 });
    publishTranscriptLift(root, { tray: boxOf(TRAY_WITH_KEYS), drawer: null, covered: 200 });
    expect(keyboard()).toBe("183px");
  });

  it("rounds up so no row is left half under what stands on it", () => {
    publishTranscriptLift(root, { tray: boxOf(90.25), drawer: null, covered: 0 });
    expect(reserved()).toBe("91px");
  });

  it("clears everything on a screen with no tray", () => {
    publishTranscriptLift(root, {
      tray: boxOf(TRAY_AT_REST + 300),
      drawer: boxOf(300),
      covered: 0,
    });
    publishTranscriptLift(root, { tray: null, drawer: null, covered: 0 });
    expect(reserved()).toBe("");
    expect(drawer()).toBe("");
    expect(keyboard()).toBe("");
  });

  it("keeps the stylesheet's defaults until the tray has been laid out", () => {
    publishTranscriptLift(root, { tray: boxOf(0), drawer: null, covered: 0 });
    expect(reserved()).toBe("");
  });
});
