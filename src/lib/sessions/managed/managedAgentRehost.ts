import { effectiveAgentPermissionMode } from "@/lib/agents/agentPermissionMode";
import { requireIndependentProviderConversationInputForAgent } from "@/lib/agents/providerConversationInputAuthority";
import {
	createManagedAgentDispatchHandoff,
	type ManagedAgentDispatchHandoffExecution,
	type ManagedAgentDispatchProjectionHandoff,
	managedAgentDispatchProjectionPayload,
} from "@/lib/sessions/managed/managedAgentDispatchHandoff";
import { reconcileManagedAgentDurableSuccessor } from "@/lib/sessions/managed/managedAgentDurableSuccessor";
import type {
	ManagedAgentCredentialSwitchInspection,
	ManagedAgentRehostInspection,
} from "@/lib/sessions/managed/managedAgentRehostInspection";
import type { ReconciledManagedAgentRehost } from "@/lib/sessions/managed/managedAgentRehostReconciliationTypes";
import type { ManagedAgentRehostSyncPayload } from "@/lib/sessions/managed/managedAgentRehostSyncContract";
import {
	executeManagedAgentRecovery,
	MANAGED_BOOTSTRAP_GEOMETRY,
	type ManagedAgentRecoveryResult,
	preflightManagedAgentRecovery,
	reconcileManagedAgentRecovery,
} from "@/lib/sessions/managed/managedAgentRuntime";
import {
	type ManagedAgentTarget,
	resolveLegacyAgentPaneTarget,
	resolveManagedAgentTarget,
} from "@/lib/sessions/managed/managedAgentTarget";
import {
	type HmuxManagedPaneBindingV1,
	hmuxManagedBinding,
	sameHmuxManagedLaunchBinding,
} from "@/lib/terminal/terminalBinding";
import { sameTerminalEnvironment } from "@/lib/terminal/terminalEnvironmentEquality";
import { PaneCommandError } from "@/lib/workspace/pane/paneCommandError";
import { useStore } from "@/store";
import type { Agent } from "@/types";

export type {
	ManagedAgentCredentialSwitchInspection,
	ManagedAgentRehostInspection,
} from "@/lib/sessions/managed/managedAgentRehostInspection";
export {
	inspectDisconnectedManagedAgentRecovery,
	inspectInterruptedManagedAgentCredentialSwitch,
	inspectManagedAgentCredentialSwitch,
	inspectManagedAgentRehost,
} from "@/lib/sessions/managed/managedAgentRehostInspection";
export type ManagedAgentRehostExecution = ManagedAgentDispatchHandoffExecution;
export type UnavailableManagedAgentRecoveryExecution =
	ManagedAgentRehostExecution;

export interface ManagedAgentRehostExecutionOptions {
	/** Explicit replacement policy; omitted preserves the inspected source mode. */
	permissionMode?: "default" | "bypass_approvals";
	/** Last frontend race gate immediately before the journaled provider stop. */
	beforeStop?: () => unknown | Promise<unknown>;
}

export type ManagedAgentCredentialSwitchExecutionOptions =
	ManagedAgentRehostExecutionOptions;

/** Drift between inspection and execution is logged, never fatal (owner
 * decision 2026-09-01): the client re-reads the current Agent before the
 * backend transaction, and the backend's stop-fence CAS is the only real
 * guard on the destructive source boundary. A fifteen-way client equality
 * wall here killed recovery for cosmetic drift (rename, cwd echo, terminal
 * env refresh) — the recovery path must recover. */
