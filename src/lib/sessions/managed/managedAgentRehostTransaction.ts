import { emit } from "@tauri-apps/api/event";
import { reconcileManagedAgentRecoveryOperation } from "@/lib/sessions/managed/managedAgentRecoveryReceipt";
import {
	type ManagedAgentRehostExecution,
	managedAgentRehostSyncPayload,
	reconcileManagedAgentRehost,
} from "@/lib/sessions/managed/managedAgentRehost";
import { managedAgentRehostDisposition } from "@/lib/sessions/managed/managedAgentRehostDisposition";
import type { ManagedAgentRehostInspection } from "@/lib/sessions/managed/managedAgentRehostInspection";
import { publishManagedAgentRehostProjection } from "@/lib/sessions/managed/managedAgentRehostPublication";
import type { ReconciledManagedAgentRehost } from "@/lib/sessions/managed/managedAgentRehostReconciliationTypes";
import {
	commitManagedAgentRehostReceipt,
	commitReconciledManagedAgentRehostReceipt,
} from "@/lib/sessions/managed/managedAgentRehostSynchronization";
import { resolveManagedAgentTarget } from "@/lib/sessions/managed/managedAgentTarget";
import {
	executeManagedAgentRecoveryRequest,
	inspectManagedAgentRecoveryRequest,
} from "@/lib/sessions/recovery/exitedManagedAgentRecovery";
import { PaneCommandError } from "@/lib/workspace/pane/paneCommandError";
import { useStore } from "@/store";

export interface ManagedAgentRehostTransactionRequest {
	name: string;
	panelId?: string;
	conversationId?: string;
	operationId?: string;
	confirmed: boolean;
}

export interface ManagedAgentRehostTransactionRuntime {
	resolveTarget: typeof resolveManagedAgentTarget;
	reconcile: typeof reconcileManagedAgentRehost;
	inspect: typeof inspectManagedAgentRecoveryRequest;
	reconcileOperation: typeof reconcileManagedAgentRecoveryOperation;
	execute: typeof executeManagedAgentRecoveryRequest;
	syncPayload: typeof managedAgentRehostSyncPayload;
	commitReceipt: typeof commitManagedAgentRehostReceipt;
	commitReconciledReceipt: typeof commitReconciledManagedAgentRehostReceipt;
	emit: typeof emit;
	setMetadata: ReturnType<typeof useStore.getState>["setHmuxSessionMetadata"];
}

const runtime: ManagedAgentRehostTransactionRuntime = {
	resolveTarget: resolveManagedAgentTarget,
	reconcile: reconcileManagedAgentRehost,
	inspect: inspectManagedAgentRecoveryRequest,
	reconcileOperation: reconcileManagedAgentRecoveryOperation,
	execute: executeManagedAgentRecoveryRequest,
	syncPayload: managedAgentRehostSyncPayload,
	commitReceipt: commitManagedAgentRehostReceipt,
	commitReconciledReceipt: commitReconciledManagedAgentRehostReceipt,
	emit,
	setMetadata: (session) => useStore.getState().setHmuxSessionMetadata(session),
};

function projectionBase(inspection: ManagedAgentRehostInspection) {
	return {
		action: inspection.plan.action,
		sourceSessionId: inspection.sourceBinding.sessionId,
		sourceWorkspaceId: inspection.sourceBinding.workspaceId,
		sourceBuildId: inspection.plan.sourceBuildId,
		...(inspection.plan.targetBuildId
			? { targetBuildId: inspection.plan.targetBuildId }
			: {}),
		conversationId: inspection.conversationId,
		replayed: false,
	} as const;
}

