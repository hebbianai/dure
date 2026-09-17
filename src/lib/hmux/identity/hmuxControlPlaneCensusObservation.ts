import { hmux, type HmuxControlPlaneCensus } from "@/lib/ipc";

type HmuxControlPlaneCensusWindowRole = "main" | "secondary";

export type HmuxControlPlaneCensusRequestReason =
	| {
			source: "app_control_plane";
			trigger: "initial" | "window_focus" | "visibility_foreground";
			windowRole: HmuxControlPlaneCensusWindowRole;
	  }
	| {
			source: "session_recovery";
			trigger: "refresh";
			windowRole: HmuxControlPlaneCensusWindowRole;
	  };

export interface HmuxControlPlaneCensusPerformanceObservation {
	requestReason: HmuxControlPlaneCensusRequestReason;
	receivedAtMs: number;
	diagnostics?: NonNullable<HmuxControlPlaneCensus["diagnostics"]>;
	sessionCounts: {
		total: number;
		ready: number;
		exited: number;
	};
}

let latest: HmuxControlPlaneCensusPerformanceObservation | undefined;

function projectRequestReason(
	requestReason: HmuxControlPlaneCensusRequestReason,
): HmuxControlPlaneCensusRequestReason {
	return requestReason.source === "app_control_plane"
		? {
				source: "app_control_plane",
				trigger: requestReason.trigger,
				windowRole: requestReason.windowRole,
			}
		: {
				source: "session_recovery",
				trigger: "refresh",
				windowRole: requestReason.windowRole,
			};
}

function projectDiagnostics(
	diagnostics: NonNullable<HmuxControlPlaneCensus["diagnostics"]>,
): NonNullable<HmuxControlPlaneCensus["diagnostics"]> {
	return {
		catalogUs: diagnostics.catalogUs,
		healthProjectionUs: diagnostics.healthProjectionUs,
		totalUs: diagnostics.totalUs,
		joinedExisting: diagnostics.joinedExisting,
	};
}

function copyObservation(
	observation: HmuxControlPlaneCensusPerformanceObservation,
): HmuxControlPlaneCensusPerformanceObservation {
	return {
		requestReason: projectRequestReason(observation.requestReason),
		receivedAtMs: observation.receivedAtMs,
		...(observation.diagnostics
			? { diagnostics: projectDiagnostics(observation.diagnostics) }
			: {}),
		sessionCounts: { ...observation.sessionCounts },
	};
}

/** Invokes the existing control-plane route once, retaining only a bounded,
 * content-free timing projection after a successful receipt. */
export async function requestHmuxControlPlaneCensus(
	requestReason: HmuxControlPlaneCensusRequestReason,
): Promise<HmuxControlPlaneCensus> {
	const census = await hmux.controlPlaneCensus();
	latest = {
		requestReason: projectRequestReason(requestReason),
		receivedAtMs: Date.now(),
		...(census.diagnostics
			? { diagnostics: projectDiagnostics(census.diagnostics) }
			: {}),
		sessionCounts: {
			total: census.sessions.length,
			ready: census.sessions.filter((session) => session.lifecycle === "ready")
				.length,
			exited: census.sessions.filter(
				(session) => session.lifecycle === "exited",
			).length,
		},
	};
	return census;
}

export function readLatestHmuxControlPlaneCensusObservation():
	| HmuxControlPlaneCensusPerformanceObservation
	| undefined {
	return latest ? copyObservation(latest) : undefined;
}

export function resetHmuxControlPlaneCensusObservationForTests(): void {
	latest = undefined;
}