function warnWhenAgentDriftedFromInspection(
	inspection:
		| ManagedAgentRehostInspection
		| ManagedAgentCredentialSwitchInspection,
	target: ManagedAgentTarget,
) {
	const state = useStore.getState();
	const targetAccount =
		"targetCredentialId" in inspection && inspection.targetCredentialId
			? state.accounts.find(
					(account) =>
						account.id === inspection.targetCredentialId &&
						account.provider === inspection.providerId,
				)
			: undefined;
	if (
		target.agent.id !== inspection.agentId ||
		target.agent.name !== inspection.agentName ||
		target.agent.projectId !== inspection.projectId ||
		target.agent.provider !== inspection.providerId ||
		target.agent.sessionId !== inspection.sourceBinding.sessionId ||
		!sameHmuxManagedLaunchBinding(
			target.agent.runtimeBinding,
			inspection.sourceBinding,
		) ||
		target.binding.workspaceId !== inspection.sourceBinding.workspaceId ||
		target.binding.createIdempotencyKey !==
			inspection.sourceBinding.createIdempotencyKey ||
		target.binding.credentialId !== inspection.sourceBinding.credentialId ||
		target.binding.credentialGeneration !==
			inspection.sourceBinding.credentialGeneration ||
		(target.binding.credentialId ?? target.agent.credentialId) !==
			("targetCredentialId" in inspection
				? inspection.sourceCredentialId
				: inspection.credentialId) ||
		target.agent.worktreePath !== inspection.cwd ||
		target.agent.conversationId?.trim() !== inspection.sourceConversationId ||
		!sameTerminalEnvironment(
			target.agent.terminalEnv,
			inspection.terminalEnvironment,
		) ||
		effectiveAgentPermissionMode(target.agent, state.skipPermissions) !==
			inspection.permissionMode ||
		("targetCredentialId" in inspection &&
			Boolean(inspection.targetCredentialId) &&
			(!targetAccount || targetAccount.dir !== inspection.targetAccount?.dir))
	) {
		console.warn(
			`[managedRehost] agent ${inspection.agentName} drifted from its inspection — continuing with the current Agent`,
		);
	}
}

async function preflightProviderConversationInput(agent: Agent): Promise<void> {
	const state = useStore.getState();
	await requireIndependentProviderConversationInputForAgent(
		agent,
		state.projects,
		state.sshHosts,
	);
}

function explicitlySelectedRecoveryAgent(
	agent: Agent,
	conversationId: string,
	permissionMode?: "default" | "bypass_approvals",
): Agent {
	return {
		...agent,
		conversationId,
		conversationIdentity: undefined,
		...(permissionMode === undefined
			? {}
			: { skipPermissions: permissionMode === "bypass_approvals" }),
	};
}

/** Ask the backend to journal the complete replacement payload and the exact
 * source provider generation, then create/replay the successor as one
 * transaction. The Agent registry and pane remain on the source until the
 * caller commits the CAS. */
export async function executeManagedAgentRehost(
	inspection: ManagedAgentRehostInspection,
	options?: ManagedAgentRehostExecutionOptions,
): Promise<ManagedAgentRehostExecution> {
	const target = resolveManagedAgentTarget(inspection.agentId);
	const dispatchHandoff = createManagedAgentDispatchHandoff(target.agent);
	const replacementAgent = (agent: Agent): Agent =>
		explicitlySelectedRecoveryAgent(
			agent,
			inspection.conversationId,
			options?.permissionMode,
		);
	const recovery = await executeManagedAgentRecovery(target.agent, {
		columns: MANAGED_BOOTSTRAP_GEOMETRY.columns,
		rows: MANAGED_BOOTSTRAP_GEOMETRY.rows,
		confirmed: true,
		preflighted: true,
		expectedTargetBuildId: inspection.plan.targetBuildId,
		prepareFirstAdmission: async (backendRouteAuthority) => {
			warnWhenAgentDriftedFromInspection(inspection, target);
			const replacement = replacementAgent(target.agent);
			await preflightProviderConversationInput(replacement);
			await preflightManagedAgentRecovery(replacement);
			const fencedTarget = resolveManagedAgentTarget(inspection.agentId);
			warnWhenAgentDriftedFromInspection(inspection, fencedTarget);
			await dispatchHandoff.inspect(
				backendRouteAuthority,
				inspection,
				fencedTarget.agent,
			);
			await options?.beforeStop?.();
			return replacementAgent(fencedTarget.agent);
		},
	});
	return dispatchHandoff.complete(recovery);
}

/** Recover an explicitly selected disconnected session. This transaction can
 * stop a live source: automatic callers must establish Host absence or require
 * the broker's exact socket-owner-absence guard. A timeout alone is not authority. */
