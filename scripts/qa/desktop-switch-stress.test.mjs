import { afterEach, expect, it, vi } from "vitest";

const browser = vi.hoisted(() => ({ page: {} }));
vi.mock("@playwright/test", () => ({
  chromium: { launch: async () => ({ newPage: async () => browser.page }) },
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it.each(["neutral", "mixed", "legacy"])(
  "focuses actual file content independently of %s IDs",
  async (variant) => {
    vi.resetModules();
    for (const [key, value] of Object.entries({
      DESKTOPS: "2",
      PANES: "2",
      TERMINALS: variant === "legacy" ? "0" : "2",
      HEAVY_TERMINALS: "0",
      PANE_FOCUS_SAMPLES: "4",
      PERF_URL: "http://127.0.0.1:1/unused",
    })) vi.stubEnv(key, value);
    const focused = [];
    const expected = [];
    const spaces = new Map();
    const state = {
      activeDesktopId: "source",
      layouts: {},
      addDesktop: () => {
        const id = `space-${spaces.size}`;
        addSpace(id);
        return id;
      },
      setActiveDesktop: (id) => { state.activeDesktopId = id; },
      setTerminalPrefs: () => {},
    };
    function addSpace(id) {
      const panels = [];
      spaces.set(id, {
        panels,
        getPanel: (paneId) => panels.find((pane) => pane.id === paneId),
      });
      state.layouts[id] = { panels: {} };
    }
    addSpace("source");
    function addPane(spaceId, component) {
      const panes = spaces.get(spaceId).panels;
      const legacy = component !== "fileviewer" || variant === "legacy" ||
        (variant === "mixed" && panes.length === 1);
      const id = `${legacy ? "file:" : "pane-"}${spaceId}-${panes.length}`;
      panes.push({ id, api: { component, setActive: () => focused.push(id) } });
      state.layouts[spaceId].panels[id] = { contentComponent: component };
      if (spaceId === "source" && component === "fileviewer") expected.push(id);
    }
    const store = Object.assign(() => state, { getState: () => state });
    const observedFocusPhase = new Error(
      "Stopped after the actual script's existing-pane focus phase",
    );
    let snapshots = 0;
    vi.stubGlobal("window", {
      __DURE_STORE__: store,
      __DURE_FRAME_SAMPLE__: () => {},
      __DURE_DOCK__: {
        getDockview: (id) => spaces.get(id),
        openFileViewer: (id) => addPane(id, "fileviewer"),
        openLocalTerminalPanel: (id) => addPane(id, "terminal"),
      },
      __DURE_WORKSPACE_DIAGNOSTICS__: () => {
        if (++snapshots === 3) throw observedFocusPhase;
        return { totals: {}, workspaces: [...spaces.values()], transitions: [] };
      },
    });
    // Execute the real script callbacks; this selector-boundary fixture does
    // not measure browser, native focus, backend behavior or performance.
    browser.page = {
      on: () => {},
      addInitScript: async () => {},
      goto: async () => {},
      waitForTimeout: async () => {},
      waitForFunction: async (predicate, value) => {
        expect(predicate(value)).toBeTruthy();
      },
      evaluate: async (callback, value) => callback(value),
    };
    await expect(import("./desktop-switch-stress.mjs"))
      .rejects.toBe(observedFocusPhase);
    expect(focused).toEqual([
      expected[0], expected[1], expected[0], expected[1],
    ]);
  },
);
