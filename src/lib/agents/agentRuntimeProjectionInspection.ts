import {
	createDureAgentRuntimeClient,
	type DureAgentRuntimeProjectionInspectResultV1,
} from "@/lib/ipc/dureAgentRuntime";
import { DureBackendRequestError } from "@/lib/ipc/dureBackend";

export interface AgentRuntimeProjectionInspectionSourceV1 {
	readonly agentId: string;
	readonly backendProfileId: string;
}

type InspectAgentRuntime = (
	agentId: string,
) => Promise<DureAgentRuntimeProjectionInspectResultV1>;

/** Scope response ordering to this observation, not unrelated agents on the
 * same profile. Callers own source lifetime and single-flight reconciliation;
 * the native transport still owns connections and selected-route validation.
 * An authority replacement gets one fresh read; other failures remain visible. */
export async function inspectAgentRuntimeProjection(
	source: AgentRuntimeProjectionInspectionSourceV1,
	inspect?: InspectAgentRuntime,
): Promise<DureAgentRuntimeProjectionInspectResultV1> {
	const client = inspect
		? { inspect }
		: createDureAgentRuntimeClient({ profileId: source.backendProfileId });
	const read = () => client.inspect(source.agentId);
	try {
		return await read();
	} catch (error) {
		if (
			!(error instanceof DureBackendRequestError) ||
			error.failure.kind !== "authority_changed"
		) {
			throw error;
		}
		return read();
	}
}
