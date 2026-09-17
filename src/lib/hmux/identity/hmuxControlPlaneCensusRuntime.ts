import { publishHmuxControlPlaneCensus } from "@/lib/hmux/identity/hmuxControlPlaneCensusFeed";
import {
	requestHmuxControlPlaneCensus,
	type HmuxControlPlaneCensusRequestReason,
} from "@/lib/hmux/identity/hmuxControlPlaneCensusObservation";
import type { HmuxControlPlaneCensus } from "@/lib/ipc";
import { isMainWindow } from "@/lib/workspace/window/windows";
import { useStore } from "@/store";

type AppCensusTrigger = Extract<
	HmuxControlPlaneCensusRequestReason,
	{ source: "app_control_plane" }
>["trigger"];

interface HmuxControlPlaneCensusRuntimeDependencies {
	request: typeof requestHmuxControlPlaneCensus;
	apply(census: HmuxControlPlaneCensus): void;
	windowRole(): "main" | "secondary";
	warn(error: unknown): void;
}

const defaultDependencies: HmuxControlPlaneCensusRuntimeDependencies = {
	request: requestHmuxControlPlaneCensus,
	apply: (census) => {
		publishHmuxControlPlaneCensus(census);
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

export function installHmuxControlPlaneCensusRuntime(
	dependencies: HmuxControlPlaneCensusRuntimeDependencies = defaultDependencies,
): () => void {
	let disposed = false;
	let inFlight: Promise<void> | undefined;
	const request = (trigger: AppCensusTrigger) => {
		if (disposed || document.visibilityState === "hidden" || inFlight) return;
		inFlight = dependencies
			.request({
				source: "app_control_plane",
				trigger,
				windowRole: dependencies.windowRole(),
			})
			.then((result) => {
				if (!disposed) dependencies.apply(result);
			})
			.catch((error) => {
				if (!disposed) dependencies.warn(error);
			})
			.finally(() => {
				inFlight = undefined;
			});
	};
	const onWindowFocus = () => request("window_focus");
	const onVisibilityForeground = () => request("visibility_foreground");

	request("initial");
	window.addEventListener("focus", onWindowFocus);
	document.addEventListener("visibilitychange", onVisibilityForeground);
	return () => {
		disposed = true;
		window.removeEventListener("focus", onWindowFocus);
		document.removeEventListener("visibilitychange", onVisibilityForeground);
	};
}
