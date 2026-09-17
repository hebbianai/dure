import { normalizeAgentDisplayName } from "@/lib/agents/agentDisplayName";
import { useStore } from "@/store";

/** 표시명만 바꾼다. 생성 slug, worktree, branch, session identity는 불변이다. */
export function renameAgentDisplayName(agentId: string, value: string): void {
	useStore.setState((state) => ({
		agents: state.agents.map((agent) =>
			agent.id === agentId
				? {
						...agent,
						displayName: normalizeAgentDisplayName(agent.name, value),
					}
				: agent,
		),
	}));
}
