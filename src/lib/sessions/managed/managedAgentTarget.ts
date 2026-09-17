import { PaneCommandError } from "@/lib/workspace/pane/paneCommandError";
import {
	bindingForAgent,
	type HmuxManagedPaneBindingV1,
	type RemoteHmuxManagedPaneBindingV1,
} from "@/lib/terminal/terminalBinding";
import {
	requireHmuxAgentBinding,
	resolveAgentByName,
} from "@/lib/hmux/identity/hmuxAgentTarget";
import type { Agent } from "@/types";
import { useStore } from "@/store";

export interface ManagedAgentTarget {
	agent: Agent;
	binding: HmuxManagedPaneBindingV1;
}

function requireManagedAgentBinding(agent: Agent): HmuxManagedPaneBindingV1 {
	const binding = requireHmuxAgentBinding(agent);
	if (binding.runtime !== "hmux_managed_v1" || binding.source !== "local") {
		throw new PaneCommandError(
			"invalid_request",
			`agent ${agent.name} is not bound to a managed Hmux session`,
		);
	}
	return binding;
}

export function requireAnyManagedAgentBinding(
	agent: Agent,
): HmuxManagedPaneBindingV1 | RemoteHmuxManagedPaneBindingV1 {
	const binding = bindingForAgent(agent, useStore.getState().projects);
	if (
		binding?.runtime !== "hmux_managed_v1" ||
		binding.sessionId !== agent.sessionId
	) {
		throw new PaneCommandError(
			"invalid_request",
			`agent ${agent.name} is not bound to a managed Hmux session`,
		);
	}
	return binding;
}

export function resolveManagedAgentTarget(name: string): ManagedAgentTarget {
	const agent = resolveAgentByName(name);
	return {
		agent,
		binding: requireManagedAgentBinding(agent),
	};
}

/** Compatibility for callers that still return or constrain the historical
 * pane alias. This is not a pane observation or runtime identity. */
export function resolveLegacyAgentPaneTarget(
	name: string | Agent,
	targetPanelId?: string,
): { agent: Agent; panelId: string } {
	const agent = typeof name === "string" ? resolveAgentByName(name) : name;
	const panelId = `agent:${agent.id}`;
	if (targetPanelId && targetPanelId !== panelId) {
		throw new PaneCommandError(
			"pane_changed",
			`targetPanelId must be ${panelId} for ${agent.name}`,
		);
	}
	return { agent, panelId };
}
