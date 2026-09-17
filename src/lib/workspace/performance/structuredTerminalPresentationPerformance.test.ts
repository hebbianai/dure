import { describe, expect, it } from "vitest";
import {
	aggregateStructuredTerminalPresentationSnapshots,
	emptyStructuredTerminalPresentationSnapshot,
	StructuredTerminalPresentationPerformanceTracker,
} from "./structuredTerminalPresentationPerformance";

describe("StructuredTerminalPresentationPerformanceTracker", () => {
	it("attributes existing projection intervals by active surface and paint role", () => {
		const tracker = new StructuredTerminalPresentationPerformanceTracker();
		const unknown = tracker.registerSurface("unknown");
		unknown.dispose();
		unknown.record("foreground", {
			projectionStartedAt: 1,
			projectionCommittedAt: 4,
		});
		tracker.registerSurface("a-surface");
		const surface = tracker.registerSurface("Z-surface");

		surface.record("background", {
			projectionStartedAt: 10,
			projectionCommittedAt: 13,
		});
		surface.record("foreground", {
			projectionStartedAt: 20,
			projectionCommittedAt: 25,
		});

		expect(tracker.snapshot()).toEqual({
			total: { commits: 2, totalMs: 8, maxMs: 5 },
			byRole: {
				foreground: { commits: 1, totalMs: 5, maxMs: 5 },
				hovered: { commits: 0, totalMs: 0, maxMs: 0 },
				background: { commits: 1, totalMs: 3, maxMs: 3 },
				ungated: { commits: 0, totalMs: 0, maxMs: 0 },
			},
			perSurface: [
				{
					id: "Z-surface",
					total: { commits: 2, totalMs: 8, maxMs: 5 },
					byRole: {
						foreground: { commits: 1, totalMs: 5, maxMs: 5 },
						hovered: { commits: 0, totalMs: 0, maxMs: 0 },
						background: { commits: 1, totalMs: 3, maxMs: 3 },
						ungated: { commits: 0, totalMs: 0, maxMs: 0 },
					},
				},
				{
					id: "a-surface",
					total: { commits: 0, totalMs: 0, maxMs: 0 },
					byRole: {
						foreground: { commits: 0, totalMs: 0, maxMs: 0 },
						hovered: { commits: 0, totalMs: 0, maxMs: 0 },
						background: { commits: 0, totalMs: 0, maxMs: 0 },
						ungated: { commits: 0, totalMs: 0, maxMs: 0 },
					},
				},
			],
		});
	});

	it("ignores invalid timing and fences disposal to its exact registration", () => {
		const tracker = new StructuredTerminalPresentationPerformanceTracker();
		const first = tracker.registerSurface("surface-a");
		const replacement = tracker.registerSurface("surface-a");
		first.record("foreground", {
			projectionStartedAt: 1,
			projectionCommittedAt: 101,
		});
		first.dispose();
		replacement.record("ungated", {
			projectionStartedAt: 7,
			projectionCommittedAt: 6,
		});
		replacement.record("ungated", {
			projectionStartedAt: Number.NaN,
			projectionCommittedAt: 8,
		});
		replacement.record("ungated", {
			projectionStartedAt: -Number.MAX_VALUE,
			projectionCommittedAt: Number.MAX_VALUE,
		});
		replacement.record("ungated", {
			projectionStartedAt: 8,
			projectionCommittedAt: 10,
		});

		expect(tracker.snapshot().byRole.ungated).toEqual({
			commits: 1,
			totalMs: 2,
			maxMs: 2,
		});
		replacement.dispose();
		replacement.record("ungated", {
			projectionStartedAt: 10,
			projectionCommittedAt: 20,
		});
		const retired = tracker.snapshot();
		expect(retired.total).toEqual({ commits: 1, totalMs: 2, maxMs: 2 });
		expect(retired.perSurface).toEqual([]);
	});

	it("sums multi-window work while retaining the longest commit", () => {
		const first = emptyStructuredTerminalPresentationSnapshot();
		first.total = { commits: 2, totalMs: 9, maxMs: 6 };
		first.byRole.foreground = { commits: 2, totalMs: 9, maxMs: 6 };
		const second = emptyStructuredTerminalPresentationSnapshot();
		second.total = { commits: 3, totalMs: 8, maxMs: 4 };
		second.byRole.background = { commits: 2, totalMs: 7, maxMs: 4 };
		second.byRole.ungated = { commits: 1, totalMs: 1, maxMs: 1 };

		expect(
			aggregateStructuredTerminalPresentationSnapshots([first, second]),
		).toEqual({
			total: { commits: 5, totalMs: 17, maxMs: 6 },
			byRole: {
				foreground: { commits: 2, totalMs: 9, maxMs: 6 },
				hovered: { commits: 0, totalMs: 0, maxMs: 0 },
				background: { commits: 2, totalMs: 7, maxMs: 4 },
				ungated: { commits: 1, totalMs: 1, maxMs: 1 },
			},
		});
	});
});
