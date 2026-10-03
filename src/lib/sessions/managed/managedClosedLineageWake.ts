import { agentRuntimeTransitionRoute } from "@/lib/agents/agentRuntimeProfileSwitch";
import { projectAgentRuntimeTransition } from "@/lib/agents/agentRuntimeStoreProjector";
import {
	createDureAgentRuntimeClient,
	type DureAgentRuntimeProjectionInspectResultV1,
} from "@/lib/ipc/dureAgentRuntime";
import type { DureAgentRuntimeObservationClient } from "@/lib/ipc/dureAgentRuntimeObservationClient";
import { useStore } from "@/store";
import { wakeManagedRuntime } from "../../../../cli/lib/managed-runtime-recovery.mjs";

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

/** Start the exact conversation on a new runtime root through the backend's
 * own hibernate→wake transition, or wake its already dormant source, then
 * project the committed selection. CLI and desktop share the same workflow.
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
	const woken =
		await wakeManagedRuntime<DureAgentRuntimeProjectionInspectResultV1>(
			source,
			{
				hibernate: (selected) =>
					client.hibernate({
						agentId,
						expectedSourceRevision: selected.selectionRevision,
						routeAuthority: selected.routeAuthority,
					}),
				wake: (dormant) => client.wake(dormant, conversationId),
			},
		);
	dependencies.project(agentId, woken);
	return woken;
}
