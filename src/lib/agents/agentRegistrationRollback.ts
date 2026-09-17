import { removeAgentProjectionDurably } from "@/lib/agents/durableAgentRemoval";
import { sameAgentOperationalIdentity } from "@/lib/agents/resourceOperationalIdentity";
import type { Agent } from "@/types";

export interface LaunchAgentRegistrationEvidence {
	readonly conversationId: Agent["conversationId"];
	readonly conversationIdentity: Agent["conversationIdentity"];
}

export function launchAgentRegistrationEvidence(
	agent: Agent,
): LaunchAgentRegistrationEvidence {
	return {
		conversationId: agent.conversationId,
		conversationIdentity: agent.conversationIdentity
			? { ...agent.conversationIdentity }
			: undefined,
	};
}

function sameConversationIdentityEvidence(
	current: Agent["conversationIdentity"],
	expected: Agent["conversationIdentity"],
): boolean {
	if (!current || !expected) return current === expected;
	if (current.state !== expected.state) return false;
	if (current.state === "ready" && expected.state === "ready") {
		return current.conversationId === expected.conversationId;
	}
	if (current.state === "ready" || expected.state === "ready") return false;
	return current.code === expected.code && current.detail === expected.detail;
}

/** Undo only the exact Agent registration created by a failed launch. */
export function rollbackCreatedAgentRegistration(
	registration: Agent,
	launchEvidence?: LaunchAgentRegistrationEvidence,
): Promise<boolean> {
	return removeAgentProjectionDurably({
		agents: [
			{
				agentId: registration.id,
				panelIds: [`agent:${registration.id}`],
				sessionIds: [registration.sessionId],
				applies: (current) =>
					sameAgentOperationalIdentity(current, registration) &&
					(!launchEvidence ||
						(current.conversationId === launchEvidence.conversationId &&
							sameConversationIdentityEvidence(
								current.conversationIdentity,
								launchEvidence.conversationIdentity,
							))),
			},
		],
	});
}
