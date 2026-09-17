import {
	parseAgentRuntimeIdleInspection,
	type AgentRuntimeIdleInspection,
} from "../../../cli/lib/contracts/agent-runtime.mjs";
import {
	createDureBackendRequester,
	DureBackendRequestError,
} from "./dureBackend";
import { t } from "@/lib/i18n";

export type { AgentRuntimeIdleInspection };

/** One retained local scan page; this read neither scans Hosts nor wakes Agents. */
export async function inspectLocalAgentIdle(): Promise<AgentRuntimeIdleInspection> {
	const backend = createDureBackendRequester({
		profileId: "local",
		invalidResponseCode: "runtime_idle_response_invalid",
		invalidResponseMessage: "usage.cleanup.loadFailed",
		backendChangedCode: "runtime_idle_backend_changed",
		backendChangedMessage: "ipc.dureBackend.generationChanged",
		requestFailedCode: "runtime_idle_inspect_failed",
		requestFailedMessage: "usage.cleanup.loadFailed",
	});
	const response = await backend(
		"agent_runtime.idle.inspect",
		{ schemaVersion: 1 },
		{ kind: "complete_selected_snapshot" },
	);
	const inspection = parseAgentRuntimeIdleInspection(response.result);
	if (
		!inspection ||
		response.routeAuthority.profileId !== "local" ||
		response.routeAuthority.target.source !== "local"
	) {
		throw new DureBackendRequestError(
			"runtime_idle_response_invalid",
			t("usage.cleanup.loadFailed"),
			{ kind: "contract" },
		);
	}
	return inspection;
}
