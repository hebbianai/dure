import { describe, expect, it } from "vitest";
import {
  assertPaneToolbarSnapshot,
  assertChatComposerSnapshot,
  PANE_TOOLBAR_WIDTHS,
} from "./pane-toolbar-responsive-contract.mjs";

function rect(x, y, width, height, visible = true) {
  return { x, y, width, height, visible };
}

function snapshot(paneWidth) {
  const toolbar = rect(0, 0, paneWidth, 32);
  return {
    paneWidth,
    paneRect: rect(0, 0, paneWidth, 600),
    toolbar: { rect: toolbar, clientWidth: paneWidth, scrollWidth: paneWidth },
    diff: { ...rect(80, 6, 42, 20), text: "C2W3" },
    branch: {
      ...rect(130, 6, 52, 20),
      text: "↑1↓10",
    },
    credential: rect(8, 4, 24, 24),
    selectors: ["Model", "Reasoning effort", "View"].map((name, index) => ({
      ...rect(184 + index * 20, 4, 18, 24), name, operable: true,
    })),
  };
}

describe("pane toolbar responsive geometry contract", () => {
  it.each(PANE_TOOLBAR_WIDTHS)("accepts the %ipx priority layout", (width) => {
    expect(() => assertPaneToolbarSnapshot(snapshot(width))).not.toThrow();
  });

  it("rejects hidden branch divergence even at the narrowest width", () => {
    const broken = snapshot(250);
    broken.branch.visible = false;
    expect(() => assertPaneToolbarSnapshot(broken)).toThrow(
      "branch divergence summary must remain visible",
    );
  });

  it("rejects action overlap", () => {
    const broken = snapshot(320);
    broken.branch.x = 110;
    expect(() => assertPaneToolbarSnapshot(broken)).toThrow("overlap");
  });

  it("rejects a displaced selector even when wrapping grows the toolbar", () => {
    const broken = snapshot(250);
    broken.toolbar.rect.height = 80;
    broken.selectors[2].y = 40;
    expect(() => assertPaneToolbarSnapshot(broken)).toThrow("displaced");
  });

  it("rejects a selector covered by another element", () => {
    const broken = snapshot(320);
    broken.selectors[0].operable = false;
    expect(() => assertPaneToolbarSnapshot(broken)).toThrow("center click");
  });
});

it("rejects a permissions selector protruding from the chat composer", () => {
  const snapshot = {
    rect: rect(0, 0, 250, 100), clientWidth: 250, scrollWidth: 250,
    actions: ["Model", "Reasoning effort", "Permissions", "Send"].map((name, index) => ({
      ...rect(index * 30, 60, 24, 24), name, operable: true,
    })),
  };
  expect(() => assertChatComposerSnapshot(snapshot)).not.toThrow();
  snapshot.actions[2].width = 220;
  expect(() => assertChatComposerSnapshot(snapshot)).toThrow("right edge");
});
