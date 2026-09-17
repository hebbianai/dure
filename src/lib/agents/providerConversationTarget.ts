import type { ProviderConversationDetailsTarget } from "@/lib/agents/providerConversationDiscovery";
import { managedConversationId } from "@/lib/sessions/managed/managedConversationIdentity";
import type { Agent, Project } from "@/types";

export type ProviderConversationProjectLocation = Pick<
	Project,
	"kind" | "sshHostId"
>;

/** Stable exact identity shared by transcript caches and presentation joins. */
export function providerConversationTargetKey(
	target: ProviderConversationDetailsTarget,
): string {
	return JSON.stringify([
		target.provider,
		target.conversationId,
		target.executionLocation,
		target.executionLocation === "ssh" ? (target.hostId ?? "") : "local",
	]);
}

/** Resolve transcript location from durable location facts, never runtime kind. */
export function providerConversationTargetForAgent(
	agent: Agent,
	project: ProviderConversationProjectLocation | undefined,
): ProviderConversationDetailsTarget | undefined {
	const conversationId = managedConversationId(agent);
	if (!conversationId) return undefined;

	const source = agent.runtimeBinding?.source ?? project?.kind;
	if (source === "local") {
		return {
			provider: agent.provider,
			conversationId,
			executionLocation: "local",
		};
	}
	if (source !== "ssh") return undefined;

	const hostId = agent.runtimeBinding?.hostId ?? project?.sshHostId;
	if (!hostId) return undefined;
	return {
		provider: agent.provider,
		conversationId,
		executionLocation: "ssh",
		hostId,
	};
}
