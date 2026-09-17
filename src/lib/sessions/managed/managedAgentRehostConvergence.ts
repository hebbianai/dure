import { reconcileManagedAgentRehost } from "@/lib/sessions/managed/managedAgentRehost";
import { publishManagedAgentRehostProjection } from "@/lib/sessions/managed/managedAgentRehostPublication";
import type { ReconciledManagedAgentRehost } from "@/lib/sessions/managed/managedAgentRehostReconciliationTypes";
import {
	commitReconciledManagedAgentRehostReceipt,
	type ManagedAgentRehostCommitReceipt,
} from "@/lib/sessions/managed/managedAgentRehostSynchronization";

export interface ManagedAgentRehostConvergenceReceipt {
	readonly reconciliation: ReconciledManagedAgentRehost;
	readonly committed: ManagedAgentRehostCommitReceipt;
}

/** Converge an already-durable Hmux successor through backend and frontend
 * authority before another explicit runtime action observes its source. */
export async function convergeManagedAgentRehost(
	agentId: string,
	panelId?: string,
): Promise<ManagedAgentRehostConvergenceReceipt | null> {
	const reconciliation = await reconcileManagedAgentRehost(agentId, panelId);
	if (!reconciliation) return null;
	const committed =
		await commitReconciledManagedAgentRehostReceipt(reconciliation);
	publishManagedAgentRehostProjection(committed.payload);
	return { reconciliation, committed };
}
