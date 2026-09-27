import {
	aggregateStructuredTerminalPresentationSnapshots,
	type StructuredTerminalPresentationTotalsSnapshot,
} from "./structuredTerminalPresentationPerformance";
import {
	WINDOW_PERFORMANCE_SCHEMA_VERSION,
	type WindowPerformanceDiagnostics,
} from "./windowPerformanceDiagnostics";
import type { WorkspacePerformanceSnapshot } from "./workspacePerformanceTypes";

type Totals = WorkspacePerformanceSnapshot["totals"];
type RenderPressure = NonNullable<WorkspacePerformanceSnapshot["render"]>;

export interface MultiWindowPerformanceDiagnostics {
	schemaVersion: typeof WINDOW_PERFORMANCE_SCHEMA_VERSION;
	complete: boolean;
	expectedWindowLabels: string[];
	missingWindowLabels: string[];
	totals: Totals;
	render: Omit<RenderPressure, "perSurface"> | null;
	terminalPresentation: StructuredTerminalPresentationTotalsSnapshot;
	windows: WindowPerformanceDiagnostics[];
}

export function aggregateWindowPerformanceDiagnostics(
	expectedWindowLabels: string[],
	samples: ReadonlyMap<string, WindowPerformanceDiagnostics>,
): MultiWindowPerformanceDiagnostics {
	const windows = expectedWindowLabels.flatMap((label) => {
		const sample = samples.get(label);
		return sample ? [sample] : [];
	});
	const totals = windows.reduce<Totals>(
		(sum, window) => ({
			mountedWorkspaces:
				sum.mountedWorkspaces + window.totals.mountedWorkspaces,
			terminalSurfaces: sum.terminalSurfaces + window.totals.terminalSurfaces,
			terminalGpuViewportBytes:
				(sum.terminalGpuViewportBytes ?? 0) +
				(window.totals.terminalGpuViewportBytes ?? 0),
			terminalModelBytes:
				(sum.terminalModelBytes ?? 0) + (window.totals.terminalModelBytes ?? 0),
			webglContexts: sum.webglContexts + window.totals.webglContexts,
			hmuxObservers: sum.hmuxObservers + window.totals.hmuxObservers,
		}),
		{
			mountedWorkspaces: 0,
			terminalSurfaces: 0,
			terminalGpuViewportBytes: 0,
			terminalModelBytes: 0,
			webglContexts: 0,
			hmuxObservers: 0,
		},
	);
	const missingWindowLabels = expectedWindowLabels.filter(
		(label) => !samples.has(label),
	);
	const renderSamples = windows.flatMap((window) =>
		window.render ? [window.render] : [],
	);
	return {
		schemaVersion: WINDOW_PERFORMANCE_SCHEMA_VERSION,
		complete: missingWindowLabels.length === 0,
		expectedWindowLabels,
		missingWindowLabels,
		totals,
		render:
			renderSamples.length > 0 &&
			renderSamples.length === expectedWindowLabels.length
				? {
						bufferedBytes: renderSamples.reduce(
							(sum, render) => sum + render.bufferedBytes,
							0,
						),
						peakBufferedBytes: renderSamples.reduce(
							(sum, render) => sum + render.peakBufferedBytes,
							0,
						),
						maxRecentWriteLatencyMs: renderSamples.reduce(
							(maximum, render) =>
								Math.max(maximum, render.maxRecentWriteLatencyMs),
							0,
						),
					}
				: null,
		terminalPresentation: aggregateStructuredTerminalPresentationSnapshots(
			windows.map((window) => window.terminalPresentation),
		),
		windows,
	};
}
