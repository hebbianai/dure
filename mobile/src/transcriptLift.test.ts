import { beforeEach, describe, expect, it } from "vitest";

import {
  DRAWER_LIFT_PROPERTY,
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
    publishTranscriptLift(root, { tray: boxOf(TRAY_AT_REST), drawer: null });
  });

  it("publishes where the stage begins, for the space-bar pad, and clears it without one", () => {
    const stage = document.createElement("div");
    stage.getBoundingClientRect = () => ({ top: 108.4, height: 500 }) as DOMRect;
    publishTranscriptLift(root, { tray: boxOf(TRAY_AT_REST), drawer: null, stage });
    expect(root.style.getPropertyValue(STAGE_TOP_PROPERTY)).toBe("108px");
    publishTranscriptLift(root, { tray: boxOf(TRAY_AT_REST), drawer: null });
    expect(root.style.getPropertyValue(STAGE_TOP_PROPERTY)).toBe("");
  });

  const reserved = () => root.style.getPropertyValue(TRAY_INSET_PROPERTY);
  const drawer = () => root.style.getPropertyValue(DRAWER_LIFT_PROPERTY);

  it("reserves the tray and lifts nothing at rest", () => {
    expect(reserved()).toBe("90px");
    expect(drawer()).toBe("");
  });

  it("lifts the floor by an open drawer without touching the reservation", () => {
    publishTranscriptLift(root, {
      tray: boxOf(TRAY_AT_REST + 300),
      drawer: boxOf(300),
    });
    // The reservation is the tray *without* its drawer: the pill is still all
    // the session is sized against, which is what keeps a drawer from resizing
    // it.
    expect(reserved()).toBe("90px");
    expect(drawer()).toBe("300px");
  });

  it("tracks the tray inset as the keyboard opens and closes", () => {
    publishTranscriptLift(root, { tray: boxOf(TRAY_WITH_KEYS), drawer: null });
    expect(reserved()).toBe("60px");
    expect(drawer()).toBe("");
    publishTranscriptLift(root, { tray: boxOf(TRAY_AT_REST), drawer: null });
    expect(reserved()).toBe("90px");
    expect(drawer()).toBe("");
  });

  it("rounds up so no row is left half under what stands on it", () => {
    publishTranscriptLift(root, { tray: boxOf(90.25), drawer: null });
    expect(reserved()).toBe("91px");
  });

  it("clears everything on a screen with no tray", () => {
    publishTranscriptLift(root, {
      tray: boxOf(TRAY_AT_REST + 300),
      drawer: boxOf(300),
    });
    publishTranscriptLift(root, { tray: null, drawer: null });
    expect(reserved()).toBe("");
    expect(drawer()).toBe("");
  });

  it("keeps the stylesheet's defaults until the tray has been laid out", () => {
    publishTranscriptLift(root, { tray: boxOf(0), drawer: null });
    expect(reserved()).toBe("");
  });
});
