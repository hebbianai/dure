import { effectiveAgentPermissionMode } from "@/lib/agents/agentPermissionMode";
import {
	inspectHmuxSessionsExact,
	sessionFromExactHmuxInspection,
} from "@/lib/hmux/identity/exactHmuxSessionInspection";
import { sameHmuxManagedGeneration } from "@/lib/hmux/identity/hmuxManagedGeneration";
import { projectManagedRehostReplacement } from "@/lib/hmux/managed/managedRehostReplacementProjection";
import {
	isManagedRehostSourceStopReceiptV1,
	isManagedRehostTargetReceiptV1,
} from "@/lib/hmux/managed/managedRehostTargetReceipt";
import {
	type HmuxRecoveryExecutionReceipt,
	type HmuxSessionSummary,
	hmux,
} from "@/lib/ipc";
import { observeManagedRehostLineage } from "@/lib/sessions/managed/managedAgentDurableSuccessor";
import { managedAgentFreshStartIdentity } from "@/lib/sessions/managed/managedAgentFreshStartIdentity";
import { convergeManagedAgentRehost } from "@/lib/sessions/managed/managedAgentRehostConvergence";
import {
	resolveLocalManagedAgentTarget,
	resolveManagedAgentPresentationTarget,
} from "@/lib/sessions/managed/managedAgentRehostInspection";
import { publishManagedAgentRehostProjection } from "@/lib/sessions/managed/managedAgentRehostPublication";
import type { ManagedAgentRehostSyncPayload } from "@/lib/sessions/managed/managedAgentRehostSyncContract";
import {
	commitManagedAgentRehostReceipt,
	type ManagedAgentRehostCommitReceipt,
} from "@/lib/sessions/managed/managedAgentRehostSynchronization";
import {
	MANAGED_BOOTSTRAP_GEOMETRY,
	managedCredentialAccount,
	preflightManagedAgentFreshStart,
} from "@/lib/sessions/managed/managedAgentRuntime";
import {
	type ManagedAgentTarget,
	resolveManagedAgentTarget,
} from "@/lib/sessions/managed/managedAgentTarget";
import { runManagedRehostJournalOperation } from "@/lib/sessions/managed/managedRehostJournal";
import {
	type HmuxManagedPaneBindingV1,
	hmuxManagedBinding,
} from "@/lib/terminal/terminalBinding";
import { sameTerminalEnvironment } from "@/lib/terminal/terminalEnvironmentEquality";
import { PaneCommandError } from "@/lib/workspace/pane/paneCommandError";
import { useStore } from "@/store";
import type { AccountProfile, Provider, TerminalEnvironment } from "@/types";

interface ManagedAgentFreshStartStopSource {
	sessionId: string;
	workspaceId: string;
	stopFence: HmuxManagedPaneBindingV1["stopFence"];
}

export interface ManagedAgentFreshStartInspection {
	agentId: string;
	agentName: string;
	projectId: string;
	providerId: Provider;
	sourceBinding: HmuxManagedPaneBindingV1;
	/** Chain-tip override for the stop when the durable rehost lineage
	 * resolved past the pane binding; absent when the binding is the tip. */
	stopSource?: ManagedAgentFreshStartStopSource;
	sourceDiscoveryState: "ready" | "exited" | "absent";
	/** Presentation hint only; never replacement authority. */
	sourcePaneState?: "present" | "absent";
	sourceConversationId?: string;
	cwd: string;
	desktopId: string;
	panelId: string;
	permissionMode: "default" | "bypass_approvals";
	sourceCredentialId?: string;
	targetCredentialId: string | null;
	/** Transient preflight fence only; never included in the sync payload. */
	targetAccount?: AccountProfile;
	terminalEnvironment: TerminalEnvironment;
}

export interface ManagedAgentFreshStartExecution {
	createIdempotencyKey: string;
	replacement: HmuxSessionSummary;
	receipt: HmuxRecoveryExecutionReceipt;
}

function sameManagedBinding(
	left: HmuxManagedPaneBindingV1,
	right: HmuxManagedPaneBindingV1,
): boolean {
	return (
		left.sessionId === right.sessionId &&
		left.workspaceId === right.workspaceId &&
		left.createIdempotencyKey === right.createIdempotencyKey &&
		left.backendProfileId === right.backendProfileId &&
		sameHmuxManagedGeneration(left.stopFence, right.stopFence) &&
		left.credentialId === right.credentialId &&
		left.credentialGeneration === right.credentialGeneration
	);
}

