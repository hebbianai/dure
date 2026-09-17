// Desktop-switch stress: N desktops × file/terminal panes, cold visits, then seeded
// zipf/uniform ⌘-style jumps. Real dockview/xterm/CodeMirror rendering with
// the canned tauri backend — measures switchPaint warm/cold ratio, remount
// cost, pane opens, and frame smoothness under many-desktop switching.
//
//   pnpm perf:desktop-stress                # zipf jumps (default)
//   PATTERN=uniform pnpm perf:desktop-stress
//   TERMINALS=3 PANES=0 pnpm perf:desktop-stress
//   HEAVY_TERMINALS=8                       # desktop 0 extra panes (default)
import { chromium } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { evaluateWorkspacePerformanceSlo } from "./lib/workspace-performance-slo.mjs";

const APP_URL = process.env.PERF_URL ?? "http://localhost:1426";
const OUT = process.env.PERF_OUT ?? "/tmp/desktop-switch-stress.json";
const VARIANT = process.env.PERF_VARIANT ?? "default";
const mock = readFileSync(new (globalThis.URL)("./tauri-mock.js", import.meta.url), "utf8");

const DESKTOPS = Number(process.env.DESKTOPS ?? 9);
const FILE_PANES_PER_DESKTOP = Number(process.env.PANES ?? 2);
const TERMINAL_PANES_PER_DESKTOP = Number(process.env.TERMINALS ?? 0);
// The daily-driver regression is asymmetric: one 9-pane HebbianIDE desktop
// beside mostly light desktops. Keep that shape in the default gate instead of
// relying only on uniform one-pane worlds.
const HEAVY_TERMINAL_PANES = Number(process.env.HEAVY_TERMINALS ?? 8);
const ROUND_TRIPS = Number(process.env.ROUND_TRIPS ?? 12);
const WARM_DWELL_MS = Number(process.env.WARM_DWELL_MS ?? 350);
const COLD_DWELL_MS = Number(process.env.COLD_DWELL_MS ?? 1400);
const PANE_BUILD_TIMEOUT_MS = Number(process.env.PANE_BUILD_TIMEOUT_MS ?? 10_000);
const PANE_SETTLE_MS = Number(process.env.PANE_SETTLE_MS ?? 600);
const PANE_FOCUS_SAMPLES = Number(process.env.PANE_FOCUS_SAMPLES ?? 12);
const PANE_FOCUS_DWELL_MS = Number(process.env.PANE_FOCUS_DWELL_MS ?? 60);
const MODEL_PROBE_EVICTION_DWELL_MS = Number(
  process.env.MODEL_PROBE_EVICTION_DWELL_MS ?? 120,
);
const MODEL_PROBE_CHECKPOINT_MS = Number(
  process.env.MODEL_PROBE_CHECKPOINT_MS ?? 100,
);
const ASSERT_BUDGETS = process.env.PERF_ASSERT !== "0";
const ASSERT_PROFILE = process.env.PERF_ASSERT_PROFILE ?? "full";
if (!new Set(["full", "webgl-scale"]).has(ASSERT_PROFILE)) {
  throw new Error(`unknown PERF_ASSERT_PROFILE: ${ASSERT_PROFILE}`);
}
const PERF_LOGICAL_CORES = Number(process.env.PERF_LOGICAL_CORES ?? "");
// Chromium cannot reproduce WKWebView's renderer cost/ceiling. The product's
// Tauri `auto` policy selects DOM, so the default algorithmic SLO must do the
// same. WebGL-specific scale/recovery probes opt in with PERF_GPU=on.
const PERF_GPU =
  process.env.PERF_GPU ?? (ASSERT_PROFILE === "webgl-scale" ? "on" : "off");