export async function executeUnavailableManagedAgentRecovery(
	inspection: ManagedAgentRehostInspection,
	options?: { requireSocketOwnerAbsent?: true },
): Promise<UnavailableManagedAgentRecoveryExecution> {
	const target = resolveManagedAgentTarget(inspection.agentId);
	const dispatchHandoff = createManagedAgentDispatchHandoff(target.agent);
	const replacementAgent = explicitlySelectedRecoveryAgent(
		target.agent,
		inspection.conversationId,
	);
	const recovery = await executeManagedAgentRecovery(replacementAgent, {
		columns: MANAGED_BOOTSTRAP_GEOMETRY.columns,
		rows: MANAGED_BOOTSTRAP_GEOMETRY.rows,
		confirmed: true,
		requireSocketOwnerAbsent: options?.requireSocketOwnerAbsent,
		preflighted: true,
		prepareFirstAdmission: async (backendRouteAuthority) => {
			warnWhenAgentDriftedFromInspection(inspection, target);
			await preflightProviderConversationInput(replacementAgent);
			if (target.agent.conversationIdentity !== undefined) {
				await preflightManagedAgentRecovery(replacementAgent);
			}
			const fencedTarget = resolveManagedAgentTarget(inspection.agentId);
			warnWhenAgentDriftedFromInspection(inspection, fencedTarget);
			await dispatchHandoff.inspect(
				backendRouteAuthority,
				inspection,
				fencedTarget.agent,
			);
			return explicitlySelectedRecoveryAgent(
				fencedTarget.agent,
				inspection.conversationId,
			);
		},
	});
	return dispatchHandoff.complete(recovery);
}

function credentialSwitchAgent(
	inspection: ManagedAgentCredentialSwitchInspection,
	target: ManagedAgentTarget,
): Agent {
	const credentialId = inspection.targetCredentialId ?? undefined;
	return {
		...target.agent,
		accountId: inspection.targetCredentialId,
		credentialId,
		runtimeBinding: {
			...target.binding,
			credentialId,
			credentialGeneration: undefined,
		},
	};
}

/** Preflight the target credential view while the exact source still runs,
 * then delegate journal/stop/resume to one backend transaction. The frontend
 * CAS remains a separate receipt-driven step. */
export async function executeManagedAgentCredentialSwitch(
	inspection: ManagedAgentCredentialSwitchInspection,
	options?: ManagedAgentCredentialSwitchExecutionOptions,
): Promise<ManagedAgentRehostExecution> {
	const target = resolveManagedAgentTarget(inspection.agentId);
	const dispatchHandoff = createManagedAgentDispatchHandoff(target.agent);
	const replacementAgent = credentialSwitchAgent(inspection, target);
	const recovery = await executeManagedAgentRecovery(replacementAgent, {
		columns: MANAGED_BOOTSTRAP_GEOMETRY.columns,
		rows: MANAGED_BOOTSTRAP_GEOMETRY.rows,
		confirmed: true,
		credentialAccount: inspection.targetAccount,
		preflighted: true,
		prepareFirstAdmission: async (backendRouteAuthority) => {
			warnWhenAgentDriftedFromInspection(inspection, target);
			await preflightProviderConversationInput(replacementAgent);
			await preflightManagedAgentRecovery(
				replacementAgent,
				inspection.targetAccount,
			);
			const fencedTarget = resolveManagedAgentTarget(inspection.agentId);
			warnWhenAgentDriftedFromInspection(inspection, fencedTarget);
			await dispatchHandoff.inspect(
				backendRouteAuthority,
				inspection,
				fencedTarget.agent,
			);
			await options?.beforeStop?.();
			return credentialSwitchAgent(inspection, fencedTarget);
		},
	});
	return dispatchHandoff.complete(recovery);
}

export function managedAgentRehostSyncPayload(
	inspection:
		| ManagedAgentRehostInspection
		| ManagedAgentCredentialSwitchInspection,
	execution:
		| ManagedAgentRehostExecution
		| UnavailableManagedAgentRecoveryExecution,
): ManagedAgentRehostSyncPayload {
	const { replacement, createIdempotencyKey, conversationId, credentialId } =
		execution.recovery;
	const operationId = execution.recovery.receipt.operationId?.trim();
	if (
		!operationId ||
		replacement.sessionClass !== "managed" ||
		replacement.workspaceId !== inspection.sourceBinding.workspaceId ||
		!replacement.stopFence
	) {
		throw new PaneCommandError(
			"pane_changed",
			"managed Hmux rehost receipt lost exact replacement identity",
		);
	}
	return {
		schemaVersion: 2,
		operationId,
		launchKind: "exact_resume",
		agentId: inspection.agentId,
		agentName: inspection.agentName,
		projectId: inspection.projectId,
		providerId: execution.recovery.providerId ?? inspection.providerId,
		sourceBinding: { ...inspection.sourceBinding },
		sourceConversationId: inspection.sourceConversationId ?? null,
		...(execution.recovery.backendRouteAuthority
			? { backendRouteAuthority: execution.recovery.backendRouteAuthority }
			: {}),
		sourcePaneState: inspection.sourcePaneState ?? "present",
		sourcePermissionMode: inspection.permissionMode,
		cwd: inspection.cwd,
		conversationId,
		permissionMode: execution.recovery.permissionMode,
		desktopId: inspection.desktopId,
		panelId: inspection.panelId,
		binding: {
			...hmuxManagedBinding(
				replacement.sessionId,
				replacement.workspaceId,
				credentialId,
				undefined,
				replacement.stopFence,
				inspection.sourceBinding.backendProfileId,
			),
			createIdempotencyKey,
		},
		...managedAgentDispatchProjectionPayload(execution.dispatchProjection),
		targetCredentialId: credentialId ?? null,
	};
}

