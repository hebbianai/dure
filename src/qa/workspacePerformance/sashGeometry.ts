import type { TerminalGeometryDiagnosticSnapshot } from "@/lib/terminal/geometry/terminalGeometryDiagnostics";

export interface WorkspacePerformanceSashGeometryEvidence {
	readonly schemaVersion: 1;
	readonly baselineGeneration: number;
	readonly transactionGeneration: number;
	readonly visibleSurfaceCount: number;
	readonly changedSurfaceCount: number;
	readonly matchingSurfaceCount: number;
	readonly dirtySurfaceCount: number;
	readonly converged: boolean;
}

function gridsMatch(
	left: { readonly columns: number; readonly rows: number } | null,
	right: { readonly columns: number; readonly rows: number } | null,
): boolean {
	return (
		left !== null &&
		right !== null &&
		left.columns === right.columns &&
		left.rows === right.rows
	);
}

function surfaceFillsHost(
	surface: TerminalGeometryDiagnosticSnapshot["surfaces"][number],
): boolean {
	return (
		gridsMatch(surface.canonical, surface.fit) &&
		surface.renderedRows === surface.canonical?.rows &&
		Math.abs(surface.host.rectWidth - surface.presentation.rectWidth) < 1 &&
		Math.abs(surface.host.rectHeight - surface.presentation.rectHeight) < 1
	);
}

/** Content-free verdict for the two native sash transitions in the QA fixture. */
export function summarizeWorkspacePerformanceSashGeometry(
	before: TerminalGeometryDiagnosticSnapshot,
	after: TerminalGeometryDiagnosticSnapshot,
): WorkspacePerformanceSashGeometryEvidence {
	const initialGrids = new Map(
		before.surfaces.map((surface) => [surface.surfaceId, surface.canonical]),
	);
	const visible = after.surfaces.filter(
		(surface) => surface.host.clientWidth > 0 && surface.host.clientHeight > 0,
	);
	const changedSurfaceCount = visible.filter((surface) => {
		const initial = initialGrids.get(surface.surfaceId);
		return (
			initial !== undefined &&
			initial !== null &&
			surface.canonical !== null &&
			!gridsMatch(initial, surface.canonical)
		);
	}).length;
	const matchingSurfaceCount = visible.filter(surfaceFillsHost).length;
	const dirtySurfaceCount = after.resizeTransaction.surfaces.filter(
		(surface) => surface.dirtyRevision > surface.committedRevision,
	).length;
	const baselineGeneration = before.resizeTransaction.generation;
	const transactionGeneration = after.resizeTransaction.generation;
	return {
		schemaVersion: 1,
		baselineGeneration,
		transactionGeneration,
		visibleSurfaceCount: visible.length,
		changedSurfaceCount,
		matchingSurfaceCount,
		dirtySurfaceCount,
		converged:
			after.resizeTransaction.phase === "idle" &&
			transactionGeneration >= baselineGeneration + 2 &&
			visible.length >= 2 &&
			changedSurfaceCount >= 2 &&
			matchingSurfaceCount === visible.length &&
			dirtySurfaceCount === 0,
	};
}
