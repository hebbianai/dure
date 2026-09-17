// A managed target matches only the exact session and generation, including
// its create key and stop fence.
import { sameHmuxManagedGeneration } from "@/lib/hmux/identity/hmuxManagedGeneration";
import type { HmuxManagedPaneBindingV1 } from "@/lib/terminal/terminalBinding";
import type { Agent } from "@/types";

export function sameManagedTargetRuntime(
	left: Agent["runtimeBinding"] | HmuxManagedPaneBindingV1,
	right: HmuxManagedPaneBindingV1,
): boolean {
	return (
		left?.runtime === "hmux_managed_v1" &&
		left.source === "local" &&
		left.sessionId === right.sessionId &&
		left.workspaceId === right.workspaceId &&
		left.createIdempotencyKey === right.createIdempotencyKey &&
		sameHmuxManagedGeneration(left.stopFence, right.stopFence)
	);
}
