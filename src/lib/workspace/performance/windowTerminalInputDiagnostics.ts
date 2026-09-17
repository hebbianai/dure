import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { terminalInputLatency } from "@/lib/terminal/interaction/terminalInputLatency";
import { summarizeTerminalInputPerformance } from "./terminalInputPerformanceReport";
import {
	readWindowEventLoopLag,
	type WindowEventLoopLagSnapshot,
} from "./windowEventLoopLag";
import type { ParsedWindowReportResponse } from "./windowReportCollection";
import type { WorkspacePerformanceReport } from "./workspacePerformanceReportTypes";

const SCHEMA_VERSION = 1 as const;

export interface WindowTerminalInputDiagnostics {
	schemaVersion: typeof SCHEMA_VERSION;
	windowLabel: string;
	generatedAtMs: number;
	latestSampleAgeMs: number | null;
	eventLoopLag: WindowEventLoopLagSnapshot;
	terminalInput: WorkspacePerformanceReport["terminalInput"];
}

export interface MultiWindowTerminalInputDiagnostics {
	schemaVersion: typeof SCHEMA_VERSION;
	projection: "terminal-input";
	complete: boolean;
	expectedWindowLabels: string[];
	missingWindowLabels: string[];
	windows: WindowTerminalInputDiagnostics[];
}

type TerminalInputReport = WorkspacePerformanceReport["terminalInput"];
type ParseTerminalInputReport = (
	value: unknown,
) => TerminalInputReport | null | undefined;

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function finiteNonNegative(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function nullableFiniteNonNegative(value: unknown): boolean {
	return value === null || finiteNonNegative(value);
}

/** Validates an intra-app reply and forwards no fields outside the projection. */
export function parseWindowTerminalInputResponse(
	value: unknown,
	parseTerminalInput: ParseTerminalInputReport,
): ParsedWindowReportResponse<WindowTerminalInputDiagnostics> | undefined {
	if (!record(value)) return undefined;
	if (
		!nonEmptyString(value.requestId) ||
		value.projection !== "terminal-input"
	) {
		return undefined;
	}
	const sample = record(value.sample) ? value.sample : undefined;
	const eventLoopLag =
		sample && record(sample.eventLoopLag) ? sample.eventLoopLag : undefined;
	const terminalInput = sample
		? parseTerminalInput(sample.terminalInput)
		: undefined;
	if (
		!sample ||
		sample.schemaVersion !== SCHEMA_VERSION ||
		!nonEmptyString(sample.windowLabel) ||
		!finiteNonNegative(sample.generatedAtMs) ||
		!nullableFiniteNonNegative(sample.latestSampleAgeMs) ||
		!eventLoopLag ||
		typeof eventLoopLag.visible !== "boolean" ||
		typeof eventLoopLag.focused !== "boolean" ||
		!finiteNonNegative(eventLoopLag.contextChangedAtMs) ||
		!nullableFiniteNonNegative(eventLoopLag.lastSampleAtMs) ||
		!finiteNonNegative(eventLoopLag.sampleCount) ||
		!nullableFiniteNonNegative(eventLoopLag.recentP95Ms) ||
		!nullableFiniteNonNegative(eventLoopLag.recentMaxMs) ||
		!terminalInput
	) {
		return undefined;
	}
	return {
		requestId: value.requestId,
		sample: {
			schemaVersion: SCHEMA_VERSION,
			windowLabel: sample.windowLabel,
			generatedAtMs: sample.generatedAtMs,
			latestSampleAgeMs: sample.latestSampleAgeMs as number | null,
			eventLoopLag: {
				visible: eventLoopLag.visible,
				focused: eventLoopLag.focused,
				contextChangedAtMs: eventLoopLag.contextChangedAtMs,
				lastSampleAtMs: eventLoopLag.lastSampleAtMs as number | null,
				sampleCount: eventLoopLag.sampleCount,
				recentP95Ms: eventLoopLag.recentP95Ms as number | null,
				recentMaxMs: eventLoopLag.recentMaxMs as number | null,
			},
			terminalInput,
		},
	};
}

/** Reads only the existing window-local exact trace and passive event-loop facts. */
export async function readWindowTerminalInputDiagnostics(): Promise<WindowTerminalInputDiagnostics> {
	const snapshot = terminalInputLatency.snapshot();
	// Index access, not Array.at — tsconfig pins lib to ES2020.
	const latest = snapshot.samples[snapshot.samples.length - 1];
	return {
		schemaVersion: SCHEMA_VERSION,
		windowLabel: getCurrentWebviewWindow().label,
		generatedAtMs: Date.now(),
		latestSampleAgeMs: latest
			? Math.max(0, performance.now() - latest.startedAt)
			: null,
		eventLoopLag: readWindowEventLoopLag(),
		terminalInput: summarizeTerminalInputPerformance(snapshot),
	};
}

export function aggregateWindowTerminalInputDiagnostics(
	expectedWindowLabels: string[],
	samples: ReadonlyMap<string, WindowTerminalInputDiagnostics>,
): MultiWindowTerminalInputDiagnostics {
	const windows = expectedWindowLabels.flatMap((label) => {
		const sample = samples.get(label);
		return sample ? [sample] : [];
	});
	const missingWindowLabels = expectedWindowLabels.filter(
		(label) => !samples.has(label),
	);
	return {
		schemaVersion: SCHEMA_VERSION,
		projection: "terminal-input",
		complete: missingWindowLabels.length === 0,
		expectedWindowLabels,
		missingWindowLabels,
		windows,
	};
}
