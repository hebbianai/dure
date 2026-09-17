import {
	executeManagedAgentCredentialSwitch,
	type ManagedAgentCredentialSwitchInspection,
	managedAgentCredentialSwitchSyncPayload,
	reconcileManagedAgentRehost,
} from "@/lib/sessions/managed/managedAgentRehost";
import { publishManagedAgentRehostProjection } from "@/lib/sessions/managed/managedAgentRehostPublication";
import {
	commitManagedAgentRehostReceipt,
	commitReconciledManagedAgentRehostReceipt,
} from "@/lib/sessions/managed/managedAgentRehostSynchronization";
import { withManagedCredentialSwitchTransition } from "@/lib/sessions/managed/managedCredentialSwitchTransition";

interface ManagedCredentialReplacementOptions {
	activate?: boolean;
	afterCommit?: () => unknown | Promise<unknown>;
	beforeStop?: () => unknown | Promise<unknown>;
}

/** Commits one exact local Hmux credential replacement and its Agent/pane
 * projection. The deferred-switch authority supplies the final stop fence. */
export async function commitManagedCredentialReplacement(
	inspection: ManagedAgentCredentialSwitchInspection,
	options?: ManagedCredentialReplacementOptions,
): Promise<void> {
	await withManagedCredentialSwitchTransition(inspection.agentId, async () => {
		const execution = await executeManagedAgentCredentialSwitch(
			inspection,
			options?.beforeStop ? { beforeStop: options.beforeStop } : undefined,
		);
		const payload = managedAgentCredentialSwitchSyncPayload(
			inspection,
			execution,
		);
		const committed = await commitManagedAgentRehostReceipt(
			payload,
			options?.activate === false ? { activate: false } : undefined,
		);
		if (!committed) {
			throw new Error("managed credential switch receipt did not commit");
		}
		publishManagedAgentRehostProjection(committed.payload);
		await options?.afterCommit?.();
	});
}

/** Finish a durable response-loss receipt before inspecting a new source. */
export async function reconcileManagedCredentialReplacement(
	agentId: string,
	panelId: string,
) {
	const reconciliation = await reconcileManagedAgentRehost(agentId, panelId);
	if (!reconciliation) return null;
	await withManagedCredentialSwitchTransition(agentId, async () => {
		const committed =
			await commitReconciledManagedAgentRehostReceipt(reconciliation);
		publishManagedAgentRehostProjection(committed.payload);
	});
	return reconciliation;
}
