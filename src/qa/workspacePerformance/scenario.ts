import scenarioDefinitions from "./scenarios.json";

export type WorkspacePerformanceScenarioId = keyof typeof scenarioDefinitions;

export interface WorkspacePerformanceScenario {
	id: WorkspacePerformanceScenarioId;
	desktopCount: number;
	panesPerDesktop: number;
	revisitSamples: number;
	focusInputSamples: number;
	terminalCount: number;
	cacheSamples: Partial<Record<"renderer" | "model" | "cold", number>>;
}

export const DEFAULT_WORKSPACE_PERFORMANCE_SCENARIO = "baseline_15";
export type WorkspacePerformanceQaPhase =
	| "full"
	| "focus"
	| "sash"
	| "retention"
	| "native_focus";

export function workspacePerformanceScenario(
	id: string | null | undefined,
): WorkspacePerformanceScenario {
	const resolved = id || DEFAULT_WORKSPACE_PERFORMANCE_SCENARIO;
	if (!(resolved in scenarioDefinitions)) {
		throw new Error(`unknown workspace performance scenario: ${resolved}`);
	}
	const definition =
		scenarioDefinitions[resolved as WorkspacePerformanceScenarioId];
	assertPositiveInteger(definition.desktopCount, "desktopCount");
	assertPositiveInteger(definition.panesPerDesktop, "panesPerDesktop");
	assertNonNegativeInteger(definition.revisitSamples, "revisitSamples");
	assertPositiveInteger(definition.focusInputSamples, "focusInputSamples");
	for (const [cacheState, samples] of Object.entries(definition.cacheSamples)) {
		assertNonNegativeInteger(samples, `cacheSamples.${cacheState}`);
	}
	return {
		id: resolved as WorkspacePerformanceScenarioId,
		...definition,
		terminalCount: definition.desktopCount * definition.panesPerDesktop,
	};
}

export function workspacePerformanceScenarioFromLocation(
	location: Pick<Location, "search"> = window.location,
) {
	return workspacePerformanceScenario(
		new URLSearchParams(location.search).get("scenario"),
	);
}

/** Selects a bounded diagnostic without changing the topology contract. */
export function workspacePerformanceQaPhaseFromLocation(
	location: Pick<Location, "search"> = window.location,
): WorkspacePerformanceQaPhase {
	const phase = new URLSearchParams(location.search).get("phase") ?? "full";
	if (
		phase !== "full" &&
		phase !== "focus" &&
		phase !== "sash" &&
		phase !== "retention" &&
		phase !== "native_focus"
	) {
		throw new Error(`unknown workspace performance phase: ${phase}`);
	}
	return phase;
}

function assertPositiveInteger(value: number, field: string) {
	if (!Number.isInteger(value) || value <= 0) {
		throw new Error(`invalid workspace performance scenario ${field}`);
	}
}

function assertNonNegativeInteger(value: number, field: string) {
	if (!Number.isInteger(value) || value < 0) {
		throw new Error(`invalid workspace performance scenario ${field}`);
	}
}
