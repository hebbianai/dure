import {
	publishHmuxControlPlaneCensus,
	subscribeHmuxControlPlaneCensusSince,
} from "@/lib/hmux/identity/hmuxControlPlaneCensusFeed";
import {
	requestHmuxControlPlaneCensus,
	type HmuxControlPlaneCensusRequestReason,
} from "@/lib/hmux/identity/hmuxControlPlaneCensusObservation";
import type { HmuxControlPlaneCensus } from "@/lib/ipc";
import { isMainWindow } from "@/lib/workspace/window/windows";
import { useStore } from "@/store";

interface HmuxControlPlaneCensusRuntimeDependencies {
	request: typeof requestHmuxControlPlaneCensus;
	apply(census: HmuxControlPlaneCensus, requestedAtMs: number): void;
	windowRole(): "main" | "secondary";
	warn(error: unknown): void;
}

const defaultDependencies: HmuxControlPlaneCensusRuntimeDependencies = {
	request: requestHmuxControlPlaneCensus,
	apply: (census, requestedAtMs) => {
		publishHmuxControlPlaneCensus(census, requestedAtMs);
		useStore.getState().setHmuxSessionsMetadata(census.sessions);
		document.documentElement.dataset.hmuxCurrentBuild =
			census.policy.currentBuildId ?? "unavailable";
		document.documentElement.dataset.hmuxUpdatePolicy =
			census.policy.signedReleaseFetch;
		document.documentElement.dataset.hmuxIndependentInstall =
			census.policy.independentInstall?.readiness ?? "unavailable";
	},
	windowRole: () => (isMainWindow() ? "main" : "secondary"),
	warn: (error) => console.warn("[hmux control-plane census]", error),
};

/** The installed runtime's session-recovery refresh, if one is installed. */
let installedRefresh: (() => void) | undefined;

export function installHmuxControlPlaneCensusRuntime(
	dependencies: HmuxControlPlaneCensusRuntimeDependencies = defaultDependencies,
): () => void {
	let disposed = false;
	let inFlight: Promise<void> | undefined;
	let refreshPending = false;
	const request = (reason: HmuxControlPlaneCensusRequestReason) => {
		if (disposed) return;
		// A refresh asks for a census requested after now, so one already in
		// flight cannot answer it: it runs again once that one lands.
		if (inFlight) {
			if (reason.source === "session_recovery") refreshPending = true;
			return;
		}
		if (
			reason.source === "app_control_plane" &&
			document.visibilityState === "hidden"
		) {
			return;
		}
		const requestedAtMs = Date.now();
		inFlight = dependencies
			.request(reason)
			.then((result) => {
				if (!disposed) dependencies.apply(result, requestedAtMs);
			})
			.catch((error) => {
				if (!disposed) dependencies.warn(error);
			})
			.finally(() => {
				inFlight = undefined;
				if (refreshPending) {
					refreshPending = false;
					refresh();
				}
			});
	};
	const appRequest = (
		trigger: Extract<
			HmuxControlPlaneCensusRequestReason,
			{ source: "app_control_plane" }
		>["trigger"],
	) =>
		request({
			source: "app_control_plane",
			trigger,
			windowRole: dependencies.windowRole(),
		});
	const refresh = () =>
		request({
			source: "session_recovery",
			trigger: "refresh",
			windowRole: dependencies.windowRole(),
		});
	const onWindowFocus = () => appRequest("window_focus");
	const onVisibilityForeground = () => appRequest("visibility_foreground");

	installedRefresh = refresh;
	appRequest("initial");
	window.addEventListener("focus", onWindowFocus);
	document.addEventListener("visibilitychange", onVisibilityForeground);
	return () => {
		disposed = true;
		if (installedRefresh === refresh) installedRefresh = undefined;
		window.removeEventListener("focus", onWindowFocus);
		document.removeEventListener("visibilitychange", onVisibilityForeground);
	};
}

/** Calls `listener` once with the first complete census requested from now
 * on, asking the installed runtime for one (a hidden window included).
 * Concurrent askers share one request. Returns a cancel. */
export function nextHmuxControlPlaneCensus(
	listener: (census: HmuxControlPlaneCensus) => void,
): () => void {
	const cancel = subscribeHmuxControlPlaneCensusSince(Date.now(), listener);
	installedRefresh?.();
	return cancel;
}
