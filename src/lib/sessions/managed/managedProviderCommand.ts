import { providerRunCmd } from "@/lib/agents/providers";
import type { Agent } from "@/types";

/** Build one managed provider launch without guessing a credential-global
 * "last" conversation. An exact persisted identity is the only resume input;
 * otherwise a missing Host is replaced with a fresh provider conversation. */
export function managedProviderCommand(
	agent: Agent,
	commandOverride?: string,
	skipPermissions?: boolean,
): string {
	const conversationId = agent.conversationId?.trim();
	return (
		commandOverride ??
		agent.pendingCmd ??
		(conversationId
			? providerRunCmd(agent.provider, {
					convId: conversationId,
					skipPermissions,
				})
			: providerRunCmd(agent.provider, { skipPermissions }))
	);
}
