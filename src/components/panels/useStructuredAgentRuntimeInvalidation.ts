import { type Dispatch, type SetStateAction, useCallback } from "react";
import type { AgentRuntimeLaunchState } from "@/components/panels/useAgentRuntimeLaunchSelectionHydration";
import { agentRuntimePresentationOwnerKey } from "@/lib/agents/agentRuntimePresentationOwner";
import type {
	StructuredAgentRuntimeProjectionGenerationV1,
	StructuredAgentRuntimeProjectionSourceV1,
} from "@/lib/agents/agentRuntimeProjectionRecovery";
import type {
	RecoveredStructuredAgentRuntimeProjection,
	StructuredAgentRuntimeProjectionRecoveryRequestV1,
} from "@/lib/agents/agentRuntimeStructuredProjectionRecovery";
import type { Agent } from "@/types";

interface StructuredAgentRuntimeInvalidationOptions {
	agentId: string;
	setLaunchState: Dispatch<SetStateAction<AgentRuntimeLaunchState>>;
	getAgent(agentId: string): Agent | undefined;
	recover(
		source: StructuredAgentRuntimeProjectionSourceV1,
		request: StructuredAgentRuntimeProjectionRecoveryRequestV1,
	): Promise<RecoveredStructuredAgentRuntimeProjection | undefined>;
}

/** Converts controller invalidation into one replaceable pane projection. The
 * conversation controller remains the owner of reconnect errors and cadence. */
export function useStructuredAgentRuntimeInvalidation({
	agentId,
	setLaunchState,
	getAgent,
	recover,
}: StructuredAgentRuntimeInvalidationOptions) {
	return useCallback(
		async (
			expectedGeneration: StructuredAgentRuntimeProjectionGenerationV1,
		) => {
			const current = getAgent(agentId);
			const profile = current?.interactionProfile;
			if (!current || profile?.kind !== "structured_protocol") return false;
			const source = {
				agentId,
				backendProfileId: profile.backendProfileId,
				interactionSessionId: profile.interactionSessionId,
			};
			const sourceOwnerKey = agentRuntimePresentationOwnerKey(current);
			setLaunchState((state) =>
				state.ownerKey === sourceOwnerKey
					? { ...state, hydrationError: false }
					: state,
			);
			const recovered = await recover(source, {
				kind: "observed_generation",
				generation: expectedGeneration,
			});
			if (!recovered) return false;
			const latest = getAgent(agentId);
			if (
				!latest ||
				agentRuntimePresentationOwnerKey(latest) !== recovered.ownerKey
			) {
				return false;
			}
			setLaunchState(() => ({
				loaded: true,
				hydrationError: false,
				...recovered.launchSelection,
				ownerKey: recovered.ownerKey,
				selectionRevision: recovered.selectionRevision,
			}));
			return true;
		},
		[agentId, getAgent, recover, setLaunchState],
	);
}
