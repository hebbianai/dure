import { PaneCommandError } from "@/lib/workspace/pane/paneCommandError";
import { agentDisplayName } from "@/lib/agents/agentDisplayName";
import {
	agentInProjectNamed,
	parseAgentNameQuery,
	uniqueAgentMatch,
} from "@/lib/agents/agentNameQuery";
import {
	bindingForAgent,
	type HmuxManagedPaneBindingV1,
	type HmuxStandalonePaneBindingV1,
	type RemoteHmuxManagedPaneBindingV1,
	type RemoteHmuxStandalonePaneBindingV1,
} from "@/lib/terminal/terminalBinding";
import { useStore } from "@/store";
import type { Agent } from "@/types";

export type HmuxAgentBinding =
	| HmuxManagedPaneBindingV1
	| HmuxStandalonePaneBindingV1
	| RemoteHmuxManagedPaneBindingV1
	| RemoteHmuxStandalonePaneBindingV1;

export interface HmuxAgentTarget {
	agent: Agent;
	binding: HmuxAgentBinding;
}

export function requireHmuxAgentBinding(agent: Agent): HmuxAgentBinding {
	const binding = bindingForAgent(agent, useStore.getState().projects);
	if (
		(binding?.runtime !== "hmux_managed_v1" &&
			binding?.runtime !== "hmux_standalone_v1") ||
		(binding.source === "local" && binding.hostId !== "local") ||
		binding.sessionId !== agent.sessionId
	) {
		throw new PaneCommandError(
			"invalid_request",
			`agent ${agent.name} is not bound to a controllable Hmux session`,
		);
	}
	return binding;
}

export function resolveHmuxAgentTarget(name: string): HmuxAgentTarget {
	const agent = resolveAgentByName(name);
	return {
		agent,
		binding: requireHmuxAgentBinding(agent),
	};
}

export function resolveAgentByName(name: string): Agent {
	const { query, projectName, agentName } = parseAgentNameQuery(name);
	const state = useStore.getState();
	const matches = state.agents.filter((agent) => {
		if (
			agent.id !== query &&
			agent.sessionId !== query &&
			agent.name !== agentName &&
			agentDisplayName(agent) !== agentName
		) {
			return false;
		}
		if (!projectName || agent.id === query || agent.sessionId === query) {
			return true;
		}
		return agentInProjectNamed(agent, projectName, state.projects);
	});
	return uniqueAgentMatch(matches, "Hmux agent", query);
}
