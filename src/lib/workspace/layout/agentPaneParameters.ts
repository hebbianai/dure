export interface AgentPaneParameters {
	agentRef: { agentId: string } | null;
}

/** Current content, not the slot's historical spelling, owns its target. */
export function agentIdFromPane(pane: {
	id: string;
	component?: string;
	params?: unknown;
}): string | undefined {
	return pane.component === "agent"
		? agentIdFromPaneParameters(pane.params)
		: undefined;
}

/** Historical public alias and pre-reference saved-layout input only. */
export function agentIdFromAgentPanelId(panelId: string): string | undefined {
	return panelId.startsWith("agent:") && panelId.length > "agent:".length
		? panelId.slice("agent:".length)
		: undefined;
}

/** Mounted readers use only the current reference, never the slot's spelling. */
export function agentIdFromPaneParameters(value: unknown): string | undefined {
	if (value && typeof value === "object" && "agentRef" in value) {
		const ref = value.agentRef;
		return ref &&
			typeof ref === "object" &&
			"agentId" in ref &&
			typeof ref.agentId === "string" &&
			ref.agentId.length > 0
			? ref.agentId
			: undefined;
	}
	return undefined;
}
