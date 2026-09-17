import { describe, expect, test } from "vitest";
import { evaluateWorkspacePerformanceSlo } from "./workspace-performance-slo.mjs";

function stats(count, p95) {
  return { count, median: p95, p95, max: p95 };
}

function chromiumReport() {
  return {
    journeys: {
      initialWorkspace: { workspacePaint: stats(1, 120) },
      firstVisit: { workspacePaint: stats(8, 45) },
      revisit: { workspacePaint: stats(40, 22) },
    },
    switchPaintByCache: {
      renderer: stats(30, 18),
      model: stats(4, 42),
    },
    firstTerminalPaintByCache: { model: stats(4, 44) },
    allTerminalStableByCache: { model: stats(4, 220) },
    paneFocus: { paint: stats(20, 24) },
    switchFrames: { p95FrameMs: 18 },
  };
}

function tauriReport() {
  const report = chromiumReport();
  report.journeys = {
    initialWorkspace: {
      activationCommit: stats(1, 60),
      firstFrame: stats(1, 120),
      workspacePaint: stats(1, 120),
      firstInteractivePane: stats(1, 180),
      firstTerminalPaint: stats(1, 220),
      allTerminalStable: stats(1, 480),
    },
    firstVisit: {
      activationCommit: stats(3, 22),
      firstFrame: stats(3, 45),
      workspacePaint: stats(3, 70),
      firstInteractivePane: stats(3, 130),
      firstTerminalPaint: stats(3, 180),
      allTerminalStable: stats(3, 420),
    },
    revisit: {
      activationCommit: stats(24, 12),
      firstFrame: stats(24, 24),
      workspacePaint: stats(24, 28),
      firstInteractivePane: stats(24, 54),
      firstTerminalPaint: stats(24, 60),
      allTerminalStable: stats(24, 240),
    },
  };
  report.firstInteractivePaneByCache = { model: stats(4, 80) };
  report.firstTerminalPaintByCache = { model: stats(4, 90) };
  report.allTerminalStableByCache = { model: stats(4, 260) };
  report.paneFocus = {
    paint: stats(24, 30),
    terminalInteractive: stats(24, 70),
    incompleteTerminalCount: 0,
  };
  report.terminalInput = {
    inputToHostReceipt: stats(24, 45),
    inputReceiptToOutputReceived: stats(24, 35),
    inputToEchoPaint: stats(24, 80),
    failedCount: 0,
    timedOutCount: 0,
    inFlightCount: 0,
  };
  report.terminalAttach = {
    backendCommand: stats(4, 12),
    invokeToStable: stats(4, 380),
    incompleteCount: 0,
  };
	report.qaStatus = {
		measurements: {
			globalQuiescenceMs: 4_000,
			steadyStateQuiescenceMs: 500,
		},
	};
  return report;
}

