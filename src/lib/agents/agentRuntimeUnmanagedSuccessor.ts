import type { AgentRuntimeProjectionInspectionSourceV1 } from "@/lib/agents/agentRuntimeProjectionInspection";
import type { DureAgentRuntimeInspectResultV1 } from "@/lib/ipc/dureAgentRuntime";
import {
	observeManagedRehostLineage,
	reconcileManagedAgentDurableSuccessor,
} from "@/lib/sessions/managed/managedAgentDurableSuccessor";
import { publishManagedAgentRehostProjection } from "@/lib/sessions/managed/managedAgentRehostPublication";
import { commitReconciledManagedAgentRehostReceipt } from "@/lib/sessions/managed/managedAgentRehostSynchronization";
import { managedConversationId } from "@/lib/sessions/managed/managedConversationIdentity";
import { useStore } from "@/store";

/** Publish only a completed Hmux successor into the observed unmanaged backend.
 * Pending lineage remains unresolved; this passive path cannot execute a rehost. */
export async function convergeUnmanagedAgentSuccessor(
	source: AgentRuntimeProjectionInspectionSourceV1,
	observation: Extract<DureAgentRuntimeInspectResultV1, { state: "unmanaged" }>,
	isCurrent: () => boolean,
): Promise<boolean> {
	const snapshot = useStore.getState();
	const agent = snapshot.agents.find(
		(candidate) => candidate.id === source.agentId,
	);
	const binding = agent?.runtimeBinding;
	if (
		!agent ||
		binding?.runtime !== "hmux_managed_v1" ||
		binding.source !== "local" ||
		binding.sessionId !== agent.sessionId ||
		!binding.stopFence ||
		!managedConversationId(agent)
	)
		return true;
	const lineage = await observeManagedRehostLineage(binding);
	if (lineage.state !== "resolved") return lineage.state === "not_found";
	if (!isCurrent()) return false;
	const reconciliation = await reconcileManagedAgentDurableSuccessor(
		agent,
		snapshot.activeSpaceId ?? "detached",
		`agent:${agent.id}`,
		snapshot.skipPermissions,
		{ backendRouteAuthority: observation.routeAuthority, lineage },
	);
	if (!reconciliation || !isCurrent()) return false;
	const committed = await commitReconciledManagedAgentRehostReceipt(
		reconciliation,
		{ activate: false },
	);
	publishManagedAgentRehostProjection(committed.payload);
	return true;
}
