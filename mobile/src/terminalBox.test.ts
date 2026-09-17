import { describe, expect, it } from "vitest";

import { terminalContentBox } from "./terminalBox";
import { DRAWER_LIFT_PROPERTY, KEYBOARD_LIFT_PROPERTY } from "./transcriptLift";

/** A laid-out host: jsdom resolves the styles, never the box. */
function hostOf(
  width: number,
  height: number,
  padding: string,
  lift: { drawer?: string; keyboard?: string } = {},
): HTMLElement {
  const host = document.createElement("div");
  host.style.padding = padding;
  if (lift.drawer) host.style.setProperty(DRAWER_LIFT_PROPERTY, lift.drawer);
  if (lift.keyboard) host.style.setProperty(KEYBOARD_LIFT_PROPERTY, lift.keyboard);
  Object.defineProperty(host, "clientWidth", { value: width });
  Object.defineProperty(host, "clientHeight", { value: height });
  document.body.append(host);
  return host;
}

describe("terminalContentBox", () => {
  it("takes the pane's own padding off the box", () => {
    expect(terminalContentBox(hostOf(390, 800, "16px"))).toEqual({
      width: 358,
      height: 768,
    });
  });

  it("ignores an open drawer, which never took the box in the first place", () => {
    // The tray is absolutely positioned: a drawer covers the transcript without
    // taking a pixel of its box, so there is nothing to add back. It lifts the
    // grid's floor instead, and that is not this number.
    const closed = terminalContentBox(hostOf(390, 800, "16px 16px 72px"));
    const open = terminalContentBox(
      hostOf(390, 800, "16px 16px 72px", { drawer: "300px" }),
    );
    expect(open).toEqual(closed);
  });

  it("reports the same box while the keyboard is up", () => {
    // The keyboard shrinks the visible viewport, so the host really is smaller;
    // the lift is exactly what it took.
    const down = terminalContentBox(hostOf(390, 800, "16px 16px 72px"));
    const up = terminalContentBox(
      hostOf(390, 464, "16px 16px 72px", { keyboard: "336px" }),
    );
    expect(up).toEqual(down);
  });

  it("holds the at-rest box with a drawer open under the keyboard", () => {
    const box = terminalContentBox(
      hostOf(390, 464, "16px 16px 72px", { drawer: "100px", keyboard: "336px" }),
    );
    expect(box.height).toBe(800 - 16 - 72);
  });

  it("still shrinks when the screen itself does", () => {
    // Rotation, a font change, a real resize: nothing is lifting the floor, so
    // the smaller box is the session's new size and has to be reported.
    const tall = terminalContentBox(hostOf(390, 800, "16px 16px 72px"));
    const short = terminalContentBox(hostOf(390, 400, "16px 16px 72px"));
    expect(short.height).toBeLessThan(tall.height);
  });

  it("never reports a negative box", () => {
    expect(terminalContentBox(hostOf(390, 40, "16px 16px 372px")).height).toBe(0);
  });

  it("reads no padding as none rather than as NaN", () => {
    expect(terminalContentBox(hostOf(390, 800, ""))).toEqual({
      width: 390,
      height: 800,
    });
  });
});
