import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scenarioDefinitions = JSON.parse(
  fs.readFileSync(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../src/qa/workspacePerformance/scenarios.json",
    ),
    "utf8",
  ),
);

export function nativeWorkspacePerformanceScenario(id = "baseline_15") {
  const scenario = scenarioDefinitions[id];
  if (!scenario) throw new Error(`unknown workspace performance scenario: ${id}`);
  return {
    id,
    ...scenario,
    terminalCount: scenario.desktopCount * scenario.panesPerDesktop,
  };
}

export function nativeWorkspacePerformanceReadiness(
  report,
  scenarioId = "baseline_15",
  phase = "full",
) {
  const scenario = nativeWorkspacePerformanceScenario(scenarioId);
  assertWorkspacePerformancePhase(phase);
  const journeyStages = [
    ["activation commit", "activationCommit"],
    ["commit microtask", "commitMicrotask"],
    ["commit message task", "commitMessageTask"],
    ["first frame", "firstFrame"],
    ["workspace paint", "workspacePaint"],
    ["first interactive pane", "firstInteractivePane"],
    ["first terminal paint", "firstTerminalPaint"],
    ["all-terminal stable", "allTerminalStable"],
  ];
  const journeyVisits = [
    ["initial", "initialWorkspace", 1],
    ["first-visit", "firstVisit", scenario.desktopCount - 1],
    ["revisit", "revisit", scenario.revisitSamples],
  ];
  const focusSamples = [
    [
      "pane focus interactive",
      "paneFocus.terminalInteractive",
      scenario.focusInputSamples,
    ],
    [
      "terminal input receipt",
      "terminalInput.inputToHostReceipt",
      scenario.focusInputSamples,
    ],
    [
      "terminal input echo paint",
      "terminalInput.inputToEchoPaint",
      scenario.focusInputSamples,
    ],
  ];
  const requiredSamples = phase === "focus" ? [
    ...journeyStages.map(([stageLabel, stagePath]) => [
      `initial ${stageLabel}`,
      `journeys.initialWorkspace.${stagePath}`,
      1,
    ]),
    ...focusSamples,
  ] : [
    ...journeyVisits.flatMap(([visitLabel, visitPath, count]) =>
      journeyStages.map(([stageLabel, stagePath]) => [
        `${visitLabel} ${stageLabel}`,
        `journeys.${visitPath}.${stagePath}`,
        count,
      ]),
    ),
    ...focusSamples,
    ...Object.entries(scenario.cacheSamples).map(([cacheState, count]) => [
      `${cacheState}-cache switch`,
      `switchPaintByCache.${cacheState}`,
      count,
    ]),
  ];
  const missing = [];
  const qaState = report?.qaStatus?.state;
  if (qaState !== "complete") {
    missing.push(`QA workload ${qaState ?? "missing"}/complete`);
  }
  for (const [label, path, expected] of requiredSamples) {
    const count = readPath(report, path)?.count;
    const observed = Number.isFinite(count) ? count : 0;
    if (observed < expected) {
      missing.push(`${label} ${Number.isFinite(count) ? count : 0}/${expected}`);
    }
  }
  const structuredSemanticCoverage =
    nativeWorkspacePerformanceStructuredSemanticCoverage(report);
  const structuredSemanticCoverageTarget =
    nativeWorkspacePerformanceSemanticCoverageTarget(scenario);
  if (structuredSemanticCoverage < structuredSemanticCoverageTarget) {
    missing.push(
      `TerminalSurface semantic coverage ${structuredSemanticCoverage}/${structuredSemanticCoverageTarget}`,
    );
  }
	if (phase === "full") {
		const globalQuiescenceMs = report?.qaStatus?.measurements?.globalQuiescenceMs;
		if (!Number.isFinite(globalQuiescenceMs)) {
			missing.push("global terminal quiescence 0/1");
		}
		const steadyStateQuiescenceMs =
			report?.qaStatus?.measurements?.steadyStateQuiescenceMs;
		if (!Number.isFinite(steadyStateQuiescenceMs)) {
			missing.push("steady-state terminal quiescence 0/1");
		}
		const providerInputReadyMs =
			report?.qaStatus?.measurements?.providerInputReadyMs;
		if (!Number.isFinite(providerInputReadyMs)) {
			missing.push("provider input readiness 0/1");
		}
	}
  return { ready: missing.length === 0, missing };
}

