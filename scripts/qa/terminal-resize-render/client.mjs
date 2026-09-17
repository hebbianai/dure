import {
  HmuxWindowFocusHarness,
  WINDOW_ROLES,
} from "../lib/hmux-window-focus-harness.mjs";
import {
  TERMINAL_RESIZE_RENDER_PROFILES,
  configuredProviderNames,
  requireResizeRenderPhase,
  resizeRenderPhase,
} from "./profiles.mjs";

const provider = process.env.DURE_QA_TERMINAL_PROVIDER;
const profile = TERMINAL_RESIZE_RENDER_PROFILES[provider];
if (!profile) {
  throw new Error(
    `DURE_QA_TERMINAL_PROVIDER must be one of ${configuredProviderNames.join(", ")}`,
  );
}

const latencyBudgetMs = boundedLatencyBudget(
  process.env.DURE_QA_TERMINAL_RESIZE_BUDGET_MS ?? "1000",
);
const harness = new HmuxWindowFocusHarness();

async function waitForPhase(
  description,
  minimumGeneration,
  fitReferenceRole,
  roles = WINDOW_ROLES,
) {
  return harness.waitForBufferState(
    "a",
    description,
    (_state, status) =>
      resizeRenderPhase(
        status,
        profile,
        minimumGeneration,
        roles,
        fitReferenceRole,
      ) !== undefined,
  );
}

async function closeLargeWindowPhase(previous) {
  const statusBefore = await harness.status();
  const preparationCountBefore =
    statusBefore.windows?.a?.largeViewReturnPreparationCount ?? 0;
  const action = await harness.close("b");
  const status = await harness.waitForBufferState(
    "a",
    "source pane exact redraw through AgentSessionWindow return",
    (_state, candidate) =>
      candidate.nativeWindows?.b?.exists === false &&
      candidate.windows?.a?.concealmentObserved === true &&
      candidate.windows?.a?.largeViewReturnPreparationCount ===
        preparationCountBefore + 1 &&
      resizeRenderPhase(candidate, profile, previous.generation, ["a"]) !==
        undefined &&
      candidate.windows?.a?.bufferState?.fitDimensionsMatch === true,
  );
  const phase = requireResizeRenderPhase(
    status,
    profile,
    previous.generation,
    "source pane redraw after large window close",
    ["a"],
    "a",
  );
  const latencyMs = Math.max(0, Date.now() - action.issuedAtMs);
  if (latencyMs > latencyBudgetMs) {
    throw new Error(
      `large window close: ${latencyMs}ms exceeded the ${latencyBudgetMs}ms resize-render budget`,
    );
  }
  const firstKey = await harness.measuredFocusedStep("a", {
    requiredRoles: ["a"],
  });
  return {
    ...phase,
    latencyMs,
    closedWindow: "b",
    concealmentObserved: true,
    largeViewReturnPreparationCount: preparationCountBefore + 1,
    firstKey: firstKey.timing,
  };
}

try {
  await harness.phase("connect", "qa_transport", () => harness.connect());
  await harness.phase("runtime_prepare", "qa_runtime_activation", () =>
    harness.prepareRuntime(),
  );
  const started = await harness.phase("start", "qa_startup", () =>
    harness.start("large_view", {
      provider,
      screenModel: profile.buffer,
    }),
  );
  let status = await harness.phase("focus_ready", "exclusive_os_focus", () =>
    harness.waitReady({ primeRoles: ["a"], readyRoles: ["a"] }),
  );

  let seed;
  if (started.resizeRenderSeed) {
    status = await harness.waitForBufferState(
      "a",
      "read-only terminal snapshot seed in both isolated WebViews",
      (_state, candidate) =>
        ["a"].every(
          (role) =>
            candidate.windows?.[role]?.bufferState
              ?.resizeRenderSeedVisible === true,
        ),
    );
    seed = {
      ...started.resizeRenderSeed,
      visibleIn: ["a"],
    };
  }

  await harness.activateResizeRender();
  await harness.prime("a");
  status = await waitForPhase("initial provider redraw", 0, "a", ["a"]);
  const initial = requireResizeRenderPhase(
    status,
    profile,
    0,
    "initial provider redraw",
    ["a"],
    "a",
  );

  // A is created at the compact product geometry. Treat that first complete
  // provider frame as the return target instead of issuing a no-op native
  // resize and waiting for a Host generation that should not exist.
  const compact = { ...initial, latencyMs: 0, size: "compact" };
  const largeViewOpenedAtMs = Date.now();
  await harness.openLargeView();
  await harness.waitReady({ primeRoles: ["b"], readyRoles: ["b"] });
  const detachedFirstKey = await harness.measuredFocusedStep("b");
  status = await waitForPhase(
    "detached AgentSessionWindow wide redraw",
    compact.generation,
    "b",
  );
  const wide = {
    ...requireResizeRenderPhase(
      status,
      profile,
      compact.generation,
      "detached AgentSessionWindow wide redraw",
      WINDOW_ROLES,
      "b",
    ),
    latencyMs: Date.now() - largeViewOpenedAtMs,
  };
  if (wide.latencyMs > latencyBudgetMs) {
    throw new Error(
      `large-view open: ${wide.latencyMs}ms exceeded the ${latencyBudgetMs}ms resize-render budget`,
    );
  }
  const sourceFirstKey = await harness.measuredFocusedStep("a");
  const retained = requireResizeRenderPhase(
    sourceFirstKey.status,
    profile,
    compact.generation,
    "detached geometry after source-pane focus",
    WINDOW_ROLES,
    "b",
  );
  if (
    sourceFirstKey.status.nativeWindows?.b?.exists !== true ||
    sourceFirstKey.status.nativeWindows?.b?.visible !== true ||
    retained.columns !== wide.columns ||
    retained.rows !== wide.rows
  ) {
    throw new Error(
      `source focus stole detached large-view geometry: ${JSON.stringify({ wide, retained, native: sourceFirstKey.status.nativeWindows?.b })}`,
    );
  }
  const restored = await closeLargeWindowPhase(wide);

  if (wide.columns <= compact.columns || wide.rows <= compact.rows) {
    throw new Error(
      `large window did not grow the canonical grid: ${JSON.stringify({ compact, wide })}`,
    );
  }
  if (
    restored.columns !== compact.columns ||
    restored.rows !== compact.rows
  ) {
    throw new Error(
      `closing the large window did not restore the source pane grid: ${JSON.stringify({ compact, restored })}`,
    );
  }
  const receipt = {
    schemaVersion: 1,
    provider,
    expectedBuffer: profile.buffer,
    seed,
    latencyBudgetMs,
    phases: {
      initial,
      compact,
      wide: { ...wide, firstKey: detachedFirstKey.timing },
      retained: { ...retained, firstKey: sourceFirstKey.timing },
      restored,
    },
  };
  harness.writeEvidence("terminal-resize-render-summary.json", receipt);
  console.log(
    `terminal resize render (${provider}): ${compact.columns}x${compact.rows} -> ${wide.columns}x${wide.rows} -> ${restored.columns}x${restored.rows}; max transition ${Math.max(compact.latencyMs, wide.latencyMs, restored.latencyMs)}ms`,
  );
} finally {
  await harness.phase("cleanup", "qa_cleanup", () => harness.finish()).catch(
    (error) => {
      console.error(`terminal resize render cleanup failed: ${error}`);
      process.exitCode = 1;
    },
  );
}

function boundedLatencyBudget(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 250 || parsed > 30_000) {
    throw new Error(
      "DURE_QA_TERMINAL_RESIZE_BUDGET_MS must be an integer from 250 to 30000",
    );
  }
  return parsed;
}
