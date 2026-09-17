import { omitRemovedAgentRecords } from "@/lib/agents/removedAgentRecords";
import {
	type DurableProjectionCleanupCandidates,
	type DurableProjectionDepartures,
	rehydrateDurableProjectionRuntime,
} from "@/lib/persistence/durableProjectionRuntimeCleanup";
import { rehydrateAppStoreFromDurableStorage, useStore } from "@/store";

/** Reconciles this WebView's latest projection and installs the durable result. */
export async function settleDurableAppState(
	additionalDepartures?: DurableProjectionCleanupCandidates,
): Promise<DurableProjectionDepartures> {
	return rehydrateDurableProjectionRuntime({
		current: useStore.getState,
		rehydrate: rehydrateAppStoreFromDurableStorage,
		...(additionalDepartures ? { additionalDepartures } : {}),
		remove: (removed) =>
			useStore.setState((state) => ({
				// Drafts belong to the conversation UI, so replacing its execution
				// registration does not retire text the user has not submitted.
				chatDrafts: Object.fromEntries(
					Object.entries(state.chatDrafts).filter(([agentId]) =>
						state.agents.some((agent) => agent.id === agentId),
					),
				),
				chatDraftMoves: Object.fromEntries(
					Object.entries(state.chatDraftMoves).filter(([agentId]) => state.agents.some((agent) => agent.id === agentId)),
				),
				...omitRemovedAgentRecords(
					state,
					removed.agentIds,
					removed.sessionIds,
				),
				detected: Object.fromEntries(
					Object.entries(state.detected).filter(
						([projectId]) => !removed.projectIds.has(projectId),
					),
				),
			})),
	});
}