export function nativeWorkspacePerformanceSloProfile(
  scenarioId = "baseline_15",
  phase = "full",
  report,
) {
  const scenario = nativeWorkspacePerformanceScenario(scenarioId);
  assertWorkspacePerformancePhase(phase);
  if (phase === "focus") {
    return nativeWorkspacePerformanceStructuredSemanticCoverage(report) >=
      nativeWorkspacePerformanceSemanticCoverageTarget(scenario)
      ? "tauri_hmux_structured_focus"
      : "tauri_hmux_focus";
  }
  const hasSwitchJourney =
    scenario.desktopCount > 1 ||
    scenario.revisitSamples > 0 ||
    Object.values(scenario.cacheSamples).some((samples) => samples > 0);
  if (!hasSwitchJourney) return "tauri_hmux_single_desktop";
  return scenarioId === "baseline_15" ? "tauri_hmux" : "tauri_hmux_pressure";
}

export function nativeWorkspacePerformanceStructuredSemanticCoverage(report) {
  const observations = report?.qaStatus?.structuredTerminalObservations;
  const focused = stringSet(observations?.focusedTerminalIds);
  const hostReceipts = stringSet(observations?.hostReceiptTerminalIds);
  const projections = stringSet(observations?.projectedTerminalIds);
  let observed = 0;
  for (const terminalId of focused) {
    if (hostReceipts.has(terminalId) && projections.has(terminalId)) observed += 1;
  }
  return observed;
}

export function nativeWorkspacePerformanceResourceFailures(
  report,
  scenarioId = "baseline_15",
) {
  const scenario = nativeWorkspacePerformanceScenario(scenarioId);
  const failures = [];
  const surfaces = report?.totals?.terminalSurfaces;
  // The product keeps presentation only for the active Workspace. Cumulative
  // TerminalSurface receipts above prove every visited pane independently of
  // this exact resident-topology check.
  const min = scenario.panesPerDesktop;
  const max = scenario.panesPerDesktop;
  if (!Number.isFinite(surfaces) || surfaces < min || surfaces > max) {
    failures.push(
      `terminal surfaces ${surfaces ?? "missing"} outside ${min}-${max}`,
    );
  }
  const runtimeErrorCount = report?.qaStatus?.runtimeErrors?.total;
  if (!Number.isFinite(runtimeErrorCount)) {
    failures.push("runtime error ledger is missing");
  } else if (runtimeErrorCount > 0) {
    failures.push(`uncaught runtime errors ${runtimeErrorCount}`);
  }
  if (scenarioId === "scale_30" || scenarioId === "scale_50") {
    if (!completeWorkspaceCacheDiagnostics(report?.workspaceCache)) {
      failures.push("workspace cache diagnostics are missing");
    }
    if (!completeExecutionContext(report?.executionContext)) {
      failures.push("workspace execution context is missing");
    }
  }
  return failures;
}

function completeWorkspaceCacheDiagnostics(value) {
  const occupancies = [
    value?.occupancy?.total,
    value?.occupancy?.warm,
    value?.occupancy?.frozen,
  ];
  return (
    typeof value?.budget?.reason === "string" &&
    [
      value.budget.maxWorkspaces,
      value.budget.maxTerminalSurfaces,
      value.budget.retainedWorkspaces,
      value.budget.retainedTerminalModelBytes,
      value.backgroundPresentation?.terminalSurfaces,
      ...occupancies.flatMap((occupancy) => [
        occupancy?.workspaces,
        occupancy?.projectedTerminalSurfaces,
        occupancy?.projectedTerminalModelBytes,
      ]),
    ].every(Number.isFinite) &&
    // Retired pressure measurements are explicit null, not missing resources.
    [
      value.backgroundPresentation?.recentWriterSurfaces,
      value.backgroundPresentation?.bufferedBytes,
      value.backgroundPresentation?.maxRecentWriteLatencyMs,
    ].every((measurement) => measurement === null || Number.isFinite(measurement))
  );
}

function completeExecutionContext(value) {
  return [
    value?.sampledAtMs,
    value?.logicalCpuCount,
    value?.loadAverage?.oneMinute,
    value?.loadAverage?.fiveMinutes,
    value?.loadAverage?.fifteenMinutes,
    value?.processTree?.processCount,
    value?.processTree?.cpuPercent,
    value?.processTree?.rssMiB,
  ].every(Number.isFinite);
}

function nativeWorkspacePerformanceSemanticCoverageTarget(scenario) {
  return Math.min(scenario.focusInputSamples, scenario.terminalCount);
}

function assertWorkspacePerformancePhase(phase) {
  if (phase !== "full" && phase !== "focus") {
    throw new Error(`unknown native workspace performance phase: ${phase}`);
  }
}

function readPath(value, path) {
  return path.split(".").reduce((current, key) => current?.[key], value);
}

function stringSet(value) {
  return new Set(
    Array.isArray(value)
      ? value.filter((entry) => typeof entry === "string" && entry.length > 0)
      : [],
  );
}
