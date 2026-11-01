import type { HmuxSessionSummary } from "@/lib/ipc";
import { identityErrorCode } from "@/lib/sessions/managed/conversationIdentityReadiness";
import type { HmuxPaneHealth } from "@/lib/terminal/terminalHealth";
import type { AgentActivity } from "@/types";

/** `reconnecting` is a census that could not reach a Host nobody has seen die:
 * the pane waits quietly with Refresh at hand and never offers replacement. */
type ManagedAgentRecoveryPosture =
	| "exited"
	| "unavailable"
	| "reconnecting"
	| "unknown";

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

/** The census projects `lifecycle: unavailable`, `health: stale_transport` and
 * `inputAllowed: false` together when its bounded handshake to the Host fails
 * (hub restart, overloaded host, failed census). Every one of those fields
 * describes the failed observation, so none is evidence about the Host. */
function hasTransportFailure(
	metadata?: Pick<HmuxSessionSummary, "lifecycle" | "health">,
) {
	return (
		metadata?.health === "stale_transport" ||
		metadata?.lifecycle === "unavailable"
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

const UNAVAILABLE_ENTRY: ManagedAgentRecoveryEntry = {
	visible: true,
	posture: "unavailable",
};

const RECONNECTING_ENTRY: ManagedAgentRecoveryEntry = {
	visible: true,
	posture: "reconnecting",
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
		Partial<Pick<HmuxSessionSummary, "hostProcessAlive">>;
	paneHealth?: Pick<HmuxPaneHealth, "state">;
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
	// A live Host that rejected this client's protocol refuses input on its own
	// account; only a replacement Host can serve the pane.
	if (metadata?.health === "incompatible_protocol") return UNAVAILABLE_ENTRY;
	if (hasTransportFailure(metadata)) {
		// An exit the pane itself observed outranks a census that cannot see past
		// its failed handshake; the exit postures below decide.
		if (activity !== "exited") {
			// An unreachable runtime is not proof that its processes exited. The
			// exact attachment owner knows whether this pane is still connected,
			// whatever terminal epoch it reports: a streaming pane has nothing to
			// recover and a disconnected or unobserved one waits for the Host.
			// Only a Host the backend confirmed dead, with no live attachment left
			// to contradict it, may offer replacement. This presentation decision
			// grants neither input nor recovery authority.
			const paneLive = paneHealth?.state === "live";
			if (metadata?.hostProcessAlive === false) {
				return paneLive ? RECONNECTING_ENTRY : UNAVAILABLE_ENTRY;
			}
			return paneLive ? HIDDEN_ENTRY : RECONNECTING_ENTRY;
		}
	} else if (metadata?.inputAllowed === false) {
		// A reachable Host that bridges no live input (a version-matched
		// read-only client) truly refuses the pane's input.
		return UNAVAILABLE_ENTRY;
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
	if (posture === "unknown" || posture === "reconnecting") return false;
	const code = identityErrorCode(error).code;
	return (
		code !== "conversation_identity_unknown" &&
		code.startsWith("conversation_identity_")
	);
}
