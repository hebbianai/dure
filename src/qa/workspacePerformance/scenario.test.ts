import { describe, expect, test } from "vitest";
import {
	DEFAULT_WORKSPACE_PERFORMANCE_SCENARIO,
	workspacePerformanceQaPhaseFromLocation,
	workspacePerformanceScenario,
	workspacePerformanceScenarioFromLocation,
} from "./scenario";

describe("workspace performance scenarios", () => {
	test("defines cross-workspace and single-workspace terminal topologies", () => {
		expect(workspacePerformanceScenario("baseline_15")).toMatchObject({
			terminalCount: 15,
			desktopCount: 5,
			panesPerDesktop: 3,
		});
		expect(workspacePerformanceScenario("single_desktop_15")).toMatchObject({
			terminalCount: 15,
			desktopCount: 1,
			panesPerDesktop: 15,
			revisitSamples: 0,
			cacheSamples: { renderer: 0 },
			focusInputSamples: 24,
		});
		expect(workspacePerformanceScenario("baseline_16")).toMatchObject({
			terminalCount: 16,
			desktopCount: 4,
			panesPerDesktop: 4,
			focusInputSamples: 20,
		});
		expect(workspacePerformanceScenario("sash_2")).toMatchObject({
			terminalCount: 2,
			desktopCount: 1,
			panesPerDesktop: 2,
		});
		expect(workspacePerformanceScenario("scale_30")).toMatchObject({
			terminalCount: 30,
			cacheSamples: { model: 3, cold: 1 },
		});
		expect(workspacePerformanceScenario("scale_50")).toMatchObject({
			terminalCount: 50,
			cacheSamples: { model: 3, cold: 1 },
		});
	});

	test("defaults explicitly and rejects an unknown scenario", () => {
		expect(workspacePerformanceScenario(null).id).toBe(
			DEFAULT_WORKSPACE_PERFORMANCE_SCENARIO,
		);
		expect(
			workspacePerformanceScenarioFromLocation({
				search: "?scenario=scale_30",
			}),
		).toMatchObject({ id: "scale_30", terminalCount: 30 });
		expect(() => workspacePerformanceScenario("fast")).toThrow(
			"unknown workspace performance scenario: fast",
		);
	});

	test("selects a bounded focus diagnostic independently of topology", () => {
		expect(
			workspacePerformanceQaPhaseFromLocation({
				search: "?scenario=scale_30&phase=focus",
			}),
		).toBe("focus");
		expect(
			workspacePerformanceQaPhaseFromLocation({ search: "?phase=sash" }),
		).toBe("sash");
		expect(workspacePerformanceQaPhaseFromLocation({ search: "" })).toBe(
			"full",
		);
		expect(
			workspacePerformanceQaPhaseFromLocation({ search: "?phase=retention" }),
		).toBe("retention");
		expect(
			workspacePerformanceQaPhaseFromLocation({
				search: "?phase=native_focus",
			}),
		).toBe("native_focus");
		expect(() =>
			workspacePerformanceQaPhaseFromLocation({ search: "?phase=unknown" }),
		).toThrow("unknown workspace performance phase: unknown");
	});
});
