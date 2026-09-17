import { describe, expect, test } from "vitest";
import {
  formatWorkspacePerformanceSlo,
  parseWorkspacePerformanceSloArgs,
  workspacePerformanceSloUsage,
} from "./workspace-performance-slo.mjs";

describe("workspace performance SLO CLI", () => {
  test("defaults to the real Tauri Hmux profile and stdin", () => {
    expect(parseWorkspacePerformanceSloArgs([])).toEqual({
      profile: "tauri_hmux",
      report: "-",
      json: false,
    });
  });

  test("parses an explicit report and machine-readable output", () => {
    expect(
      parseWorkspacePerformanceSloArgs([
        "--profile",
        "chromium_mock",
        "--report",
        "/tmp/report.json",
        "--json",
      ]),
    ).toEqual({
      profile: "chromium_mock",
      report: "/tmp/report.json",
      json: true,
    });
  });

  test("accepts the single-desktop native profile", () => {
    expect(
      parseWorkspacePerformanceSloArgs([
        "--profile",
        "tauri_hmux_single_desktop",
      ]),
    ).toMatchObject({ profile: "tauri_hmux_single_desktop" });
  });

  test("accepts the structured semantic focus profile", () => {
    expect(
      parseWorkspacePerformanceSloArgs([
        "--profile",
        "tauri_hmux_structured_focus",
      ]),
    ).toMatchObject({ profile: "tauri_hmux_structured_focus" });
  });

  test("rejects unknown profiles and flags", () => {
    expect(() =>
      parseWorkspacePerformanceSloArgs(["--profile", "browser"]),
    ).toThrow("unknown profile: browser");
    expect(() => parseWorkspacePerformanceSloArgs(["--fast"])).toThrow(
      "unknown argument: --fast",
    );
  });

  test("formats a concise pass or actionable failure", () => {
    expect(
      formatWorkspacePerformanceSlo({
        profile: "tauri_hmux",
        observations: [{ id: "focus" }],
        failures: [],
      }),
    ).toBe("workspace performance SLO: PASS (tauri_hmux, 1 checks)");
    expect(
      formatWorkspacePerformanceSlo({
        profile: "tauri_hmux",
        observations: [],
        failures: ["pane_focus_paint is missing p95"],
      }),
    ).toContain("- pane_focus_paint is missing p95");
  });

  test("documents a pipe from the running app report", () => {
    expect(workspacePerformanceSloUsage()).toContain(
      "dure perf report --json | pnpm perf:workspace:slo",
    );
  });
});
