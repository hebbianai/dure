import { describe, expect, it } from "vitest";
import type { TerminalGeometryDiagnosticSnapshot } from "@/lib/terminal/geometry/terminalGeometryDiagnostics";
import { summarizeWorkspacePerformanceSashGeometry } from "./sashGeometry";

function snapshot(
	generation: number,
	grids: readonly [number, number][],
	options: {
		readonly phase?: "idle" | "dragging";
		readonly dirty?: boolean;
	} = {},
): TerminalGeometryDiagnosticSnapshot {
	return {
		resizeTransaction: {
			phase: options.phase ?? "idle",
			generation,
			observationEpoch: generation,
			targetSurfaceKey: null,
			surfaces: grids.map((_, index) => ({
				surfaceKey: `surface-${index + 1}`,
				registrationCount: 1,
				latestRegistrationGeneration: index + 1,
				canCommit: true,
				dirtyRevision: options.dirty ? 2 : 0,
				committedRevision: options.dirty ? 1 : 0,
			})),
		},
		surfaces: grids.map(([columns, rows], index) => ({
			surfaceId: `surface-${index + 1}`,
			canonical: { columns, rows },
			fit: { columns, rows },
			cell: { width: 10, height: 20 },
			host: {
				clientWidth: columns * 10,
				clientHeight: rows * 20,
				rectWidth: columns * 10,
				rectHeight: rows * 20,
			},
			presentation: {
				clientWidth: columns * 10,
				clientHeight: rows * 20,
				rectWidth: columns * 10,
				rectHeight: rows * 20,
			},
			renderedRows: rows,
			renderedRuns: rows,
			positionedRuns: 0,
			ancestors: [],
		})),
	};
}

describe("workspace performance native sash geometry", () => {
	it("requires two transactions and complete visible-surface convergence", () => {
		const before = snapshot(4, [
			[50, 20],
			[50, 20],
		]);
		const after = snapshot(6, [
			[62, 20],
			[38, 20],
		]);

		expect(summarizeWorkspacePerformanceSashGeometry(before, after)).toEqual({
			schemaVersion: 1,
			baselineGeneration: 4,
			transactionGeneration: 6,
			visibleSurfaceCount: 2,
			changedSurfaceCount: 2,
			matchingSurfaceCount: 2,
			dirtySurfaceCount: 0,
			converged: true,
		});
	});

	it("rejects an idle snapshot that erased a failed canonical commit", () => {
		const before = snapshot(4, [
			[50, 20],
			[50, 20],
		]);
		const after = snapshot(
			6,
			[
				[62, 20],
				[38, 20],
			],
			{ dirty: true },
		);

		expect(
			summarizeWorkspacePerformanceSashGeometry(before, after),
		).toMatchObject({ dirtySurfaceCount: 2, converged: false });
	});

	it("does not count a missing baseline grid as a resized surface", () => {
		const completeBefore = snapshot(4, [
			[50, 20],
			[50, 20],
		]);
		const before: TerminalGeometryDiagnosticSnapshot = {
			...completeBefore,
			surfaces: completeBefore.surfaces.map((surface, index) =>
				index === 0 ? { ...surface, canonical: null } : surface,
			),
		};
		const after = snapshot(6, [
			[62, 20],
			[38, 20],
		]);

		expect(
			summarizeWorkspacePerformanceSashGeometry(before, after),
		).toMatchObject({ changedSurfaceCount: 1, converged: false });
	});
});