if (!new Set(["auto", "on", "off"]).has(PERF_GPU)) {
  throw new Error(`unknown PERF_GPU: ${PERF_GPU}`);
}
const INJECT_WEBGL_CONTEXT_LOSS = process.env.PERF_INJECT_WEBGL_CONTEXT_LOSS === "1";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const pageErrors = [];
const webglContextWarnings = [];
const deprecatedXtermWriteWarnings = [];
const xtermTaskQueueDeadlineWarnings = [];
page.on("pageerror", (error) =>
  pageErrors.push(String(error.stack ?? error.message).slice(0, 1_200)),
);
page.on("console", (message) => {
  const text = message.text();
  if (
    /webglcontextlost|webgl context (?:not restored|will be lost)|too many active webgl contexts/i.test(
      text,
    )
  ) {
    webglContextWarnings.push(text.slice(0, 1_200));
  }
  if (/writeSync is unreliable and will be removed soon/i.test(text)) {
    deprecatedXtermWriteWarnings.push(text.slice(0, 1_200));
  }
  if (/task queue exceeded allotted deadline by \d+ms/i.test(text)) {
    xtermTaskQueueDeadlineWarnings.push(text.slice(0, 1_200));
  }
});
await page.addInitScript(() => {
  globalThis.__DURE_WEBGL_CONTEXT_LOSS_COUNT__ = 0;
  globalThis.addEventListener(
    "webglcontextlost",
    () => {
      globalThis.__DURE_WEBGL_CONTEXT_LOSS_COUNT__ += 1;
    },
    true,
  );
});
await page.addInitScript(mock);
if (Number.isFinite(PERF_LOGICAL_CORES) && PERF_LOGICAL_CORES > 0) {
  await page.addInitScript((logicalCores) => {
    Object.defineProperty(navigator, "hardwareConcurrency", {
      configurable: true,
      value: logicalCores,
    });
  }, PERF_LOGICAL_CORES);
}

await page.goto(APP_URL, { waitUntil: "networkidle" });
await page.waitForFunction(
  () =>
    typeof window.__DURE_DOCK__ === "object" &&
    typeof window.__DURE_STORE__ === "function" &&
    typeof window.__DURE_FRAME_SAMPLE__ === "function",
  null,
  { timeout: 20000 },
);
if (INJECT_WEBGL_CONTEXT_LOSS) {
  await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    document.body.append(canvas);
    canvas.dispatchEvent(new Event("webglcontextlost"));
    canvas.remove();
  });
}

const first = await page.evaluate(() => window.__DURE_STORE__.getState().activeDesktopId);
await page.evaluate((gpu) => {
  window.__DURE_STORE__.getState().setTerminalPrefs({ gpu });
}, PERF_GPU);

// 1) Build the world: extra desktops, each with file panes (real CodeMirror).
const ids = await page.evaluate(
  ([firstId, count]) => {
    const st = window.__DURE_STORE__.getState();
    const created = [firstId];
    for (let i = 1; i < count; i++) created.push(st.addDesktop({ activate: false }));
    return created;
  },
  [first, DESKTOPS],
);
// Populate panes desktop by desktop while visiting it (so dockview exists).
const paneBuilds = [];
for (let i = 0; i < ids.length; i++) {
  await page.evaluate((id) => window.__DURE_STORE__.getState().setActiveDesktop(id), ids[i]);
  await page.waitForTimeout(COLD_DWELL_MS); // cold visit: mount + initial terminal hydration
  const expectedPanelCount = await page.evaluate(
    ([id, fileCount, terminalCount, idx]) => {
      const before = window.__DURE_DOCK__.getDockview(id)?.panels.length ?? 0;
      for (let p = 0; p < fileCount; p++) {
        window.__DURE_DOCK__.openFileViewer(id, {
          path: `/repo/src/stress-${idx}-${p}.ts`,
          source: "local",
        });
      }
      for (let p = 0; p < terminalCount; p++) {
        window.__DURE_DOCK__.openLocalTerminalPanel(id);
      }
      return before + fileCount + terminalCount;
    },
    [
      ids[i],
      FILE_PANES_PER_DESKTOP,
      TERMINAL_PANES_PER_DESKTOP + (i === 0 ? HEAVY_TERMINAL_PANES : 0),
      i,
    ],
  );
  await page.waitForFunction(
    ([id, expected]) =>
      (window.__DURE_DOCK__.getDockview(id)?.panels.length ?? 0) >= expected,
    [ids[i], expectedPanelCount],
    { timeout: PANE_BUILD_TIMEOUT_MS },
  );
  // Persist the complete split layout before switching away. Async Hmux
  // fallback creation can otherwise race the 400ms layout-save debounce and
  // make a nominal 9-pane cold test restore only its initial terminal.
  await page.waitForTimeout(PANE_SETTLE_MS);
  paneBuilds.push(
    await page.evaluate(
      ([id, expected]) => {
        const dock = window.__DURE_DOCK__.getDockview(id);
        const layout = window.__DURE_STORE__.getState().layouts[id];
        const persistedPanels = layout?.panels;
        return {
          desktopId: id,
          expectedPanels: expected,
          mountedPanels: dock?.panels.length ?? 0,
          persistedPanels: Array.isArray(persistedPanels)
            ? persistedPanels.length
            : Object.keys(persistedPanels ?? {}).length,
        };
      },
      [ids[i], expectedPanelCount],
    ),
  );
}

