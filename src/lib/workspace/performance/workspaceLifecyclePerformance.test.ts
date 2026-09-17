import { describe, expect, it } from "vitest";
import { WorkspaceLifecyclePerformanceTracker } from "@/lib/workspace/performance/workspaceLifecyclePerformance";

describe("WorkspaceLifecyclePerformanceTracker", () => {
	it("replaces an unfinished pane sample and classifies the next completed open as warm", () => {
		let now = 0;
		const tracker = new WorkspaceLifecyclePerformanceTracker(() => now);

		tracker.beginPaneOpen("pane-a", "file");
		now = 5;
		tracker.beginPaneOpen("pane-a", "file");
		now = 25;
		tracker.markPaneReady("pane-a");
		tracker.beginPaneOpen("pane-b", "file");
		now = 30;
		tracker.markPaneReady("pane-b");

		expect(tracker.snapshot().paneOpens).toMatchObject([
			{ paneId: "pane-a", warm: false, openMs: 20 },
			{ paneId: "pane-b", warm: true, openMs: 5 },
		]);
	});

	it("only lets successful provider readiness make later spawns warm", () => {
		const tracker = new WorkspaceLifecyclePerformanceTracker(() => 0);
		const failed = {
			warm: tracker.agentSpawnWarm("codex"),
			ok: false,
			totalMs: -1,
			preflightMs: -2,
			createMs: -3,
		};
		tracker.recordAgentReady("codex", failed);
		expect(tracker.agentSpawnWarm("codex")).toBe(false);

		tracker.recordAgentReady("codex", { ...failed, ok: true });

		expect(tracker.agentSpawnWarm("codex")).toBe(true);
		expect(tracker.snapshot().agentReady).toMatchObject([
			{ ok: false, warm: false, totalMs: 0, preflightMs: 0, createMs: 0 },
			{ ok: true, warm: false },
		]);
	});
});
