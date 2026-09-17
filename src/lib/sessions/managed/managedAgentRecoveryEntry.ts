import type { HmuxSessionSummary } from "@/lib/ipc";
import { identityErrorCode } from "@/lib/sessions/managed/conversationIdentityReadiness";
import type { HmuxPaneHealth } from "@/lib/terminal/terminalHealth";
import type { AgentActivity } from "@/types";

type ManagedAgentRecoveryPosture = "exited" | "unavailable" | "unknown";

export interface ManagedAgentRecoveryEntry {
	visible: boolean;
	posture: ManagedAgentRecoveryPosture;
}

function hasUnconfirmedHealth(metadata?: Pick<HmuxSessionSummary, "health">) {
	// A refused or unfinished observation is not evidence of a broken session.
	// Its inputAllowed=false restricts that observation, not the mounted input.
	return (
		metadata?.health === "unprobed" || metadata?.health === "generation_changed"
	);
}

export function managedAgentRecoveryHasDeadInput(
	metadata?: Pick<HmuxSessionSummary, "lifecycle" | "health">,
): boolean {
	if (hasUnconfirmedHealth(metadata)) return false;
	return (
		metadata?.lifecycle === "unavailable" ||
		metadata?.health === "stale_transport" ||
		metadata?.health === "incompatible_protocol"
	);
}

const HIDDEN_ENTRY: ManagedAgentRecoveryEntry = {
	visible: false,
	posture: "unknown",
};

/**
 * Presentation-only gate for a managed pane's recovery affordance. Exact
 * resume performs a new conversation-writer admission; this stale pane and
 * its projected Host metadata never become launch authority.
 */
export function managedAgentRecoveryEntry({
	hasAgent,
	hasBinding,
	activity,
	metadata,
	paneHealth,
	credentialSwitchTransition = false,
	inspectConfirmedExit = true,
	inspectUnknownExit = true,
}: {
	hasAgent: boolean;
	hasBinding: boolean;
	activity: AgentActivity;
	metadata?: Pick<HmuxSessionSummary, "lifecycle" | "health" | "inputAllowed"> &
		Partial<Pick<HmuxSessionSummary, "terminalEpoch" | "hostProcessAlive">>;
	paneHealth?: Pick<HmuxPaneHealth, "state" | "terminalEpoch">;
	credentialSwitchTransition?: boolean;
	inspectConfirmedExit?: boolean;
	inspectUnknownExit?: boolean;
}): ManagedAgentRecoveryEntry {
	if (!hasAgent || !hasBinding) return HIDDEN_ENTRY;
	if (credentialSwitchTransition) return HIDDEN_ENTRY;
	if (metadata?.lifecycle === "exited" || metadata?.health === "exited") {
		return inspectConfirmedExit
			? { visible: true, posture: "exited" }
			: HIDDEN_ENTRY;
	}
	if (hasUnconfirmedHealth(metadata)) return HIDDEN_ENTRY;
	// A failed census handshake is not a disconnected terminal. The existing
	// attachment owner knows whether this exact generation is still connected;
	// this presentation decision does not grant input or recovery authority.
	if (
		metadata?.health === "stale_transport" &&
		metadata.hostProcessAlive !== false &&
		paneHealth?.state === "live" &&
		metadata.terminalEpoch &&
		metadata.terminalEpoch === paneHealth.terminalEpoch
	) {
		return HIDDEN_ENTRY;
	}
	if (
		metadata?.lifecycle === "unavailable" ||
		metadata?.health === "stale_transport" ||
		metadata?.health === "incompatible_protocol" ||
		metadata?.inputAllowed === false
	) {
		return { visible: true, posture: "unavailable" };
	}
	if (activity === "exited") {
		return inspectUnknownExit
			? { visible: true, posture: "unknown" }
			: HIDDEN_ENTRY;
	}
	return HIDDEN_ENTRY;
}

/** A disconnected provider cannot refresh an invalidated conversation
 * projection. Offer a read-only provider-history picker instead of retrying
 * the same impossible live inspection. Unknown liveness still fails closed. */
export function shouldOfferDisconnectedConversationSelection(
	posture: ManagedAgentRecoveryEntry["posture"],
	error: unknown,
): boolean {
	if (posture === "unknown") return false;
	const code = identityErrorCode(error).code;
	return (
		code !== "conversation_identity_unknown" &&
		code.startsWith("conversation_identity_")
	);
}