// Snapshot the world state after build-out.
const builtWorld = await page.evaluate(() => {
  const d = window.__DURE_WORKSPACE_DIAGNOSTICS__();
  return {
    totals: d.totals,
    workspaces: d.workspaces.length,
    lastTransitionSequence: Math.max(
      0,
      ...d.transitions.map((sample) => sample.sequence),
    ),
  };
});

// Exact regression probe: heavy A → light B → immediate A must not become
// cold merely because frequency/prewarm hints were reconciled in between.
await page.evaluate((id) => window.__DURE_STORE__.getState().setActiveDesktop(id), ids[0]);
await page.waitForTimeout(COLD_DWELL_MS);
await page.evaluate((id) => window.__DURE_STORE__.getState().setActiveDesktop(id), ids[1]);
await page.waitForTimeout(WARM_DWELL_MS);
await page.evaluate((id) => window.__DURE_STORE__.getState().setActiveDesktop(id), ids[0]);
await page.waitForTimeout(WARM_DWELL_MS);
const returnProbe = await page.evaluate((heavyId) => {
  const transitions = window.__DURE_WORKSPACE_DIAGNOSTICS__().transitions;
  const sample = [...transitions]
    .reverse()
    .find((transition) => transition.desktopId === heavyId);
  return sample
    ? {
        sequence: sample.sequence,
        desktopId: sample.desktopId,
        cacheState: sample.cacheState,
        workspacePaintMs: sample.workspacePaintMs,
        firstTerminalPaintMs: sample.firstTerminalPaintMs,
        allTerminalStableMs: sample.allTerminalStableMs,
        expectedTerminalPanes: sample.expectedTerminalPanes,
        paintedTerminalPanes: sample.paintedTerminalPanes,
        stableTerminalPanes: sample.stableTerminalPanes,
      }
    : null;
}, ids[0]);
const terminalStabilityAfterReturn = await page.evaluate(() =>
  typeof window.__DURE_TERMINAL_STABILITY__ === "function"
    ? window.__DURE_TERMINAL_STABILITY__()
    : [],
);

// Measure existing-pane focus, not the first activation that constructs a new
// pane. Alternating two already-mounted file panes exercises Dockview + React
// focus handoff without folding CodeMirror mount cost into the focus SLO.
const focusPanelIds = await page.evaluate((desktopId) => {
  const dock = window.__DURE_DOCK__.getDockview(desktopId);
  return (
    dock?.panels
      .filter((panel) => panel.api.component === "fileviewer")
      .slice(0, 2)
      .map((panel) => panel.id) ?? []
  );
}, ids[0]);
if (focusPanelIds.length >= 2) {
  for (let sample = 0; sample < PANE_FOCUS_SAMPLES; sample++) {
    await page.evaluate(
      ([desktopId, panelId]) => {
        const dock = window.__DURE_DOCK__.getDockview(desktopId);
        dock?.getPanel(panelId)?.api.setActive();
      },
      [ids[0], focusPanelIds[sample % focusPanelIds.length]],
    );
    await page.waitForTimeout(PANE_FOCUS_DWELL_MS);
  }
}
const afterBuild = await page.evaluate(() => {
  const d = window.__DURE_WORKSPACE_DIAGNOSTICS__();
  return {
    totals: d.totals,
    workspaces: d.workspaces.length,
    lastTransitionSequence: Math.max(
      0,
      ...d.transitions.map((sample) => sample.sequence),
    ),
  };
});
// Capture initial/first-visit journeys before the bounded transition ring is
// intentionally filled by the long switching phase. Reading them only at the
// end made a valid first visit disappear and let the gate inspect no sample.
const buildJourneyReport = await page.evaluate(
  () => window.__DURE_WORKSPACE_REPORT__(),
);