function assertFreshStartSource(
	inspection: ManagedAgentFreshStartInspection,
	target: ManagedAgentTarget,
): void {
	const state = useStore.getState();
	if (
		target.agent.id !== inspection.agentId ||
		target.agent.name !== inspection.agentName ||
		target.agent.projectId !== inspection.projectId ||
		target.agent.provider !== inspection.providerId ||
		target.agent.sessionId !== inspection.sourceBinding.sessionId ||
		!sameManagedBinding(target.binding, inspection.sourceBinding) ||
		target.agent.worktreePath !== inspection.cwd ||
		target.agent.conversationId?.trim() !== inspection.sourceConversationId ||
		(target.binding.credentialId ?? target.agent.credentialId) !==
			inspection.sourceCredentialId ||
		!sameTerminalEnvironment(
			target.agent.terminalEnv,
			inspection.terminalEnvironment,
		) ||
		effectiveAgentPermissionMode(target.agent, state.skipPermissions) !==
			inspection.permissionMode
	) {
		throw new PaneCommandError(
			"pane_changed",
			`agent ${inspection.agentName} changed before managed fresh start`,
		);
	}
}

function sameAccount(
	left: AccountProfile | undefined,
	right: AccountProfile | undefined,
): boolean {
	return (
		left?.id === right?.id &&
		left?.provider === right?.provider &&
		left?.dir === right?.dir
	);
}

function selectedAccount(
	state: ReturnType<typeof useStore.getState>,
	providerId: Provider,
	credentialId: string | null,
): AccountProfile | undefined {
	return credentialId
		? state.accounts.find(
				(account) =>
					account.id === credentialId && account.provider === providerId,
			)
		: undefined;
}

/** Read-only proof of the exact managed source generation to replace. */
/** The stop must target the durable rehost chain's tip: the broker refuses to
 * fork a resolved chain, so a pane binding the app never advanced past a
 * successor wedges every replacement (fresh start AND credential switch,
 * 2026-09-01). The pane binding itself is untouched — it remains the
 * execute-time CAS invariant. */
async function resolveFreshStartStopSource(
	binding: HmuxManagedPaneBindingV1,
): Promise<ManagedAgentFreshStartStopSource | undefined> {
	if (binding.source !== "local") return undefined;
	const lineage = await observeManagedRehostLineage(
		binding as HmuxManagedPaneBindingV1 & { source: "local" },
	).catch(() => ({ state: "not_found" }) as const);
	if (
		lineage.state !== "resolved" ||
		(lineage.currentGeneration.sessionId === binding.sessionId &&
			lineage.currentGeneration.workspaceId === binding.workspaceId)
	) {
		return undefined;
	}
	// The lineage generation carries session identity on top of the V1
	// fence; the recovery command's fence schema is exact, so only the
	// fence fields may travel.
	return {
		sessionId: lineage.currentGeneration.sessionId,
		workspaceId: lineage.currentGeneration.workspaceId,
		stopFence: {
			runnerPrincipal: lineage.currentGeneration.runnerPrincipal,
			runnerInstance: lineage.currentGeneration.runnerInstance,
			channelEpoch: lineage.currentGeneration.channelEpoch,
			hostInstanceId: lineage.currentGeneration.hostInstanceId,
			terminalEpoch: lineage.currentGeneration.terminalEpoch,
		},
	};
}

