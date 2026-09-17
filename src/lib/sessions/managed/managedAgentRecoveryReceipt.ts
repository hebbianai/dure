import { PROVIDER_IDS } from "@/lib/agents/providers";
import { sameHmuxManagedGeneration } from "@/lib/hmux/identity/hmuxManagedGeneration";
import { projectManagedRehostReplacement } from "@/lib/hmux/managed/managedRehostReplacementProjection";
import {
	isManagedRehostSourceStopReceiptV1,
	isManagedRehostTargetReceiptV1,
} from "@/lib/hmux/managed/managedRehostTargetReceipt";
import { type HmuxRecoveryExecutionReceipt, hmux } from "@/lib/ipc";
import { resolveManagedRecoveryRouteAuthority } from "@/lib/sessions/managed/managedAgentRecoveryRoute";
import { ManagedRecoveryRefusedError } from "@/lib/sessions/managed/managedAgentRuntimeErrors";
import {
	type LocalManagedBinding,
	type ManagedAgentRecoveryResult,
	managedRecoveryIdentity,
} from "@/lib/sessions/managed/managedAgentRuntimeState";
import { runManagedRehostJournalOperation } from "@/lib/sessions/managed/managedRehostJournal";
import { validManagedRehostOperationId } from "@/lib/sessions/managed/managedRehostOperationId";

export function managedRecoveryResultFromReceiptForOperation(
	binding: LocalManagedBinding,
	recoveryId: string,
	receipt: HmuxRecoveryExecutionReceipt | null | undefined,
): ManagedAgentRecoveryResult {
	const receiptProvider = receipt?.replacementTarget?.providerId;
	const providerId = PROVIDER_IDS.find(
		(candidate) => candidate === receiptProvider,
	);
	if (
		receipt?.outcome !== "replaced" ||
		receipt.action !== "replace_ai_provider_with_explicit_conversation" ||
		receipt.operationId !== recoveryId ||
		receipt.sourceSessionId !== binding.sessionId ||
		!receipt.conversationId?.trim() ||
		!providerId ||
		!isManagedRehostSourceStopReceiptV1(receipt.sourceStopReceipt, {
			operationId: recoveryId,
			sessionId: binding.sessionId,
			workspaceId: binding.workspaceId,
		}) ||
		(binding.stopFence !== undefined &&
			!sameHmuxManagedGeneration(binding.stopFence, {
				runnerPrincipal: receipt.sourceStopReceipt.runnerPrincipal,
				runnerInstance: receipt.sourceStopReceipt.runnerInstance,
				channelEpoch: String(receipt.sourceStopReceipt.channelEpoch),
				hostInstanceId: receipt.sourceStopReceipt.hostInstanceId,
				terminalEpoch: receipt.sourceStopReceipt.terminalEpoch,
			})) ||
		!isManagedRehostTargetReceiptV1(receipt.replacementTarget, {
			sourceSessionId: binding.sessionId,
			workspaceId: binding.workspaceId,
		})
	) {
		throw new ManagedRecoveryRefusedError(
			receipt?.reason ?? "recovery_failed",
			{ receipt: receipt ?? undefined },
		);
	}
	const target = receipt.replacementTarget;
	const replacement = projectManagedRehostReplacement(
		target,
		receipt.replacementSession,
		receipt.targetBuildId,
	);
	return {
		providerId,
		permissionMode: target.permissionMode,
		conversationId: receipt.conversationId,
		createIdempotencyKey: target.idempotencyKey,
		credentialId: binding.credentialId,
		replacement,
		receipt,
	};
}

function managedRecoveryResultFromReceipt(
	binding: LocalManagedBinding,
	receipt: HmuxRecoveryExecutionReceipt | null | undefined,
): ManagedAgentRecoveryResult {
	return managedRecoveryResultFromReceiptForOperation(
		binding,
		managedRecoveryIdentity(binding).recoveryId,
		receipt,
	);
}

function managedRecoveryReconcileRequest(binding: LocalManagedBinding) {
	const { recoveryId } = managedRecoveryIdentity(binding);
	return {
		recoveryId,
		sessionId: binding.sessionId,
		workspaceId: binding.workspaceId,
	};
}

/** Read or continue only an already-journaled operation. Missing optional
 * Agent, conversation, credential, build, and pane metadata never participates
 * in this lookup. */