// Visit every other workspace, then sample the heavy return at fixed
// checkpoints. The captured tier is part of the evidence: renderer means it
// stayed warm, model means its DOM/xterm state survived GPU eviction, and cold
// means the retention policy discarded it.
for (const desktopId of ids.slice(1)) {
  await page.evaluate(
    (id) => window.__DURE_STORE__.getState().setActiveDesktop(id),
    desktopId,
  );
  await page.waitForTimeout(MODEL_PROBE_EVICTION_DWELL_MS);
}
await page.evaluate(
  (id) => window.__DURE_STORE__.getState().setActiveDesktop(id),
  ids[0],
);
const heavyReturnProbeTimeline = [];
for (let checkpoint = 1; checkpoint <= 5; checkpoint++) {
  await page.waitForTimeout(MODEL_PROBE_CHECKPOINT_MS);
  heavyReturnProbeTimeline.push(
    await page.evaluate((desktopId) => {
      const transitions = window.__DURE_WORKSPACE_DIAGNOSTICS__().transitions;
      const transition = [...transitions]
        .reverse()
        .find((sample) => sample.desktopId === desktopId);
      return {
        elapsedMs: transition
          ? Math.max(0, performance.now() - transition.startedAt)
          : null,
        transition,
        terminals:
          typeof window.__DURE_TERMINAL_STABILITY__ === "function"
            ? window
                .__DURE_TERMINAL_STABILITY__()
                .filter((terminal) => terminal.desktopId === desktopId)
            : [],
      };
    }, ids[0]),
  );
}

// 2) Rapid round-robin switching (mostly warm, LRU evictions make some cold).
const frames = page.evaluate((ms) => window.__DURE_FRAME_SAMPLE__(ms), ROUND_TRIPS * DESKTOPS * WARM_DWELL_MS + 2000);
let seed = 12345;
const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const HOT = [1, 4, 7]; // 자주 가는 데스크탑 3개
const pattern = process.env.PATTERN ?? "zipf";
let cur = 0;
const terminalTransitionDiagnostics = [];
for (let s = 0; s < ROUND_TRIPS * ids.length; s++) {
  let next;
  if (pattern === "zipf" && rand() < 0.7) next = HOT[Math.floor(rand() * HOT.length)];
  else next = Math.floor(rand() * ids.length);
  if (next === cur) next = (next + 3) % ids.length;
  cur = next;
  await page.evaluate((d) => window.__DURE_STORE__.getState().setActiveDesktop(d), ids[cur]);
  await page.waitForTimeout(WARM_DWELL_MS);
  if (ids[cur] === ids[0]) {
    terminalTransitionDiagnostics.push(
      await page.evaluate((desktopId) => {
        const transitions = window.__DURE_WORKSPACE_DIAGNOSTICS__().transitions;
        return {
          transition: [...transitions]
            .reverse()
            .find((sample) => sample.desktopId === desktopId),
          terminals:
            typeof window.__DURE_TERMINAL_STABILITY__ === "function"
              ? window
                  .__DURE_TERMINAL_STABILITY__()
                  .filter((terminal) => terminal.desktopId === desktopId)
              : [],
        };
      }, ids[0]),
    );
  }
}
const switchFrames = await frames;

// 3) Collect the full report + raw transitions.
const report = await page.evaluate(
  (afterTransitionSequence) =>
    window.__DURE_WORKSPACE_REPORT__(afterTransitionSequence),
  afterBuild.lastTransitionSequence,
);
const fullJourneyReport = await page.evaluate(
  () => window.__DURE_WORKSPACE_REPORT__(),
);
const diag = await page.evaluate(() => {
  const d = window.__DURE_WORKSPACE_DIAGNOSTICS__();
  return {
    totals: d.totals,
    transitions: d.transitions,
    render: d.render === null ? null : {
      bufferedBytes: d.render.bufferedBytes,
      peak: d.render.peakBufferedBytes,
    },
  };
});
const webglContextLossCount = await page.evaluate(
  () => globalThis.__DURE_WEBGL_CONTEXT_LOSS_COUNT__ ?? 0,
);
const phaseTransitions = diag.transitions.filter(
  (sample) => sample.sequence > afterBuild.lastTransitionSequence,
);
const incompleteTransitions = phaseTransitions.filter(
  (sample) =>
    (sample.expectedTerminalPanes ?? 0) > 0 &&
    (sample.expectedTerminalPanes !== sample.stableTerminalPanes ||
      sample.allTerminalStableMs === null),
);
const modelExpected =
  afterBuild.totals.terminalSurfaces > afterBuild.totals.webglContexts;