async function projectRecovery(
	inspection: ManagedAgentRehostInspection,
	execution: ManagedAgentRehostExecution,
	deps: ManagedAgentRehostTransactionRuntime,
	replayed = execution.recovery.receipt.replayed,
) {
	const { recovery } = execution;
	const payload = deps.syncPayload(inspection, execution);
	deps.setMetadata(recovery.replacement);
	const committed = await deps.commitReceipt(payload);
	if (committed) {
		publishManagedAgentRehostProjection(committed.payload, deps.emit);
	}
	return {
		state: "completed" as const,
		rehost: {
			action: recovery.receipt.action,
			outcome: "rehosted" as const,
			sourceSessionId: inspection.sourceBinding.sessionId,
			sourceWorkspaceId: inspection.sourceBinding.workspaceId,
			sourceBuildId: inspection.plan.sourceBuildId,
			...(recovery.receipt.targetBuildId
				? { targetBuildId: recovery.receipt.targetBuildId }
				: {}),
			conversationId: recovery.conversationId,
			replayed,
			...("stop" in execution ? { stop: execution.stop } : {}),
			replacementSession: recovery.replacement,
			presentation: committed?.presentation ?? ("pending" as const),
		},
		...(committed?.presentation === "applied" ? { pane: committed.pane } : {}),
	};
}

async function projectReconciliation(
	reconciliation: ReconciledManagedAgentRehost,
	deps: ManagedAgentRehostTransactionRuntime,
) {
	const committed = await deps.commitReconciledReceipt(reconciliation);
	publishManagedAgentRehostProjection(committed.payload, deps.emit);
	return {
		state: "completed" as const,
		rehost: {
			action:
				reconciliation.payload.launchKind === "fresh"
					? ("replace_ai_provider_with_fresh_conversation" as const)
					: ("replace_ai_provider_with_explicit_conversation" as const),
			outcome: "rehosted" as const,
			sourceSessionId: reconciliation.payload.sourceBinding.sessionId,
			sourceWorkspaceId: reconciliation.payload.sourceBinding.workspaceId,
			...((reconciliation.recovery?.receipt.targetBuildId ??
			reconciliation.replacement.hostBuildVersion)
				? {
						targetBuildId:
							reconciliation.recovery?.receipt.targetBuildId ??
							reconciliation.replacement.hostBuildVersion,
					}
				: {}),
			conversationId: reconciliation.conversationId,
			replayed: true,
			replacementSession: reconciliation.replacement,
			presentation: committed.presentation,
		},
		...(committed.presentation === "applied" ? { pane: committed.pane } : {}),
	};
}

/** One client adapter around Hmux's journaled rehost transaction. UI and CLI
 * differ only in confirmation and presentation; neither reconstructs the
 * reconcile/execute/commit sequence. */
export async function runManagedAgentRehostTransaction(
	request: ManagedAgentRehostTransactionRequest,
	deps: ManagedAgentRehostTransactionRuntime = runtime,
) {
	const target = deps.resolveTarget(request.name);
	if (!request.operationId) {
		const reconciliation = await deps.reconcile(
			target.agent.id,
			request.panelId,
		);
		if (reconciliation) return projectReconciliation(reconciliation, deps);
	}

	const inspection = await deps.inspect(
		target.agent.id,
		request.panelId,
		request.conversationId,
	);
	if (request.operationId) {
		const recovery = await deps.reconcileOperation(
			inspection.sourceBinding,
			request.operationId,
		);
		if (!recovery) {
			throw new PaneCommandError(
				"invalid_request",
				`managed Hmux rehost operation ${request.operationId} was not found`,
			);
		}
		return projectRecovery(inspection, { recovery }, deps, true);
	}

	const base = projectionBase(inspection);
	if (managedAgentRehostDisposition(inspection) === "already_current") {
		return {
			state: "completed" as const,
			rehost: { ...base, outcome: "already_current" },
			pane: {
				desktopId: inspection.desktopId,
				panelId: inspection.panelId,
				sessionId: inspection.sourceBinding.sessionId,
				workspaceId: inspection.sourceBinding.workspaceId,
				runtime: "hmux_managed_v1" as const,
				source: "local" as const,
				hostId: "local" as const,
				cwd: inspection.cwd,
				conversationId: inspection.conversationId,
			},
		};
	}
	if (!request.confirmed) {
		return {
			state: "confirmation_required" as const,
			rehost: {
				...base,
				outcome: "refused",
				requiresConfirmation: true,
			},
		};
	}

	const execution = await deps.execute(inspection);
	return projectRecovery(inspection, execution, deps);
}
