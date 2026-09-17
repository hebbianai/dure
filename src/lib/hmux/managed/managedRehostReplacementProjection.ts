import { sameHmuxManagedGeneration } from "@/lib/hmux/identity/hmuxManagedGeneration";
import type { ManagedRehostTargetReceiptV1 } from "@/lib/hmux/managed/managedRehostTargetReceipt";
import type { HmuxSessionSummary } from "@/lib/ipc";

function projectionMatchesTarget(
	projected: HmuxSessionSummary,
	target: ManagedRehostTargetReceiptV1,
): boolean {
	return (
		projected.sessionId === target.sessionId &&
		projected.workspaceId === target.workspaceId &&
		projected.sessionClass === "managed" &&
		sameHmuxManagedGeneration(projected.stopFence, target)
	);
}

/** Prefer a matching catalog projection, but let the fenced journal receipt
 * remain authoritative while inventory catches up. */
export function projectManagedRehostReplacement(
	target: ManagedRehostTargetReceiptV1,
	projected: HmuxSessionSummary | undefined,
	targetBuildId: string | undefined,
): HmuxSessionSummary {
	if (projected && projectionMatchesTarget(projected, target)) return projected;
	return {
		sessionId: target.sessionId,
		workspaceId: target.workspaceId,
		sessionClass: "managed",
		lifecycle: "unavailable",
		health: "unprobed",
		hostBuildVersion: targetBuildId,
		clientSelection: "unavailable",
		inputAllowed: false,
		detachOnly: true,
		terminalEpoch: target.terminalEpoch,
		stopFence: {
			runnerPrincipal: target.runnerPrincipal,
			runnerInstance: target.runnerInstance,
			channelEpoch: target.channelEpoch,
			hostInstanceId: target.hostInstanceId,
			terminalEpoch: target.terminalEpoch,
		},
		outputSeq: "0",
		capabilities: [],
	};
}
