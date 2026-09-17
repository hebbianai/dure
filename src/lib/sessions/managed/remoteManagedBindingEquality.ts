import { sameHmuxManagedGeneration } from "@/lib/hmux/identity/hmuxManagedGeneration";
import type {
	RemoteHmuxManagedPaneBindingV1,
	TerminalPaneBindingV1,
} from "@/lib/terminal/terminalBinding";
import type { Agent } from "@/types";

/** True when a live pane/agent binding still names the exact remote managed
 * generation: host/session identity, launch idempotency, command bridge,
 * credential locus, and stop fence. Conversation identity is deliberately
 * excluded — it advances independently of the generation this fences. */
export function sameRemoteManagedBinding(
	left: Agent["runtimeBinding"] | TerminalPaneBindingV1,
	right: RemoteHmuxManagedPaneBindingV1,
): boolean {
	return (
		left?.runtime === "hmux_managed_v1" &&
		left.source === "ssh" &&
		left.hostId === right.hostId &&
		left.sessionId === right.sessionId &&
		left.workspaceId === right.workspaceId &&
		left.createIdempotencyKey === right.createIdempotencyKey &&
		left.commandBridgeNonce === right.commandBridgeNonce &&
		left.backendProfileId === right.backendProfileId &&
		left.credentialId === right.credentialId &&
		left.credentialProfileDirectory === right.credentialProfileDirectory &&
		sameHmuxManagedGeneration(left.stopFence, right.stopFence)
	);
}