export async function inspectManagedAgentFreshStart(
	name: string,
	requestedPanelId?: string,
): Promise<ManagedAgentFreshStartInspection> {
	const initial = resolveLocalManagedAgentTarget(name);
	// A durable rehost successor must converge into the pane before a fresh
	// replacement: the broker refuses to fork a resolved chain, so inspecting
	// the original source wedged forever behind
	// hmux_managed_rehost_source_changed (2026-09-01). Convergence advances
	// the binding to the chain tip; a journal without one is a no-op.
	await convergeManagedAgentRehost(
		initial.target.agent.id,
		requestedPanelId,
	).catch(() => null);
	const { target, state, project } = resolveLocalManagedAgentTarget(name);
	const stopSource = await resolveFreshStartStopSource(target.binding);
	const [sourceResult] = await inspectHmuxSessionsExact([
		{
			sessionId: (stopSource ?? target.binding).sessionId,
			workspaceId: (stopSource ?? target.binding).workspaceId,
		},
	]);
	const source = sessionFromExactHmuxInspection(sourceResult);
	if (source) {
		if (source.sessionClass !== "managed") {
			throw new PaneCommandError(
				"pane_changed",
				"managed fresh-start source is not replaceable",
			);
		}
	}
	const presentation = await resolveManagedAgentPresentationTarget(
		target.agent,
		state,
		requestedPanelId,
	);
	const sourceCredentialId =
		target.binding.credentialId ?? target.agent.credentialId;
	return {
		agentId: target.agent.id,
		agentName: target.agent.name,
		projectId: project.id,
		providerId: target.agent.provider,
		sourceBinding: { ...target.binding },
		...(stopSource ? { stopSource } : {}),
		...presentation,
		sourceDiscoveryState: source
			? source.lifecycle === "exited" || source.health === "exited"
				? "exited"
				: "ready"
			: "absent",
		sourceConversationId: target.agent.conversationId?.trim(),
		cwd: target.agent.worktreePath,
		permissionMode: effectiveAgentPermissionMode(
			target.agent,
			state.skipPermissions,
		),
		sourceCredentialId,
		targetCredentialId: sourceCredentialId ?? null,
		targetAccount: selectedAccount(
			state,
			target.agent.provider,
			sourceCredentialId ?? null,
		),
		terminalEnvironment: { ...(target.agent.terminalEnv ?? {}) },
	};
}

/** Read-only proof of a live managed source for a fresh credential launch. */
export async function inspectFreshManagedAgentCredentialSwitch(
	name: string,
	targetCredentialId: string | null,
	requestedPanelId?: string,
): Promise<ManagedAgentFreshStartInspection> {
	const { target, state, project } = resolveLocalManagedAgentTarget(name);
	const sourceCredentialId =
		target.binding.credentialId ?? target.agent.credentialId;
	if ((sourceCredentialId ?? null) === targetCredentialId) {
		throw new PaneCommandError(
			"invalid_request",
			"credential_selection_unchanged",
		);
	}
	const targetAccount = selectedAccount(
		state,
		target.agent.provider,
		targetCredentialId,
	);
	if (targetCredentialId && !targetAccount) {
		throw new PaneCommandError(
			"invalid_request",
			"credential_reference_unavailable",
		);
	}
	const stopSource = await resolveFreshStartStopSource(target.binding);
	const [sourceResult] = await inspectHmuxSessionsExact([
		{
			sessionId: (stopSource ?? target.binding).sessionId,
			workspaceId: (stopSource ?? target.binding).workspaceId,
		},
	]);
	const source = sessionFromExactHmuxInspection(sourceResult);
	if (
		source?.sessionClass !== "managed" ||
		(source.lifecycle !== "ready" && source.health !== "stale_transport")
	) {
		throw new PaneCommandError(
			"pane_changed",
			"fresh credential switch source is not a healthy managed session",
		);
	}
	const presentation = await resolveManagedAgentPresentationTarget(
		target.agent,
		state,
		requestedPanelId,
	);
	return {
		agentId: target.agent.id,
		agentName: target.agent.name,
		projectId: project.id,
		providerId: target.agent.provider,
		sourceBinding: { ...target.binding },
		...(stopSource ? { stopSource } : {}),
		...presentation,
		sourceDiscoveryState: "ready",
		sourceConversationId: undefined,
		cwd: target.agent.worktreePath,
		permissionMode: effectiveAgentPermissionMode(
			target.agent,
			state.skipPermissions,
		),
		sourceCredentialId,
		targetCredentialId,
		targetAccount: targetAccount ? { ...targetAccount } : undefined,
		terminalEnvironment: { ...(target.agent.terminalEnv ?? {}) },
	};
}

function replacementAgent(
	inspection: ManagedAgentFreshStartInspection,
	target: ManagedAgentTarget,
) {
	const credentialId = inspection.targetCredentialId ?? undefined;
	return {
		...target.agent,
		accountId: inspection.targetCredentialId,
		credentialId,
		runtimeBinding: {
			...target.binding,
			credentialId,
			credentialGeneration:
				inspection.sourceDiscoveryState === "ready"
					? undefined
					: target.binding.credentialGeneration,
		},
	};
}

