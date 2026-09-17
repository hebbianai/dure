import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
	type HmuxControlPlaneCensusPerformanceObservation,
	readLatestHmuxControlPlaneCensusObservation,
} from "@/lib/hmux/identity/hmuxControlPlaneCensusObservation";
import {
	type PaneDragPerformanceSnapshot,
	paneDragPerformance,
} from "./paneDragPerformance";
import type { StructuredTerminalPresentationSnapshot } from "./structuredTerminalPresentationPerformance";
import {
	readWindowAnimationDiagnostics,
	type WindowAnimationDiagnostics,
} from "./windowAnimationDiagnostics";
import {
	readWindowEventLoopLag,
	type WindowEventLoopLagSnapshot,
} from "./windowEventLoopLag";
import type { WorkspacePerformanceReport } from "./workspacePerformanceReportTypes";
import type { WorkspacePerformanceSnapshot } from "./workspacePerformanceTypes";

export const WINDOW_PERFORMANCE_SCHEMA_VERSION = 3 as const;

export interface WindowPerformanceDiagnostics {
	schemaVersion: typeof WINDOW_PERFORMANCE_SCHEMA_VERSION;
	windowLabel: string;
	generatedAtMs: number;
	totals: WorkspacePerformanceSnapshot["totals"];
	render: WorkspacePerformanceSnapshot["render"];
	terminalPresentation: StructuredTerminalPresentationSnapshot;
	eventLoopLag: WindowEventLoopLagSnapshot;
	animations: WindowAnimationDiagnostics;
	hmuxControlPlaneCensus: HmuxControlPlaneCensusPerformanceObservation | null;
	terminalInput: WorkspacePerformanceReport["terminalInput"] | null;
	paneFocus: WorkspacePerformanceReport["paneFocus"] | null;
	/** Absent in clients that predate drag timing; not a measured empty result. */
	paneDrag?: PaneDragPerformanceSnapshot;
}

export async function readWindowPerformanceDiagnostics(): Promise<WindowPerformanceDiagnostics> {
	const [
		{ getWorkspacePerformanceSnapshot },
		{ summarizeWorkspacePerformance },
	] = await Promise.all([
		import("./workspacePerformance"),
		import("./workspacePerformanceReport"),
	]);
	const snapshot = getWorkspacePerformanceSnapshot();
	const report = summarizeWorkspacePerformance(snapshot);
	return {
		schemaVersion: WINDOW_PERFORMANCE_SCHEMA_VERSION,
		windowLabel: getCurrentWebviewWindow().label,
		generatedAtMs: Date.now(),
		totals: snapshot.totals,
		render: snapshot.render,
		terminalPresentation: snapshot.terminalPresentation,
		eventLoopLag: readWindowEventLoopLag(),
		animations: readWindowAnimationDiagnostics(),
		hmuxControlPlaneCensus:
			readLatestHmuxControlPlaneCensusObservation() ?? null,
		terminalInput: report.terminalInput,
		paneFocus: report.paneFocus,
		paneDrag: paneDragPerformance.snapshot(),
	};
}
