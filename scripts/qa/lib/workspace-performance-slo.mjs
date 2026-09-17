const STATISTICS = new Set(["median", "p95", "max"]);

const TAURI_INITIAL_JOURNEY = journey(
  "initial",
  "journeys.initialWorkspace",
  1,
  {
    activationCommit: 100,
    firstFrame: 200,
    workspacePaint: 250,
    firstInteractivePane: 500,
    firstTerminalPaint: 500,
    allTerminalStable: 1_000,
  },
);

const TAURI_JOURNEYS = Object.freeze([
  TAURI_INITIAL_JOURNEY,
  journey("first_visit", "journeys.firstVisit", 1, {
    activationCommit: 50,
    firstFrame: 75,
    workspacePaint: 100,
    firstInteractivePane: 250,
    firstTerminalPaint: 500,
    allTerminalStable: 1_000,
  }),
  journey("revisit", "journeys.revisit", 20, {
    activationCommit: 25,
    firstFrame: 35,
    workspacePaint: 50,
    firstInteractivePane: 100,
    firstTerminalPaint: 100,
    allTerminalStable: 500,
  }),
]);

const TAURI_FOCUS_SEMANTIC_RULES = Object.freeze([
  metric("pane_focus_paint", "paneFocus.paint", "p95", 50, 20),
  metric("pane_focus_interactive", "paneFocus.terminalInteractive", "p95", 100, 20),
  metric("input_host_receipt", "terminalInput.inputToHostReceipt", "p95", 100, 20),
  metric("input_delivery_tail", "terminalInput.inputReceiptToOutputReceived", "max", 500, 20),
  metric("input_echo_paint", "terminalInput.inputToEchoPaint", "p95", 200, 20),
]);

const TAURI_FOCUS_SAFETY_RULES = Object.freeze([
  upperBound("terminal_input_failed", "terminalInput.failedCount", 0),
  upperBound("terminal_input_timed_out", "terminalInput.timedOutCount", 0),
  upperBound("terminal_input_in_flight", "terminalInput.inFlightCount", 0),
  upperBound("terminal_attach_incomplete", "terminalAttach.incompleteCount", 0),
  upperBound("pane_focus_incomplete", "paneFocus.incompleteTerminalCount", 0),
]);

const TAURI_STRUCTURED_FOCUS_RULES = Object.freeze([
  ...TAURI_FOCUS_SEMANTIC_RULES,
  ...TAURI_FOCUS_SAFETY_RULES,
]);

const TAURI_FOCUS_RULES = Object.freeze([
  ...TAURI_FOCUS_SEMANTIC_RULES,
  metric("hmux_backend_command", "terminalAttach.backendCommand", "p95", 50, 3),
  metric("terminal_invoke_to_stable", "terminalAttach.invokeToStable", "p95", 1_000, 3),
  ...TAURI_FOCUS_SAFETY_RULES,
]);

const TAURI_WORKSPACE_RULES = Object.freeze([
  ...TAURI_JOURNEYS.flat(),
	scalar("global_terminal_quiescence", "qaStatus.measurements.globalQuiescenceMs", 10_000),
	scalar("steady_state_terminal_quiescence", "qaStatus.measurements.steadyStateQuiescenceMs", 5_000),
]);

const TAURI_RUNTIME_RULES = Object.freeze([
  ...TAURI_WORKSPACE_RULES,
  metric("renderer_switch_paint", "switchPaintByCache.renderer", "p95", 50, 10),
  ...TAURI_FOCUS_RULES,
]);

const TAURI_SINGLE_DESKTOP_RULES = Object.freeze([
  ...TAURI_INITIAL_JOURNEY,
	scalar("global_terminal_quiescence", "qaStatus.measurements.globalQuiescenceMs", 10_000),
	scalar("steady_state_terminal_quiescence", "qaStatus.measurements.steadyStateQuiescenceMs", 5_000),
  ...TAURI_FOCUS_RULES,
]);

const TAURI_PRESSURE_RULES = Object.freeze([
  metric("model_switch_paint", "switchPaintByCache.model", "p95", 75, 3),
  metric("model_first_interactive", "firstInteractivePaneByCache.model", "p95", 150, 3),
  metric("model_first_terminal_paint", "firstTerminalPaintByCache.model", "p95", 150, 3),
  metric("model_all_terminal_stable", "allTerminalStableByCache.model", "p95", 500, 3),
  metric("cold_switch_paint", "switchPaintByCache.cold", "p95", 500, 1),
]);

/**
 * Product-facing latency goals. Chromium isolates React/Dockview/xterm
 * algorithmic regressions; tauri_hmux adds the real WKWebView, native focus,
 * IPC, and Hmux receipt path. A faster surrogate may never waive a slower
 * product result.
 */