function freshStartExecutionFromReceipt(
	inspection: ManagedAgentFreshStartInspection,
	recoveryId: string,
	receipt: HmuxRecoveryExecutionReceipt,
): ManagedAgentFreshStartExecution {
	const stopSource = inspection.stopSource ?? inspection.sourceBinding;
	if (
		receipt.outcome !== "replaced" ||
		receipt.action !== "replace_ai_provider_with_fresh_conversation"
	) {
		throw new Error(
			`managed fresh start was refused: ${receipt.reason ?? "recovery_failed"}`,
		);
	}
	const receiptTarget = receipt.replacementTarget;
	if (
		receipt.operationId !== recoveryId ||
		receipt.sourceSessionId !== stopSource.sessionId ||
		receipt.conversationId !== undefined ||
		(inspection.sourceDiscoveryState === "absent" && !receipt.replayed) ||
		!isManagedRehostSourceStopReceiptV1(receipt.sourceStopReceipt, {
			operationId: recoveryId,
			sessionId: stopSource.sessionId,
			workspaceId: stopSource.workspaceId,
		}) ||
		!isManagedRehostTargetReceiptV1(receiptTarget, {
			sourceSessionId: stopSource.sessionId,
			workspaceId: stopSource.workspaceId,
			providerId: inspection.providerId,
		})
	) {
		throw new Error("managed fresh-start receipt identity mismatch");
	}
	return {
		createIdempotencyKey: receiptTarget.idempotencyKey,
		replacement: projectManagedRehostReplacement(
			receiptTarget,
			receipt.replacementSession,
			receipt.targetBuildId,
		),
		receipt,
	};
}

/** Reserve and execute one journaled fresh successor without changing the
 * pane or Agent registry. Retries of the same source+intent use one identity. */
export async function executeManagedAgentFreshStart(
	inspection: ManagedAgentFreshStartInspection,
): Promise<ManagedAgentFreshStartExecution> {
	const stopSource = inspection.stopSource ?? {
		sessionId: inspection.sourceBinding.sessionId,
		workspaceId: inspection.sourceBinding.workspaceId,
		stopFence: inspection.sourceBinding.stopFence,
	};
	if (!stopSource.stopFence) {
		throw new PaneCommandError(
			"invalid_request",
			"managed fresh start requires the persisted source generation fence",
		);
	}
	const target = resolveManagedAgentTarget(inspection.agentId);
	assertFreshStartSource(inspection, target);
	const identity = managedAgentFreshStartIdentity({
		sourceSessionId: stopSource.sessionId,
		workspaceId: stopSource.workspaceId,
		operationKey: `credential-switch:${inspection.targetCredentialId ?? "runtime-default"}`,
	});
	const reconcileRequest = {
		recoveryId: identity.recoveryId,
		sessionId: stopSource.sessionId,
		workspaceId: stopSource.workspaceId,
	};
	const reconcileCompletion = () =>
		hmux.reconcileManagedRecovery(reconcileRequest);
	const receipt = await runManagedRehostJournalOperation({
		reconcile: reconcileCompletion,
		initiate: async () => {
			const nextAgent = replacementAgent(inspection, target);
			const account = await preflightManagedAgentFreshStart(
				nextAgent,
				inspection.targetAccount,
			);
			const fencedTarget = resolveManagedAgentTarget(inspection.agentId);
			assertFreshStartSource(inspection, fencedTarget);
			const fencedReplacement = replacementAgent(inspection, fencedTarget);
			const currentAccount = managedCredentialAccount(fencedReplacement);
			if (
				!sameAccount(account, currentAccount) ||
				!sameAccount(currentAccount, inspection.targetAccount)
			) {
				throw new PaneCommandError(
					"pane_changed",
					`agent ${inspection.agentName} credential changed before managed fresh start`,
				);
			}
			return hmux.executeRecovery({
				recoveryId: identity.recoveryId,
				kind: "managed_provider_fresh",
				sessionId: stopSource.sessionId,
				workspaceId: stopSource.workspaceId,
				expectedSourceFence: stopSource.stopFence,
				adapterSupportsExplicitResume: false,
				confirmed: true,
				managedLaunch: {
					providerId: inspection.providerId,
					permissionMode: inspection.permissionMode,
					credentialId: inspection.targetCredentialId ?? undefined,
					credentialDirectory: currentAccount?.dir,
					credentialGeneration:
						fencedReplacement.runtimeBinding?.runtime === "hmux_managed_v1"
							? fencedReplacement.runtimeBinding.credentialGeneration
							: undefined,
					cwd: inspection.cwd,
					columns: MANAGED_BOOTSTRAP_GEOMETRY.columns,
					rows: MANAGED_BOOTSTRAP_GEOMETRY.rows,
					terminalEnvironment: inspection.terminalEnvironment,
				},
			});
		},
		isCompleted: (candidate) => candidate.outcome === "replaced",
	});
	return freshStartExecutionFromReceipt(
		inspection,
		identity.recoveryId,
		receipt,
	);
}

