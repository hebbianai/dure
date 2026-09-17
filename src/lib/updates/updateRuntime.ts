import { startUpdateChecks } from "@/lib/platform/updater";
import { startAgentToolingUpdateChecks } from "@/lib/updates/agentToolingUpdateSource";
import { startProviderCliUpdateChecks } from "@/lib/updates/providerCliUpdateSource";

/** Start each source adapter while keeping the notice projection source-neutral. */
export function startUpdateNoticeRuntime(): () => void {
	const stopAppUpdates = startUpdateChecks();
	const stopAgentToolingUpdates = startAgentToolingUpdateChecks();
	const stopProviderCliUpdates = startProviderCliUpdateChecks();
	return () => {
		stopProviderCliUpdates();
		stopAgentToolingUpdates();
		stopAppUpdates();
	};
}
