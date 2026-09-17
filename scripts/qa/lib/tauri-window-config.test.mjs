import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { qaTauriConfig, qaWindowPlan } from "./tauri-window-config.mjs";

const mainWindow = JSON.parse(
  fs.readFileSync(new URL("../../../src-tauri/tauri.macos.conf.json", import.meta.url)),
).app.windows[0];
const window = {
  label: "main",
  title: "Native pane drag QA",
  url: "index.html",
  width: 1480,
  height: 940,
};
const plan = (overrides = {}) => qaWindowPlan({
  serialized: JSON.stringify([{ ...window, ...overrides }]),
  title: "Unused default",
  url: "index.html",
});

describe("native QA window appearance", () => {
  it("passes the actual macOS glass and first-click options to Tauri", () => {
    const config = qaTauriConfig({
      layer: "native_input_pane_drag",
      port: "1421",
      serializedWindows: JSON.stringify([{
        ...window,
        transparent: mainWindow.transparent,
        acceptFirstMouse: mainWindow.acceptFirstMouse,
        windowEffects: mainWindow.windowEffects,
      }]),
      title: "Unused default",
      url: "index.html",
    });
    expect(config.app.windows[0]).toMatchObject({
      transparent: true,
      acceptFirstMouse: true,
      windowEffects: mainWindow.windowEffects,
      dragDropEnabled: false,
      backgroundThrottling: "disabled",
    });
    expect(config.app.security.capabilities).toEqual([
      "default",
      {
        identifier: "native-input-pane-drag-window-title-proof",
        windows: ["main"],
        permissions: ["core:window:allow-set-title"],
      },
    ]);
  });

  it("leaves existing explicit opaque and legacy hidden windows unchanged", () => {
    const explicit = plan()[0];
    expect(explicit.transparent).toBe(false);
    expect(explicit).not.toHaveProperty("windowEffects");
    expect(explicit).not.toHaveProperty("acceptFirstMouse");
    expect(qaWindowPlan({ title: "Legacy", url: "index.html" })).toEqual([{
      label: "main", title: "Legacy", url: "index.html",
      width: 480, height: 240, visible: false, focus: false, focusable: false,
      backgroundThrottling: "disabled",
    }]);
  });

  it("supports explicit inactive material without forcing activation", () => {
    expect(plan({ windowEffects: { effects: ["menu"], state: "inactive", radius: 4.5 }, acceptFirstMouse: false })[0])
      .toMatchObject({ windowEffects: { effects: ["menu"], state: "inactive", radius: 4.5 }, acceptFirstMouse: false });
  });

  it.each([
    { effects: ["invented-material"] },
    { effects: "menu" },
    { effects: ["menu"], state: "invented-state" },
    { effects: ["menu"], radius: -1 },
    { effects: ["menu"], radius: "12" },
    { effects: ["menu"], additionalCapability: true },
  ])("rejects invalid or expanded effect options: %j", (windowEffects) => {
    expect(() => plan({ windowEffects })).toThrow();
  });

  it.each([
    { url: "https://example.com" },
    { capabilities: ["all"] },
    { acceptFirstMouse: "true" },
  ])("keeps the existing URL and option boundary: %j", (overrides) => {
    expect(() => plan(overrides)).toThrow();
  });
});
