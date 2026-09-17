import type { Agent } from "@/types";

/** Returns an Agent source when its managed runtime uses the Native CLI.
 * Backend-owned Native Agents share this journaled rehost workflow; a
 * structured interaction owns a separate runtime transition. */
export function managedAgentBuildRehostSource(
	agent: Agent | undefined,
): string | undefined {
	if (
		!agent ||
		agent.interactionProfile?.kind === "structured_protocol" ||
		agent.runtimeBinding?.runtime !== "hmux_managed_v1"
	) {
		return undefined;
	}
	return agent.id;
}
