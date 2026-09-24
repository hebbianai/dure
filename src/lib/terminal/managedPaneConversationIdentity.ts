import { sameHmuxManagedGeneration } from "@/lib/hmux/identity/hmuxManagedGeneration";
import type { HmuxProviderConversationIdentity } from "@/lib/ipc";
import type {
	HmuxManagedPaneBindingV1,
	RemoteHmuxManagedPaneBindingV1,
	TerminalPaneBindingV1,
} from "@/lib/terminal/terminalBinding";

type ManagedPaneBinding =
	| HmuxManagedPaneBindingV1
	| RemoteHmuxManagedPaneBindingV1;

function managedBinding(
	binding: TerminalPaneBindingV1 | undefined,
): binding is ManagedPaneBinding {
	return binding?.runtime === "hmux_managed_v1";
}

function sameManagedLocus(
	current: ManagedPaneBinding,
	attached: ManagedPaneBinding,
): boolean {
	if (
		current.source !== attached.source ||
		current.hostId !== attached.hostId ||
		current.sessionId !== attached.sessionId ||
		current.workspaceId !== attached.workspaceId
	) {
		return false;
	}
	if (
		current.stopFence === undefined ||
		attached.stopFence === undefined ||
		!sameHmuxManagedGeneration(current.stopFence, attached.stopFence)
	) {
		return false;
	}
	if (current.source === "local" && attached.source === "local") {
		return (
			current.createIdempotencyKey === attached.createIdempotencyKey &&
			current.credentialId === attached.credentialId &&
			current.credentialGeneration === attached.credentialGeneration
		);
	}
	if (current.source === "ssh" && attached.source === "ssh") {
		return (
			current.createIdempotencyKey === attached.createIdempotencyKey &&
			current.commandBridgeNonce === attached.commandBridgeNonce &&
			current.credentialId === attached.credentialId &&
			current.credentialProfileDirectory === attached.credentialProfileDirectory
		);
	}
	return false;
}

function projectionMatchesLocus(
	binding: ManagedPaneBinding,
	identity: HmuxProviderConversationIdentity,
): boolean {
	const fence = binding.stopFence;
	return (
		fence !== undefined &&
		identity.sessionId === binding.sessionId &&
		identity.workspaceId === binding.workspaceId &&
		sameHmuxManagedGeneration(identity, fence)
	);
}

/** Commits a Host-owned projection only to the exact managed generation that
 * opened the structured attachment. The typed Host boundary already validated
 * the projection; this function only performs the pane-locus CAS. */
export function projectManagedPaneConversationIdentity(
	current: TerminalPaneBindingV1 | undefined,
	attached: TerminalPaneBindingV1 | undefined,
	identity: HmuxProviderConversationIdentity,
): TerminalPaneBindingV1 | undefined {
	if (
		!managedBinding(current) ||
		!managedBinding(attached) ||
		!sameManagedLocus(current, attached) ||
		!projectionMatchesLocus(current, identity) ||
		(current.conversationIdentity !== undefined &&
			projectionMatchesLocus(current, current.conversationIdentity) &&
			BigInt(identity.revision) <=
				BigInt(current.conversationIdentity.revision))
	) {
		return current;
	}
	return {
		...current,
		conversationIdentity: {
			schemaVersion: 1,
			...identity,
		},
	};
}
