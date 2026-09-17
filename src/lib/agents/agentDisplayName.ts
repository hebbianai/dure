import type { Agent } from "@/types";

const MAX_AGENT_DISPLAY_NAME_LENGTH = 120;

export function normalizeAgentDisplayName(
	canonicalName: string,
	value: unknown,
): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim().slice(0, MAX_AGENT_DISPLAY_NAME_LENGTH);
	return trimmed && trimmed !== canonicalName ? trimmed : undefined;
}

export function agentDisplayName(
	agent: Pick<Agent, "name" | "displayName">,
): string {
	return normalizeAgentDisplayName(agent.name, agent.displayName) ?? agent.name;
}