export async function reconcileManagedAgentRecovery(
	binding: LocalManagedBinding,
): Promise<ManagedAgentRecoveryResult | null> {
	const association = await resolveManagedAgentRecoveryOperation(binding);
	if (association.state === "reconcile") {
		return reconcileManagedAgentRecoveryOperation(
			binding,
			association.operationId,
		);
	}
	if (association.state === "successor_projection_required") {
		throw new ManagedRecoveryRefusedError(
			"managed_rehost_successor_projection_required",
		);
	}
	const receipt = await hmux.reconcileManagedRecovery(
		managedRecoveryReconcileRequest(binding),
	);
	return receipt ? managedRecoveryResultFromReceipt(binding, receipt) : null;
}

function exactResolutionSource(
	binding: LocalManagedBinding,
	source: { sessionId: string; workspaceId: string },
): boolean {
	return (
		source.sessionId === binding.sessionId &&
		source.workspaceId === binding.workspaceId
	);
}

type ManagedRecoveryOperationAssociation =
	| { state: "not_found" }
	| { state: "reconcile"; operationId: string }
	| { state: "successor_projection_required" };

/** Resolve the exact operation Hmux durably associated with this predecessor.
 * The completed-successor index survives receipt compaction; the legacy v3
 * deterministic id remains only a compatibility fallback when no association
 * exists. A completed multi-hop lineage belongs to the final-successor
 * projector and must never be replayed as its retired first edge. */
async function resolveManagedAgentRecoveryOperation(
	binding: LocalManagedBinding,
): Promise<ManagedRecoveryOperationAssociation> {
	const resolution = await hmux.resolveManagedRehost(
		binding.sessionId,
		binding.workspaceId,
	);
	if (resolution.state === "not_found") {
		return exactResolutionSource(binding, resolution.source)
			? { state: "not_found" }
			: { state: "successor_projection_required" };
	}
	if (resolution.state === "retry_required") {
		return exactResolutionSource(binding, resolution.source) &&
			validManagedRehostOperationId(resolution.operationId)
			? { state: "reconcile", operationId: resolution.operationId }
			: { state: "successor_projection_required" };
	}
	if (
		!exactResolutionSource(binding, resolution.sourceGeneration) ||
		(binding.stopFence !== undefined &&
			!sameHmuxManagedGeneration(
				binding.stopFence,
				resolution.sourceGeneration,
			)) ||
		resolution.operationIds.length !== 1
	) {
		return { state: "successor_projection_required" };
	}
	const operationId = resolution.operationIds[0];
	return validManagedRehostOperationId(operationId)
		? { state: "reconcile", operationId }
		: { state: "successor_projection_required" };
}

/** Replay one exact daemonless rehost operation into the existing Agent pane. */
export async function reconcileManagedAgentRecoveryOperation(
	binding: LocalManagedBinding,
	operationId: string,
): Promise<ManagedAgentRecoveryResult | null> {
	const receipt = await hmux.reconcileManagedRecovery({
		recoveryId: operationId,
		sessionId: binding.sessionId,
		workspaceId: binding.workspaceId,
	});
	if (!receipt) return null;
	const result = managedRecoveryResultFromReceiptForOperation(
		binding,
		operationId,
		receipt,
	);
	const backendRouteAuthority = await resolveManagedRecoveryRouteAuthority(
		binding,
		operationId,
	);
	return {
		...result,
		...(backendRouteAuthority ? { backendRouteAuthority } : {}),
	};
}

/** Rehost a terminal-owned managed binding. A durable operation is always
 * reconciled first. Only an absent intent crosses first admission, where the
 * Host reads its own exact create recipe and conversation identity. */
export async function executeManagedBindingRecovery(
	binding: LocalManagedBinding,
): Promise<ManagedAgentRecoveryResult> {
	const { recoveryId } = managedRecoveryIdentity(binding);
	const reconcileRequest = managedRecoveryReconcileRequest(binding);
	const receipt = await runManagedRehostJournalOperation({
		reconcile: () => hmux.reconcileManagedRecovery(reconcileRequest),
		initiate: () =>
			hmux.executeRecovery({
				recoveryId,
				kind: "managed_provider",
				sessionId: binding.sessionId,
				workspaceId: binding.workspaceId,
				conversationId: binding.conversationIdentity?.conversationId,
				adapterSupportsExplicitResume: true,
				confirmed: true,
			}),
		isCompleted: (candidate) => candidate.outcome === "replaced",
	});
	return managedRecoveryResultFromReceipt(binding, receipt);
}
