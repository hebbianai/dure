import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { WorkspacePerformanceTracker } from "@/lib/workspace/performance/workspacePerformance";
import { summarizeWorkspacePerformance } from "@/lib/workspace/performance/workspacePerformanceReport";
import {
  nativeWorkspacePerformanceReadiness,
  nativeWorkspacePerformanceResourceFailures,
  nativeWorkspacePerformanceScenario,
  nativeWorkspacePerformanceSloProfile,
} from "./workspace-performance-native.mjs";

const stats = (count) => ({ count });
const journey = (count) => ({
  activationCommit: stats(count),
  commitMicrotask: stats(count),
  commitMessageTask: stats(count),
  firstFrame: stats(count),
  workspacePaint: stats(count),
  firstInteractivePane: stats(count),
  firstTerminalPaint: stats(count),
  allTerminalStable: stats(count),
});
const smoke = fs.readFileSync(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../workspace-performance-smoke.sh",
  ),
  "utf8",
);

function report() {
  return {
    journeys: {
      initialWorkspace: journey(1),
      firstVisit: journey(4),
      revisit: journey(24),
    },
    paneFocus: { terminalInteractive: stats(24) },
    terminalInput: {
      inputToHostReceipt: stats(24),
      inputToEchoPaint: stats(24),
    },
    switchPaintByCache: { renderer: stats(24) },
    terminalAttach: { backendCommand: stats(15) },
		workspaceCache: {
			budget: {
				maxWorkspaces: 6,
				maxTerminalSurfaces: 14,
				retainedWorkspaces: 12,
				retainedTerminalModelBytes: 2_147_483_648,
				reason: "high-resource",
			},
			occupancy: Object.fromEntries(
				["total", "warm", "frozen"].map((tier) => [
					tier,
					{
						workspaces: 1,
						projectedTerminalSurfaces: 3,
						projectedTerminalModelBytes: 24,
					},
				]),
			),
			backgroundPresentation: {
				terminalSurfaces: 0,
				recentWriterSurfaces: 0,
				bufferedBytes: 0,
				maxRecentWriteLatencyMs: 0,
			},
		},
		executionContext: {
			sampledAtMs: 1,
			logicalCpuCount: 12,
			loadAverage: { oneMinute: 3, fiveMinutes: 2, fifteenMinutes: 1 },
			processTree: { processCount: 7, cpuPercent: 63, rssMiB: 512 },
		},
		qaStatus: {
			state: "complete",
			runtimeErrors: { total: 0, dropped: 0, errors: [] },
			structuredTerminalObservations: structuredSemanticCoverage(15),
			measurements: {
				globalQuiescenceMs: 4_000,
				providerInputReadyMs: 750,
				steadyStateQuiescenceMs: 500,
			},
		},
		totals: { terminalSurfaces: 3 },
  };
}

function structuredSemanticCoverage(count = 16) {
  const terminalIds = Array.from(
    { length: count },
    (_, index) => `term:structured-${index + 1}`,
  );
  return {
    focusedTerminalIds: terminalIds,
    hostReceiptTerminalIds: terminalIds,
    projectedTerminalIds: terminalIds,
  };
}

