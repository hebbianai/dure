import {
	sameAgentOperationalIdentity,
	sameProjectOperationalIdentity,
} from "@/lib/agents/resourceOperationalIdentity";
import {
	normalizePersistedState,
	persistedSlice,
} from "@/lib/persistence/persistedAppState";
import {
	DURABLE_APP_STORE_NAME,
	durableAppStorage,
	PERSIST_VERSION,
	useStore,
} from "@/store";
import type { Agent, Project } from "@/types";

/** Commit against the latest registry before exposing a launchable agent. */
export async function registerAgentDurably(
	agent: Agent,
	project: Project,
): Promise<Agent> {
	const refusal = await durableAppStorage.transact(
		DURABLE_APP_STORE_NAME,
		(current) => {
			const state = normalizePersistedState(current?.state ?? {});
			if (
				!sameProjectOperationalIdentity(
					state.projects.find((value) => value.id === project.id),
					project,
				)
			)
				return { value: current, result: "Agent registration project changed" };
			if (state.agents.some((value) => value.id === agent.id)) {
				return { value: current, result: "Agent registration already exists" };
			}
			return {
				value: {
					version: PERSIST_VERSION,
					state: persistedSlice({
						...state,
						agents: [...state.agents, agent],
						stats: {
							...state.stats,
							agentsStarted: state.stats.agentsStarted + 1,
						},
					}),
				},
				result: "",
			};
		},
	);
	if (refusal) throw new Error(refusal);
	const { recoverCurrentDurableStoreProjection } = await import(
		"@/lib/persistence/currentDurableProjectionRecovery"
	);
	if (!(await recoverCurrentDurableStoreProjection())) {
		throw new Error("Agent registration projection failed");
	}
	const state = useStore.getState();
	const registered = state.agents.find((value) => value.id === agent.id);
	if (
		!registered ||
		!sameAgentOperationalIdentity(registered, agent) ||
		!sameProjectOperationalIdentity(
			state.projects.find((value) => value.id === project.id),
			project,
		)
	)
		throw new Error("Agent registration changed before launch");
	return registered;
}
