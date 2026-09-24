import { agentRuntimeTransitionRoute } from "@/lib/agents/agentRuntimeProfileSwitch";
import { projectAgentRuntimeTransition } from "@/lib/agents/agentRuntimeStoreProjector";
import {
	createDureAgentRuntimeClient,
	type DureAgentRuntimeProjectionInspectResultV1,
} from "@/lib/ipc/dureAgentRuntime";
import type { DureAgentRuntimeObservationClient } from "@/lib/ipc/dureAgentRuntimeObservationClient";
import { useStore } from "@/store";

type StableRuntime = Extract<
	DureAgentRuntimeProjectionInspectResultV1,
	{ state: "stable" }
>;

export interface ManagedClosedLineageWakeDependencies {
	snapshot(): Pick<ReturnType<typeof useStore.getState>, "agents" | "projects">;
	client(
		backendProfileId: string,
	): Pick<DureAgentRuntimeObservationClient, "inspect" | "hibernate" | "wake">;
	project(agentId: string, runtime: StableRuntime): void;
}

const defaultDependencies: ManagedClosedLineageWakeDependencies = {
	snapshot: () => useStore.getState(),
	client: (profileId) => createDureAgentRuntimeClient({ profileId }),
	project: (agentId, runtime) => {
		projectAgentRuntimeTransition(agentId, runtime);
	},
};

/** An exact Resume advances the source lineage. Once a product operation has
 * closed that lineage's checkout claim (an earlier Resume replaced it and the
 * replacement then failed before publication), no retry can advance it. */
export function isClosedManagedSourceLineage(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /^session_checkout_closing\b/.test(message);
}

function wakeFailure(stage: string, state: string): Error {
	return new Error(`managed_closed_lineage_wake_${stage}_${state}`);
}

/** Start the exact conversation on a new runtime root through the backend's
 * own hibernate→wake transition, then project the committed selection.
 * Returns undefined when this Agent has no backend runtime route. */
export async function wakeClosedManagedLineage(
	agentId: string,
	conversationId: string,
	dependencies: ManagedClosedLineageWakeDependencies = defaultDependencies,
): Promise<StableRuntime | undefined> {
	const snapshot = dependencies.snapshot();
	const agent = snapshot.agents.find((candidate) => candidate.id === agentId);
	const project = snapshot.projects.find(
		(candidate) => candidate.id === agent?.projectId,
	);
	const route = agent && agentRuntimeTransitionRoute(agent, project);
	if (!route) return undefined;
	const client = dependencies.client(route.backendProfileId);
	const source = await client.inspect(agentId);
	if (source.state !== "stable") throw wakeFailure("source", source.state);
	const dormant = await client.hibernate({
		agentId,
		expectedSourceRevision: source.selectionRevision,
		routeAuthority: source.routeAuthority,
	});
	if (dormant.state !== "dormant")
		throw wakeFailure("hibernate", dormant.state);
	const woken = await client.wake(dormant, conversationId);
	if (woken.state !== "stable") throw wakeFailure("wake", woken.state);
	dependencies.project(agentId, woken);
	return woken;
}