const validationFailures = [];
const journeys = {
  initialWorkspace: buildJourneyReport.journeys.initialWorkspace,
  firstVisit: buildJourneyReport.journeys.firstVisit,
  revisit: fullJourneyReport.journeys.revisit,
};
const slo = evaluateWorkspacePerformanceSlo(
  {
    journeys,
    switchPaintByCache: report.switchPaintByCache,
    firstTerminalPaintByCache: report.firstTerminalPaintByCache,
    allTerminalStableByCache: report.allTerminalStableByCache,
    paneFocus: fullJourneyReport.paneFocus,
    switchFrames,
  },
  "chromium_mock",
);
validationFailures.push(...slo.failures);
if (pageErrors.length) validationFailures.push(`${pageErrors.length} page error(s)`);
if (deprecatedXtermWriteWarnings.length) {
  validationFailures.push(
    `${deprecatedXtermWriteWarnings.length} deprecated xterm writeSync warning(s)`,
  );
}
if (xtermTaskQueueDeadlineWarnings.length) {
  validationFailures.push(
    `${xtermTaskQueueDeadlineWarnings.length} xterm task-queue deadline warning(s)`,
  );
}
if (webglContextLossCount > 0) {
  validationFailures.push(
    `${webglContextLossCount} WebGL context-loss event(s)`,
  );
} else if (webglContextWarnings.length) {
  validationFailures.push(
    `${webglContextWarnings.length} WebGL context-loss warning(s)`,
  );
}
if (ASSERT_PROFILE === "full") {
  if (!returnProbe) {
    validationFailures.push("heavy immediate-return probe did not produce a transition");
  } else if (returnProbe.cacheState === "cold") {
    validationFailures.push("heavy A→B→A immediate return regressed to cold");
  }
  if (incompleteTransitions.length) {
    validationFailures.push(
      `${incompleteTransitions.length} transition(s) did not reach all-pane stable`,
    );
  }
  if (modelExpected && report.switchPaintByCache.model.count === 0) {
    validationFailures.push("model-cache path was not exercised");
  }
}

const result = {
  config: {
    VARIANT,
    DESKTOPS,
    FILE_PANES_PER_DESKTOP,
    TERMINAL_PANES_PER_DESKTOP,
    HEAVY_TERMINAL_PANES,
    ROUND_TRIPS,
    WARM_DWELL_MS,
    COLD_DWELL_MS,
    PANE_BUILD_TIMEOUT_MS,
    PANE_SETTLE_MS,
    PANE_FOCUS_SAMPLES,
    PANE_FOCUS_DWELL_MS,
    MODEL_PROBE_EVICTION_DWELL_MS,
    MODEL_PROBE_CHECKPOINT_MS,
    ASSERT_PROFILE,
    INJECT_WEBGL_CONTEXT_LOSS,
    logicalCores:
      Number.isFinite(PERF_LOGICAL_CORES) && PERF_LOGICAL_CORES > 0
        ? PERF_LOGICAL_CORES
        : null,
    PERF_GPU,
  },
  builtWorld,
  paneBuilds,
  afterBuild,
  returnProbe,
  terminalStabilityAfterReturn,
  terminalTransitionDiagnostics,
  heavyReturnProbeTimeline,
  switchFrames,
  journeys,
  paneFocus: fullJourneyReport.paneFocus,
  switchPaint: report.switchPaint,
  switchPaintByCache: report.switchPaintByCache,
  firstInteractivePane: report.firstInteractivePane,
  firstInteractivePaneByCache: report.firstInteractivePaneByCache,
  firstTerminalPaint: report.firstTerminalPaint,
  firstTerminalPaintByCache: report.firstTerminalPaintByCache,
  terminalAttach: fullJourneyReport.terminalAttach,
  terminalInput: fullJourneyReport.terminalInput,
  allTerminalPaintByCache: report.allTerminalPaintByCache,
  firstTerminalStableByCache: report.firstTerminalStableByCache,
  allTerminalStableByCache: report.allTerminalStableByCache,
  recentTransitions: report.recentTransitions,
  remountCost: report.remountCost,
  paneOpen: report.paneOpen,
  totalsAtEnd: diag.totals,
  transitions: phaseTransitions,
  warmCount: phaseTransitions.filter((t) => t.warm).length,
  coldCount: phaseTransitions.filter((t) => !t.warm).length,
  pageErrors: [...new Set(pageErrors)].slice(0, 6),
  deprecatedXtermWriteWarnings: [
    ...new Set(deprecatedXtermWriteWarnings),
  ].slice(0, 6),
  xtermTaskQueueDeadlineWarnings: [
    ...new Set(xtermTaskQueueDeadlineWarnings),
  ].slice(0, 6),
  webglContextLossCount,
  webglContextWarnings: [...new Set(webglContextWarnings)].slice(0, 6),
  validation: {
    enabled: ASSERT_BUDGETS,
    slo,
    failures: validationFailures,
  },
};
writeFileSync(OUT, JSON.stringify(result, null, 2));
const f = (s) =>
  s ? `median=${s.median?.toFixed?.(1)} p95=${s.p95?.toFixed?.(1)} max=${s.max?.toFixed?.(1)} n=${s.count}` : "n/a";