describe("workspace performance SLO", () => {
  test("accepts a complete Chromium journey within target", () => {
    expect(
      evaluateWorkspacePerformanceSlo(chromiumReport(), "chromium_mock").failures,
    ).toEqual([]);
  });

  test("fails closed when a journey disappeared from the sample ring", () => {
    const report = chromiumReport();
    report.journeys.firstVisit.workspacePaint = stats(0, null);

    expect(
      evaluateWorkspacePerformanceSlo(report, "chromium_mock").failures,
    ).toContain("first_visit_paint captured 0/1 required sample(s)");
  });

  test("reports each latency regression against its named target", () => {
    const report = chromiumReport();
    report.switchPaintByCache.model = stats(3, 168.9);
    report.paneFocus.paint = stats(20, 80.9);

    expect(
      evaluateWorkspacePerformanceSlo(report, "chromium_mock").failures,
    ).toEqual(
      expect.arrayContaining([
        "model_switch_paint p95 168.9ms > 75ms",
        "pane_focus_paint p95 80.9ms > 50ms",
      ]),
    );
  });

  test("treats null metrics as missing instead of zero latency", () => {
    const report = chromiumReport();
    report.paneFocus.paint = stats(20, null);

    expect(
      evaluateWorkspacePerformanceSlo(report, "chromium_mock").failures,
    ).toContain("pane_focus_paint is missing p95");
  });

  test("requires real input and full-hydration evidence for Tauri", () => {
    const report = chromiumReport();
    const failures = evaluateWorkspacePerformanceSlo(report, "tauri_hmux").failures;

    expect(failures).toContain(
      "initial_first_terminal_paint captured 0/1 required sample(s)",
    );
    expect(failures).toContain(
      "first_visit_all_terminal_stable captured 0/1 required sample(s)",
    );
    expect(failures).toContain(
      "revisit_first_interactive captured 0/20 required sample(s)",
    );
    expect(failures).toContain(
      "input_host_receipt captured 0/20 required sample(s)",
    );
    expect(failures).toContain(
      "terminal_invoke_to_stable captured 0/3 required sample(s)",
    );
  });

  test("accepts a complete Tauri Hmux journey within target", () => {
    expect(
      evaluateWorkspacePerformanceSlo(tauriReport(), "tauri_hmux").failures,
    ).toEqual([]);
  });

  test("requires pressure paths without fabricating a retained renderer", () => {
    const report = tauriReport();
    report.switchPaintByCache = {
      model: stats(4, 42),
      cold: stats(1, 47),
    };
    report.terminalAttach = { incompleteCount: 0 };

    expect(
      evaluateWorkspacePerformanceSlo(report, "tauri_hmux_pressure").failures,
    ).toEqual([]);

    delete report.switchPaintByCache.model;
    expect(
      evaluateWorkspacePerformanceSlo(report, "tauri_hmux_pressure").failures,
    ).toContain("model_switch_paint captured 0/3 required sample(s)");
  });

  test("evaluates a focus-only run without requiring unrelated journey samples", () => {
    const report = tauriReport();
    report.journeys = { initialWorkspace: report.journeys.initialWorkspace };
    report.switchPaintByCache = {};
    report.qaStatus = {};

    expect(
      evaluateWorkspacePerformanceSlo(report, "tauri_hmux_focus").failures,
    ).toEqual([]);
  });

  test("uses structured Host receipt and paint evidence without legacy attach timings", () => {
    const report = tauriReport();
    report.paneFocus.paint = stats(20, 30);
    report.paneFocus.terminalInteractive = stats(20, 38);
    report.terminalInput.inputToHostReceipt = stats(20, 7);
    report.terminalInput.inputReceiptToOutputReceived = stats(20, 35);
    report.terminalInput.inputToEchoPaint = stats(20, 42);
    report.terminalAttach = { incompleteCount: 0 };

    expect(
      evaluateWorkspacePerformanceSlo(
        report,
        "tauri_hmux_structured_focus",
      ).failures,
    ).toEqual([]);
  });

  test("evaluates a single desktop without fabricating switch samples", () => {
    const report = tauriReport();
    report.journeys = { initialWorkspace: report.journeys.initialWorkspace };
    report.switchPaintByCache = {};

    expect(
      evaluateWorkspacePerformanceSlo(
        report,
        "tauri_hmux_single_desktop",
      ).failures,
    ).toEqual([]);
  });

  test("rejects a single hidden input delivery stall", () => {
    const report = tauriReport();
    report.terminalInput.inputReceiptToOutputReceived.max = 3_600;

    expect(
      evaluateWorkspacePerformanceSlo(report, "tauri_hmux").failures,
    ).toContain("input_delivery_tail max 3600.0ms > 500ms");
  });

  test("identifies whether a regression precedes the first browser frame", () => {
    const report = tauriReport();
    report.journeys.revisit.activationCommit = stats(24, 44);
    report.journeys.revisit.firstFrame = stats(24, 58);

    expect(
      evaluateWorkspacePerformanceSlo(report, "tauri_hmux").failures,
    ).toEqual(
      expect.arrayContaining([
        "revisit_activation_commit p95 44.0ms > 25ms",
        "revisit_first_frame p95 58.0ms > 35ms",
      ]),
    );
  });

  test.each([
    ["initialWorkspace", "firstInteractivePane", "initial_first_interactive"],
    ["firstVisit", "firstTerminalPaint", "first_visit_first_terminal_paint"],
    ["revisit", "allTerminalStable", "revisit_all_terminal_stable"],
  ])("fails closed when Tauri %s.%s evidence is missing", (journey, field, id) => {
    const report = tauriReport();
    report.journeys[journey][field] = stats(0, null);

    expect(
      evaluateWorkspacePerformanceSlo(report, "tauri_hmux").failures,
    ).toContain(`${id} captured 0/${journey === "revisit" ? 20 : 1} required sample(s)`);
  });

  test.each([
    ["failedCount", "terminal_input_failed", 1],
    ["timedOutCount", "terminal_input_timed_out", 2],
    ["inFlightCount", "terminal_input_in_flight", 1],
  ])("rejects terminal input %s survivor bias", (field, id, count) => {
    const report = tauriReport();
    report.terminalInput[field] = count;

    expect(
      evaluateWorkspacePerformanceSlo(report, "tauri_hmux").failures,
    ).toContain(`${id} ${count} > 0`);
  });

  test("rejects incomplete attach and focused-terminal samples", () => {
    const report = tauriReport();
    report.terminalAttach.incompleteCount = 1;
    report.paneFocus.incompleteTerminalCount = 2;

    expect(
      evaluateWorkspacePerformanceSlo(report, "tauri_hmux").failures,
    ).toEqual(
      expect.arrayContaining([
        "terminal_attach_incomplete 1 > 0",
        "pane_focus_incomplete 2 > 0",
      ]),
    );
  });

  test("treats null error counters as missing instead of zero", () => {
    const report = tauriReport();
    report.terminalInput.failedCount = null;

    expect(
      evaluateWorkspacePerformanceSlo(report, "tauri_hmux").failures,
    ).toContain("terminal_input_failed is missing");
  });
});