export const WORKSPACE_PERFORMANCE_SLO = Object.freeze({
  chromium_mock: Object.freeze([
    metric("initial_workspace_paint", "journeys.initialWorkspace.workspacePaint", "p95", 250, 1),
    metric("first_visit_paint", "journeys.firstVisit.workspacePaint", "p95", 100, 1),
    metric("revisit_paint", "journeys.revisit.workspacePaint", "p95", 50, 20),
    metric("renderer_switch_paint", "switchPaintByCache.renderer", "p95", 50, 10),
    metric("model_switch_paint", "switchPaintByCache.model", "p95", 75, 1),
    metric("model_first_terminal_paint", "firstTerminalPaintByCache.model", "p95", 50, 1),
    metric("model_all_terminal_stable", "allTerminalStableByCache.model", "p95", 300, 1),
    metric("pane_focus_paint", "paneFocus.paint", "p95", 50, 5),
    scalar("switch_frame_p95", "switchFrames.p95FrameMs", 25),
  ]),
  tauri_hmux_focus: TAURI_FOCUS_RULES,
  tauri_hmux_structured_focus: TAURI_STRUCTURED_FOCUS_RULES,
  tauri_hmux_single_desktop: TAURI_SINGLE_DESKTOP_RULES,
  tauri_hmux: TAURI_RUNTIME_RULES,
  tauri_hmux_pressure: Object.freeze([
    ...TAURI_WORKSPACE_RULES,
    ...TAURI_STRUCTURED_FOCUS_RULES,
    ...TAURI_PRESSURE_RULES,
  ]),
});

function journey(id, path, minSamples, maxMs) {
  return Object.freeze([
    metric(`${id}_activation_commit`, `${path}.activationCommit`, "p95", maxMs.activationCommit, minSamples),
    metric(`${id}_first_frame`, `${path}.firstFrame`, "p95", maxMs.firstFrame, minSamples),
    metric(`${id}_workspace_paint`, `${path}.workspacePaint`, "p95", maxMs.workspacePaint, minSamples),
    metric(`${id}_first_interactive`, `${path}.firstInteractivePane`, "p95", maxMs.firstInteractivePane, minSamples),
    metric(`${id}_first_terminal_paint`, `${path}.firstTerminalPaint`, "p95", maxMs.firstTerminalPaint, minSamples),
    metric(`${id}_all_terminal_stable`, `${path}.allTerminalStable`, "p95", maxMs.allTerminalStable, minSamples),
  ]);
}

function metric(id, path, statistic, maxMs, minSamples) {
  if (!STATISTICS.has(statistic)) throw new Error(`unsupported statistic: ${statistic}`);
  return Object.freeze({ id, kind: "metric", path, statistic, maxMs, minSamples });
}

function scalar(id, path, maxMs) {
  return Object.freeze({ id, kind: "scalar", path, maxMs });
}

function upperBound(id, path, maxValue) {
  return Object.freeze({ id, kind: "upper_bound", path, maxValue });
}

function readPath(value, path) {
  return path.split(".").reduce((current, key) => current?.[key], value);
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Fail closed on missing samples. This is intentionally stricter than a
 * threshold-only check: the old stress harness could report green while the
 * first-visit, all-stable, or input journey had silently disappeared.
 */
export function evaluateWorkspacePerformanceSlo(report, profile) {
  const rules = WORKSPACE_PERFORMANCE_SLO[profile];
  if (!rules) throw new Error(`unknown workspace performance SLO profile: ${profile}`);

  const observations = [];
  const failures = [];
  for (const rule of rules) {
    const value = readPath(report, rule.path);
    if (rule.kind === "metric") {
      const count = finiteNumber(value?.count) ?? 0;
      const latency = finiteNumber(value?.[rule.statistic]);
      observations.push({
        id: rule.id,
        count,
        statistic: rule.statistic,
        valueMs: latency,
        maxMs: rule.maxMs,
      });
      if (count < rule.minSamples) {
        failures.push(
          `${rule.id} captured ${count}/${rule.minSamples} required sample(s)`,
        );
        continue;
      }
      if (latency === null) {
        failures.push(`${rule.id} is missing ${rule.statistic}`);
      } else if (latency > rule.maxMs) {
        failures.push(
          `${rule.id} ${rule.statistic} ${latency.toFixed(1)}ms > ${rule.maxMs}ms`,
        );
      }
      continue;
    }

    const latency = finiteNumber(value);
    if (rule.kind === "upper_bound") {
      observations.push({
        id: rule.id,
        count: 1,
        statistic: "value",
        value: latency,
        maxValue: rule.maxValue,
      });
      if (latency === null) failures.push(`${rule.id} is missing`);
      else if (latency > rule.maxValue) {
        failures.push(`${rule.id} ${latency} > ${rule.maxValue}`);
      }
      continue;
    }

    observations.push({
      id: rule.id,
      count: 1,
      statistic: "value",
      valueMs: latency,
      maxMs: rule.maxMs,
    });
    if (latency === null) failures.push(`${rule.id} is missing`);
    else if (latency > rule.maxMs) {
      failures.push(`${rule.id} ${latency.toFixed(1)}ms > ${rule.maxMs}ms`);
    }
  }
  return { profile, observations, failures };
}
