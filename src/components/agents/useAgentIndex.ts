// One agent id → Agent index per agents array, shared by every row in the
// window, so a list of n rows never runs n linear finds.
import { useStore } from "@/store";
import type { Agent } from "@/types";

let cache: { agents?: readonly Agent[]; index: ReadonlyMap<string, Agent> } = {
	index: new Map(),
};

function agentIndexOf(agents: readonly Agent[]): ReadonlyMap<string, Agent> {
	if (cache.agents !== agents) {
		cache = { agents, index: new Map(agents.map((agent) => [agent.id, agent])) };
	}
	return cache.index;
}

/** One agent by id, through the shared index. Re-renders only when that agent's record changes. */
export function useIndexedAgent(agentId: string): Agent | undefined {
	return useStore((state) => agentIndexOf(state.agents).get(agentId));
}