console.log("=== desktop-switch stress ===");
console.log("world:", JSON.stringify(builtWorld));
console.log("heavy immediate return:", JSON.stringify(returnProbe));
console.log("switch frames:", `fps=${switchFrames.fps?.toFixed(0)} p95=${switchFrames.p95FrameMs?.toFixed(1)}ms worst=${switchFrames.worstFrameMs?.toFixed(1)}ms jank=${((switchFrames.jankRatio ?? 0) * 100).toFixed(1)}%`);
console.log("workspace journeys:", JSON.stringify(result.journeys));
console.log("pane focus:", JSON.stringify(result.paneFocus));
console.log("switchPaint warm:", f(result.switchPaint.warm), "| cold:", f(result.switchPaint.cold));
for (const [cacheState, stats] of Object.entries(result.switchPaintByCache ?? {})) {
  console.log(`switchPaint[${cacheState}]:`, f(stats));
}
for (const [cacheState, stats] of Object.entries(
  result.firstInteractivePaneByCache ?? {},
)) {
  console.log(`firstInteractivePane[${cacheState}]:`, f(stats));
}
console.log("firstTerminalPaint warm:", f(result.firstTerminalPaint.warm), "| cold:", f(result.firstTerminalPaint.cold));
for (const [cacheState, stats] of Object.entries(result.allTerminalStableByCache ?? {})) {
  console.log(`allTerminalStable[${cacheState}]:`, f(stats));
}
console.log("remountCost:", f(result.remountCost));
for (const [kind, stats] of Object.entries(result.paneOpen?.byKind ?? {})) {
  console.log(`paneOpen[${kind}] cold:`, f(stats.cold), "| warm:", f(stats.warm));
}
console.log("warm/cold transitions (retained window):", result.warmCount, "/", result.coldCount);
console.log("totals at end:", JSON.stringify(result.totalsAtEnd));
console.log("page errors:", result.pageErrors.length, result.pageErrors[0] ?? "");
console.log(
  "deprecated xterm writeSync warnings:",
  result.deprecatedXtermWriteWarnings.length,
);
console.log(
  "xterm task-queue deadline warnings:",
  result.xtermTaskQueueDeadlineWarnings.length,
  result.xtermTaskQueueDeadlineWarnings[0] ?? "",
);
console.log(
  "WebGL context-loss events:",
  result.webglContextLossCount,
  result.webglContextWarnings[0] ?? "",
);
console.log(
  "validation:",
  ASSERT_BUDGETS
    ? validationFailures.length
      ? validationFailures.join("; ")
      : "passed"
    : "record-only (PERF_ASSERT=0)",
);
console.log("json:", OUT);
await browser.close();
if (ASSERT_BUDGETS && validationFailures.length) process.exitCode = 1;