export function managedRebootRecoverySyncPayload(
	agent: Agent,
	sourceBinding: HmuxManagedPaneBindingV1,
	recovery: ManagedAgentRecoveryResult,
	desktopId: string,
	panelId: string,
	dispatchProjection?: ManagedAgentDispatchProjectionHandoff,
): ManagedAgentRehostSyncPayload {
	const operationId = recovery.receipt.operationId?.trim();
	if (
		!operationId ||
		agent.runtimeBinding?.runtime !== "hmux_managed_v1" ||
		agent.runtimeBinding.sessionId !== sourceBinding.sessionId ||
		agent.runtimeBinding.workspaceId !== sourceBinding.workspaceId ||
		recovery.replacement.sessionClass !== "managed" ||
		recovery.replacement.workspaceId !== sourceBinding.workspaceId ||
		!recovery.replacement.stopFence
	) {
		throw new PaneCommandError(
			"pane_changed",
			"managed reboot recovery lost its exact source or replacement binding",
		);
	}
	return {
		schemaVersion: 2,
		operationId,
		launchKind: "exact_resume",
		agentId: agent.id,
		agentName: agent.name,
		projectId: agent.projectId,
		providerId: recovery.providerId ?? agent.provider,
		sourceBinding: { ...sourceBinding },
		sourceConversationId: recovery.conversationId,
		...(recovery.backendRouteAuthority
			? { backendRouteAuthority: recovery.backendRouteAuthority }
			: {}),
		cwd: agent.worktreePath,
		conversationId: recovery.conversationId,
		permissionMode: recovery.permissionMode,
		desktopId,
		panelId,
		binding: {
			...hmuxManagedBinding(
				recovery.replacement.sessionId,
				recovery.replacement.workspaceId,
				recovery.credentialId,
				undefined,
				recovery.replacement.stopFence,
				sourceBinding.backendProfileId,
			),
			createIdempotencyKey: recovery.createIdempotencyKey,
		},
		...managedAgentDispatchProjectionPayload(dispatchProjection),
		targetCredentialId: recovery.credentialId ?? null,
	};
}

/** Repair a journaled exact-resume before reading optional Agent/UI metadata.
 * An absent intent is a normal non-destructive result; callers may then run
 * the first-admission inspection and confirmation flow. */
export async function reconcileManagedAgentRehost(
	agentId: string,
	requestedPanelId?: string,
): Promise<ReconciledManagedAgentRehost | null> {
	const state = useStore.getState();
	const agent = state.agents.find((candidate) => candidate.id === agentId);
	if (!agent) return null;
	const sourceBinding = agent.runtimeBinding;
	if (
		sourceBinding?.runtime !== "hmux_managed_v1" ||
		sourceBinding.source !== "local" ||
		sourceBinding.sessionId !== agent.sessionId
	) {
		return null;
	}
	// Receipt compatibility only; a replay does not readmit its old pane hint.
	const panelId = requestedPanelId ?? resolveLegacyAgentPaneTarget(agent).panelId;
	const durableSuccessor = await reconcileManagedAgentDurableSuccessor(
		agent,
		state.activeSpaceId ?? "detached",
		panelId,
		state.skipPermissions,
	);
	if (durableSuccessor) return durableSuccessor;
	const recovery = await reconcileManagedAgentRecovery(sourceBinding);
	if (!recovery) return null;
	const execution =
		await createManagedAgentDispatchHandoff(agent).reconcile(recovery);
	const payload = managedRebootRecoverySyncPayload(
		agent,
		sourceBinding,
		recovery,
		state.activeSpaceId ?? "detached",
		panelId,
		execution.dispatchProjection,
	);
	return {
		recovery,
		payload,
		replacement: recovery.replacement,
		conversationId: recovery.conversationId,
	};
}

export function managedAgentCredentialSwitchSyncPayload(
	inspection: ManagedAgentCredentialSwitchInspection,
	execution: ManagedAgentRehostExecution,
): ManagedAgentRehostSyncPayload {
	return managedAgentRehostSyncPayload(inspection, execution);
}