describe("native workspace performance readiness", () => {
  test("requires the exclusive lane for controller and input measurements", () => {
    expect(smoke).toContain(
      'DURE_QA_LAYER="exclusive_focus_workspace_performance"',
    );
    expect(smoke).not.toContain("ALLOW_FOCUS_STEAL");
    expect(smoke).toContain(
      '\\"visible\\":true,\\"focus\\":true,\\"focusable\\":true',
    );
    expect(smoke).toContain('\\"x\\":-4000,\\"y\\":-4000');
  });

  test("accepts the complete 15-pane workload", () => {
		expect(nativeWorkspacePerformanceScenario("scale_50").terminalCount).toBe(50);
    expect(nativeWorkspacePerformanceReadiness(report())).toEqual({
      ready: true,
      missing: [],
    });
    expect(nativeWorkspacePerformanceResourceFailures(report())).toEqual([]);
  });

  test("accepts a single-desktop full run without fabricated switch journeys", () => {
    const singleDesktop = report();
    singleDesktop.journeys.firstVisit = journey(0);
    singleDesktop.journeys.revisit = journey(0);
    singleDesktop.switchPaintByCache = {};
    singleDesktop.totals.terminalSurfaces = 15;

    expect(
      nativeWorkspacePerformanceReadiness(
        singleDesktop,
        "single_desktop_15",
        "full",
      ),
    ).toEqual({ ready: true, missing: [] });
  });

  test("names incomplete phases instead of evaluating a partial report", () => {
    const partial = report();
    partial.journeys.revisit.allTerminalStable = stats(7);
    partial.terminalInput.inputToEchoPaint = stats(0);

    expect(nativeWorkspacePerformanceReadiness(partial)).toEqual({
      ready: false,
      missing: [
        "revisit all-terminal stable 7/24",
        "terminal input echo paint 0/24",
      ],
    });
  });

  test("lets the focus diagnostic finish without unrelated journey samples", () => {
    const focusOnly = report();
    focusOnly.journeys.firstVisit = journey(0);
    focusOnly.journeys.revisit = journey(0);
    focusOnly.switchPaintByCache = {};
    focusOnly.qaStatus = {
      state: "complete",
      runtimeErrors: { total: 0, dropped: 0, errors: [] },
      structuredTerminalObservations: structuredSemanticCoverage(15),
      measurements: {},
    };

    expect(
      nativeWorkspacePerformanceReadiness(focusOnly, "baseline_15", "focus"),
    ).toEqual({ ready: true, missing: [] });
    expect(() =>
      nativeWorkspacePerformanceReadiness(focusOnly, "baseline_15", "unknown"),
    ).toThrow("unknown native workspace performance phase: unknown");
  });

  test("accepts cumulative structured receipts after hidden surfaces retire", () => {
    const structured = report();
    structured.paneFocus.terminalInteractive = stats(20);
    structured.terminalInput.inputToHostReceipt = stats(20);
    structured.terminalInput.inputToEchoPaint = stats(20);
    structured.terminalAttach.backendCommand = stats(0);
    structured.totals = { terminalSurfaces: 4, hmuxObservers: 4 };
    structured.qaStatus.structuredTerminalObservations =
      structuredSemanticCoverage();

    expect(
      nativeWorkspacePerformanceReadiness(structured, "baseline_16", "focus"),
    ).toEqual({ ready: true, missing: [] });
    expect(
      nativeWorkspacePerformanceSloProfile(
        "baseline_16",
        "focus",
        structured,
      ),
    ).toBe("tauri_hmux_structured_focus");
    expect(
      nativeWorkspacePerformanceResourceFailures(structured, "baseline_16"),
    ).toEqual([]);
    expect(
      nativeWorkspacePerformanceReadiness(structured, "baseline_16", "full")
    ).toEqual({ ready: true, missing: [] });
  });

  test("requires every pane's structured semantic coverage even when backend attaches are complete", () => {
    const partial = report();
    partial.paneFocus.terminalInteractive = stats(20);
    partial.terminalInput.inputToHostReceipt = stats(20);
    partial.terminalInput.inputToEchoPaint = stats(20);
    partial.terminalAttach.backendCommand = stats(16);
    partial.totals = { terminalSurfaces: 4, hmuxObservers: 4 };
    partial.qaStatus.structuredTerminalObservations =
      structuredSemanticCoverage(15);

    expect(
      nativeWorkspacePerformanceReadiness(partial, "baseline_16", "focus"),
    ).toEqual({
      ready: false,
      missing: ["TerminalSurface semantic coverage 15/16"],
    });
  });

  test("accepts the declared scale-50 focus sample budget after lease telemetry retirement", () => {
    const pressure = report();
    pressure.paneFocus.terminalInteractive = stats(40);
    pressure.terminalInput.inputToHostReceipt = stats(40);
    pressure.terminalInput.inputToEchoPaint = stats(40);
    pressure.terminalAttach.backendCommand = stats(0);
    pressure.totals = { terminalSurfaces: 5, hmuxObservers: 5 };
    pressure.qaStatus.structuredTerminalObservations =
      structuredSemanticCoverage(39);

    expect(
      nativeWorkspacePerformanceReadiness(pressure, "scale_50", "focus"),
    ).toEqual({
      ready: false,
      missing: ["TerminalSurface semantic coverage 39/40"],
    });
    expect(
      nativeWorkspacePerformanceSloProfile("scale_50", "focus", pressure),
    ).toBe("tauri_hmux_focus");

    pressure.qaStatus.structuredTerminalObservations =
      structuredSemanticCoverage(40);

    expect(
      nativeWorkspacePerformanceReadiness(pressure, "scale_50", "focus"),
    ).toEqual({ ready: true, missing: [] });
    expect(
      nativeWorkspacePerformanceSloProfile("scale_50", "focus", pressure),
    ).toBe("tauri_hmux_structured_focus");
    expect(
      nativeWorkspacePerformanceResourceFailures(pressure, "scale_50"),
    ).toEqual([]);
  });

  test("selects a phase-specific SLO without weakening full pressure runs", () => {
    expect(nativeWorkspacePerformanceSloProfile("baseline_15", "focus")).toBe(
      "tauri_hmux_focus",
    );
    expect(nativeWorkspacePerformanceSloProfile("baseline_15", "full")).toBe(
      "tauri_hmux",
    );
    expect(
      nativeWorkspacePerformanceSloProfile("single_desktop_15", "full"),
    ).toBe("tauri_hmux_single_desktop");
    expect(nativeWorkspacePerformanceSloProfile("scale_50", "full")).toBe(
      "tauri_hmux_pressure",
    );
    expect(() =>
      nativeWorkspacePerformanceSloProfile("baseline_15", "unknown"),
    ).toThrow("unknown native workspace performance phase: unknown");
  });

  test("rejects a resident surface set that differs from the active workspace", () => {
    const invalid = report();
    invalid.totals.terminalSurfaces = 2;

    expect(nativeWorkspacePerformanceResourceFailures(invalid)).toEqual([
      "terminal surfaces 2 outside 3-3",
    ]);
  });

  test("uses the active-workspace resident topology", () => {
    const focus = report();
    focus.totals.terminalSurfaces = 3;

    expect(nativeWorkspacePerformanceResourceFailures(focus, "baseline_15")).toEqual([]);

    focus.totals.terminalSurfaces = 2;
    expect(nativeWorkspacePerformanceResourceFailures(focus, "baseline_15")).toEqual([
      "terminal surfaces 2 outside 3-3",
    ]);

    focus.totals.terminalSurfaces = 4;
    focus.qaStatus.runtimeErrors.total = 1;
    expect(
      nativeWorkspacePerformanceResourceFailures(focus, "baseline_15"),
    ).toEqual([
      "terminal surfaces 4 outside 3-3",
      "uncaught runtime errors 1",
    ]);
  });

  test("waits for workload completion and rejects uncaught WebKit errors", () => {
    const running = report();
    running.qaStatus.state = "running";
    expect(nativeWorkspacePerformanceReadiness(running).missing).toContain(
      "QA workload running/complete",
    );

    const errored = report();
    errored.qaStatus.runtimeErrors.total = 1;
    expect(nativeWorkspacePerformanceResourceFailures(errored)).toContain(
      "uncaught runtime errors 1",
    );
  });

  test("uses the same declarative requirements for pressure scenarios", () => {
    const pressure = report();
    pressure.journeys.firstVisit = journey(9);
    pressure.journeys.revisit = journey(40);
    pressure.paneFocus.terminalInteractive = stats(40);
    pressure.terminalInput.inputToHostReceipt = stats(40);
    pressure.terminalInput.inputToEchoPaint = stats(40);
    pressure.terminalAttach.backendCommand = stats(0);
    pressure.switchPaintByCache = {
      model: stats(3),
      cold: stats(1),
    };
    pressure.totals.terminalSurfaces = 5;
    pressure.qaStatus.structuredTerminalObservations =
      structuredSemanticCoverage(39);

    expect(
      nativeWorkspacePerformanceReadiness(pressure, "scale_50").missing,
    ).toContain("TerminalSurface semantic coverage 39/40");

    pressure.qaStatus.structuredTerminalObservations =
      structuredSemanticCoverage(40);

    expect(
      nativeWorkspacePerformanceReadiness(pressure, "scale_50"),
    ).toEqual({ ready: true, missing: [] });
    expect(
      nativeWorkspacePerformanceResourceFailures(pressure, "scale_50"),
    ).toEqual([]);

    delete pressure.workspaceCache;
    expect(
      nativeWorkspacePerformanceResourceFailures(pressure, "scale_50"),
    ).toContain("workspace cache diagnostics are missing");
  });

  test.each(["scale_30", "scale_50"])(
    "accepts the current producer's unavailable pressure for %s without changing the evidence",
    (scenarioId) => {
      const tracker = new WorkspacePerformanceTracker(() => 0);
      const fixture = report();
      tracker.recordWorkspaceCacheDecision(fixture.workspaceCache);
      const scenario = nativeWorkspacePerformanceScenario(scenarioId);
      for (let index = 0; index < scenario.panesPerDesktop; index += 1) {
        tracker.registerTerminal({
          id: `terminal-${index}`,
          desktopId: "workspace",
          runtime: "hmux",
          renderer: "dom",
        });
      }
      const evidence = JSON.parse(JSON.stringify({
        ...summarizeWorkspacePerformance(tracker.snapshot()),
        executionContext: fixture.executionContext,
        qaStatus: fixture.qaStatus,
      }));
      const before = structuredClone(evidence);

      expect(nativeWorkspacePerformanceResourceFailures(evidence, scenarioId))
        .toEqual([]);
      expect(evidence).toEqual(before);
      expect(evidence.render).toBeNull();
      expect(evidence.workspaceCache.backgroundPresentation).toEqual({
        terminalSurfaces: scenario.panesPerDesktop,
        recentWriterSurfaces: null,
        bufferedBytes: null,
        maxRecentWriteLatencyMs: null,
      });
    },
  );

  test.each([0, 32])("preserves measured pressure %s", (measurement) => {
    const evidence = report();
    evidence.totals.terminalSurfaces = 5;
    const presentation = evidence.workspaceCache.backgroundPresentation;
    presentation.terminalSurfaces = 1;
    presentation.recentWriterSurfaces = measurement === 0 ? 0 : 1;
    presentation.bufferedBytes = measurement;
    presentation.maxRecentWriteLatencyMs = measurement;

    expect(nativeWorkspacePerformanceResourceFailures(evidence, "scale_50"))
      .toEqual([]);
    expect(presentation.bufferedBytes).toBe(measurement);
  });

  test.each([
    "recentWriterSurfaces", "bufferedBytes", "maxRecentWriteLatencyMs",
  ])("rejects absent or malformed pressure field %s", (field) => {
    for (const invalid of [undefined, "0", false, {}, Number.NaN, Infinity]) {
      const evidence = report();
      evidence.totals.terminalSurfaces = 5;
      evidence.workspaceCache.backgroundPresentation[field] = invalid;

      expect(nativeWorkspacePerformanceResourceFailures(evidence, "scale_50"))
        .toContain("workspace cache diagnostics are missing");
    }
  });

  test("requires measured resources and execution context when pressure is unavailable", () => {
    const evidence = report();
    evidence.totals.terminalSurfaces = 5;
    evidence.workspaceCache.backgroundPresentation = {
      terminalSurfaces: 0,
      recentWriterSurfaces: null,
      bufferedBytes: null,
      maxRecentWriteLatencyMs: null,
    };
    for (const [target, field] of [
      [evidence.workspaceCache.budget, "maxWorkspaces"],
      [evidence.workspaceCache.occupancy.warm, "projectedTerminalModelBytes"],
      [evidence.workspaceCache.backgroundPresentation, "terminalSurfaces"],
    ]) {
      const measured = target[field];
      target[field] = null;
      expect(nativeWorkspacePerformanceResourceFailures(evidence, "scale_50"))
        .toContain("workspace cache diagnostics are missing");
      target[field] = measured;
    }
    evidence.executionContext.processTree.rssMiB = null;
    evidence.qaStatus.runtimeErrors.total = 1;
    expect(nativeWorkspacePerformanceResourceFailures(evidence, "scale_50"))
      .toEqual([
        "uncaught runtime errors 1",
        "workspace execution context is missing",
      ]);
  });
});
