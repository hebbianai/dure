import type { HmuxAgentRuntimeState } from "@/lib/ipc";
import { credentialMigrationIdentityBlock } from "@/lib/sessions/managed/conversationIdentityReadiness";
import { managedConversationId } from "@/lib/sessions/managed/managedConversationIdentity";
import type { Agent } from "@/types";

export type FreshCredentialSwitchEligibility =
	| { eligible: true }
	| {
			eligible: false;
			reason:
				| "not_local_managed"
				| "conversation_already_started"
				| "fresh_state_unverified"
				| "credential_switch_pending";
	  };

/** A local managed Agent may take the destructive fresh path only when the
 * Host proves that it is idle and has never completed a turn. A missing
 * client conversation projection is not proof that the conversation is new. */
export function freshCredentialSwitchEligibility(
	agent: Agent | undefined,
	runtime?: HmuxAgentRuntimeState,
): FreshCredentialSwitchEligibility {
	if (
		agent?.runtimeBinding?.runtime !== "hmux_managed_v1" ||
		agent.runtimeBinding.source !== "local"
	) {
		return { eligible: false, reason: "not_local_managed" };
	}
	if (managedConversationId(agent)) {
		return { eligible: false, reason: "conversation_already_started" };
	}
	if (
		runtime?.lifecycle !== "running" ||
		runtime.activity !== "waiting" ||
		runtime.turnCompletedCount !== "0"
	) {
		return {
			eligible: false,
			reason:
				runtime?.turnCompletedCount && runtime.turnCompletedCount !== "0"
					? "conversation_already_started"
					: "fresh_state_unverified",
		};
	}
	if (agent.pendingCredentialSwitch) {
		return { eligible: false, reason: "credential_switch_pending" };
	}
	return { eligible: true };
}

/** Established-session migration remains identity-gated. A source without a
 * conversation may take the journaled fresh replacement path. */
export function managedCredentialSwitchIdentityBlock(
	agent: Agent,
	runtime?: HmuxAgentRuntimeState,
) {
	const identityBlock = credentialMigrationIdentityBlock(
		managedConversationId(agent),
		agent.conversationIdentity,
	);
	if (!identityBlock) return undefined;
	return freshCredentialSwitchEligibility(agent, runtime).eligible
		? undefined
		: identityBlock;
}

/** Keeps a credential failure tied to the identity fact that actually blocked it. */
export function managedCredentialSwitchFailureMessage(
	agent: Agent | undefined,
	error: unknown,
): string {
	const failure = String(error);
	if (!agent) return failure;
	const identityBlock = managedCredentialSwitchIdentityBlock(agent);
	const reason = identityBlock?.reason;
	if (!identityBlock || !reason) return failure;
	return failure.includes(identityBlock.code)
		? reason
		: `${failure}\n\n${reason}`;
}