export function managedAgentFreshStartSyncPayload(
	inspection: ManagedAgentFreshStartInspection,
	execution: ManagedAgentFreshStartExecution,
): ManagedAgentRehostSyncPayload {
	const { replacement } = execution;
	const operationId = execution.receipt.operationId?.trim();
	if (
		!operationId ||
		replacement.sessionClass !== "managed" ||
		replacement.workspaceId !== inspection.sourceBinding.workspaceId ||
		!replacement.stopFence
	) {
		throw new PaneCommandError(
			"pane_changed",
			"managed fresh-start receipt lost its replacement identity",
		);
	}
	const credentialGeneration =
		inspection.sourceDiscoveryState !== "ready"
			? inspection.sourceBinding.credentialGeneration
			: undefined;
	return {
		schemaVersion: 2,
		operationId,
		launchKind: "fresh",
		permissionMode: inspection.permissionMode,
		agentId: inspection.agentId,
		agentName: inspection.agentName,
		projectId: inspection.projectId,
		providerId: inspection.providerId,
		sourceBinding: { ...inspection.sourceBinding },
		sourceConversationId: inspection.sourceConversationId ?? null,
		sourcePaneState: inspection.sourcePaneState ?? "present",
		cwd: inspection.cwd,
		conversationId: null,
		desktopId: inspection.desktopId,
		panelId: inspection.panelId,
		binding: {
			...hmuxManagedBinding(
				replacement.sessionId,
				replacement.workspaceId,
				inspection.targetCredentialId ?? undefined,
				credentialGeneration,
				replacement.stopFence,
				inspection.sourceBinding.backendProfileId,
			),
			createIdempotencyKey: execution.createIdempotencyKey,
		},
		targetCredentialId: inspection.targetCredentialId,
	};
}

/** Record the observed Host before awaiting commit or presentation. Completion
 * must not replay launch-time metadata over newer runtime observations. */
export async function completeManagedAgentFreshStart(
	inspection: ManagedAgentFreshStartInspection,
	execution: ManagedAgentFreshStartExecution,
): Promise<ManagedAgentRehostCommitReceipt> {
	const payload = managedAgentFreshStartSyncPayload(inspection, execution);
	useStore.getState().setHmuxSessionMetadata(execution.replacement);
	const committed = await commitManagedAgentRehostReceipt(payload);
	if (!committed) {
		throw new PaneCommandError(
			"pane_changed",
			`agent ${inspection.agentName} changed before managed fresh-start handoff`,
		);
	}
	publishManagedAgentRehostProjection(committed.payload);
	return committed;
}

/** Switch a ready Agent by starting a new provider process under the selected
 * credential. No conversation id is invented or inferred. */
export async function switchFreshManagedAgentCredential(
	agentId: string,
	targetCredentialId: string | null,
	panelId?: string,
): Promise<ManagedAgentRehostCommitReceipt> {
	const inspection = await inspectFreshManagedAgentCredentialSwitch(
		agentId,
		targetCredentialId,
		panelId,
	);
	const execution = await executeManagedAgentFreshStart(inspection);
	return completeManagedAgentFreshStart(inspection, execution);
}

/** Execute backend replacement, commit the Agent projection, then publish the
 * cross-WebView receipt. Pane presentation may converge after this returns. */
export async function startFreshManagedAgentPane(
	agentId: string,
	panelId: string,
): Promise<ManagedAgentRehostCommitReceipt> {
	const inspection = await inspectManagedAgentFreshStart(agentId, panelId);
	const execution = await executeManagedAgentFreshStart(inspection);
	return completeManagedAgentFreshStart(inspection, execution);
}
