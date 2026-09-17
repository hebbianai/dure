import { describe, expect, it, vi } from "vitest";
import type { WorkspacePerformanceFixture } from "./fixture";
import { detachWorkspacePerformanceSurfaces } from "./surfaceCleanup";

describe("detachWorkspacePerformanceSurfaces", () => {
	it("removes every mounted fixture pane before the cleanup paint", async () => {
		const panels = new Map([
			["term:a", { id: "term:a" }],
			["term:b", { id: "term:b" }],
		]);
		const removePanel = vi.fn((panel: { id: string }) => panels.delete(panel.id));
		const postPaint = vi.fn(async () => {
			expect(panels.size).toBe(0);
		});
		const fixture = {
			spaces: [{ id: "desktop-1", name: "QA" }],
			panelIdsByDesktop: { "desktop-1": ["term:a", "term:b"] },
		} as unknown as WorkspacePerformanceFixture;

		await detachWorkspacePerformanceSurfaces(fixture, {
			dockview: () => ({
				getPanel: (id: string) => panels.get(id),
				removePanel,
			}) as never,
			postPaint,
		});

		expect(removePanel).toHaveBeenCalledTimes(2);
		expect(postPaint).toHaveBeenCalledOnce();
	});

	it("continues detaching later panes after one Dockview removal fails", async () => {
		const first = { id: "term:a" };
		const second = { id: "term:b" };
		const panels = new Map([
			[first.id, first],
			[second.id, second],
		]);
		const postPaint = vi.fn(async () => {});
		const fixture = {
			spaces: [{ id: "desktop-1", name: "QA" }],
			panelIdsByDesktop: { "desktop-1": [first.id, second.id] },
		} as unknown as WorkspacePerformanceFixture;

		const pending = detachWorkspacePerformanceSurfaces(fixture, {
			dockview: () =>
				({
					getPanel: (id: string) => panels.get(id),
					removePanel: (panel: { id: string }) => {
						if (panel.id === first.id) throw new Error("first removal failed");
						panels.delete(panel.id);
					},
				}) as never,
			postPaint,
		});

		await expect(pending).rejects.toThrow(
			"workspace performance surface cleanup failed (1)",
		);
		expect(panels.has(second.id)).toBe(false);
		expect(postPaint).toHaveBeenCalledOnce();
	});
});
