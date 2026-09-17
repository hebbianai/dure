import { agentRuntimeTransitionStatePatch } from "@/lib/agents/agentRuntimeStoreProjection";
import type { AgentExecutionProfileV1 } from "@/lib/agents/chat/agentConversationContract";
import type { DureAgentRuntimeTransitionResultV1 } from "@/lib/ipc/dureAgentRuntime";
import type { DureBackendRouteAuthorityV1 } from "@/lib/ipc/dureBackendRoute";
import { commitManagedAgentCheckpointBinding } from "@/lib/sessions/managed/managedAgentCheckpointBinding";
import { managedAgentDispatchProjectionPatch } from "@/lib/sessions/managed/managedAgentDispatchHandoff";
import {
	commitManagedAgentNativeRehost,
	commitManagedAgentNativeResume,
} from "@/lib/sessions/managed/managedAgentRehostCommit";
import type { ReconciledManagedAgentRehost } from "@/lib/sessions/managed/managedAgentRehostReconciliationTypes";
import {
	type ManagedAgentRehostSyncPayload,
	parseManagedAgentRehostSyncPayload,
	resolveManagedAgentRehostRouteAuthority,
} from "@/lib/sessions/managed/managedAgentRehostSyncContract";
import { sameManagedTargetRuntime } from "@/lib/sessions/managed/managedRuntimeIdentity";
import { resolvePaneById } from "@/lib/workspace/dock";
import { findAgentPanel } from "@/lib/workspace/dock/dockPanelParameters";
import { PaneCommandError } from "@/lib/workspace/pane/paneCommandError";
import { useStore } from "@/store";
import type { Agent } from "@/types";

export { MANAGED_AGENT_REHOSTED_EVENT } from "@/lib/sessions/managed/managedAgentRehostSyncContract";

export interface ManagedAgentRehostCommitOptions {
	/** Manual recovery selects its pane; unattended off-screen rehost must not. */
	activate?: boolean;
}

export interface ManagedAgentRehostPaneReceipt {
	desktopId: string;
	panelId: string;
	sessionId: string;
	workspaceId: string;
	runtime: "hmux_managed_v1";
	source: "local";
	hostId: "local";
	cwd: string;
	conversationId?: string;
}

interface ManagedAgentRehostCommitReceiptBase {
	/** Whether this WebView installed the committed Agent projection. */
	projection: "applied" | "pending";
	payload: ManagedAgentRehostSyncPayload;
}

/** A backend receipt is committed independently from its optional Dockview
 * presentation. `pending` never rolls the runtime transaction back. */
export type ManagedAgentRehostCommitReceipt =
	| (ManagedAgentRehostCommitReceiptBase & {
			presentation: "applied";
			pane: ManagedAgentRehostPaneReceipt;
	  })
	| (ManagedAgentRehostCommitReceiptBase & {
			presentation: "pending";
			pane: null;
	  });

/** Materialize the exact backend route and CP-owned launch projection once.
 * Hmux provider launch references never enter the canonical credential field. */
export function committedManagedAgentRehostPayload(
	payload: ManagedAgentRehostSyncPayload,
	routeAuthority: DureBackendRouteAuthorityV1,
	backendReceipt: DureAgentRuntimeTransitionResultV1 | undefined,
): ManagedAgentRehostSyncPayload {
	const providerConversationRef = backendReceipt?.providerConversationRef;
	const conversationId =
		payload.launchKind !== "fresh" ||
		providerConversationRef === undefined ||
		providerConversationRef === null ||
		payload.conversationId === providerConversationRef
			? payload.conversationId
			: providerConversationRef;
	if (!backendReceipt) {
		return {
			...payload,
			backendRouteAuthority: routeAuthority,
			conversationId,
		};
	}
	const targetCredentialId =
		backendReceipt.executionProfile.kind === "credential_reference"
			? backendReceipt.executionProfile.reference_id
			: null;
	const {
		credentialId: _credentialId,
		credentialGeneration: _credentialGeneration,
		...uncredentialedBinding
	} = payload.binding;
	return {
		...payload,
		backendRouteAuthority: routeAuthority,
		conversationId,
		targetCredentialId,
		binding:
			targetCredentialId === null
				? uncredentialedBinding
				: { ...uncredentialedBinding, credentialId: targetCredentialId },
	};
}

function appliedManagedAgentRehostCommitReceipt(
	payload: ManagedAgentRehostSyncPayload,
	desktopId = payload.desktopId,
	cwd = payload.cwd,
): ManagedAgentRehostCommitReceipt {
	return {
		projection: "applied",
		presentation: "applied",
		pane: {
			desktopId,
			panelId: payload.panelId,
			sessionId: payload.binding.sessionId,
			workspaceId: payload.binding.workspaceId,
			runtime: "hmux_managed_v1",
			source: "local",
			hostId: "local",
			cwd,
			...(payload.conversationId
				? { conversationId: payload.conversationId }
				: {}),
		},
		payload,
	};
}

function pendingManagedAgentRehostCommitReceipt(
	payload: ManagedAgentRehostSyncPayload,
	projection: "applied" | "pending",
): ManagedAgentRehostCommitReceipt {
	return { projection, presentation: "pending", pane: null, payload };
}

/** Presentation completion is separate from backend commit authority. */
function agentProjectsManagedRehostTarget(
	agent: Agent,
	payload: ManagedAgentRehostSyncPayload,
): boolean {
	const conversationId = agent.conversationId?.trim() ?? null;
	const targetConversationMatches =
		(payload.launchKind === "fresh" && payload.conversationId === null) ||
		conversationId === payload.conversationId;
	return (
		agent.sessionId === payload.binding.sessionId &&
		targetConversationMatches &&
		sameManagedTargetRuntime(agent.runtimeBinding, payload.binding)
	);
}

/** Project the active commit's receipt, never a historical notification.
 * Peer windows recover the current durable projection through startWindowSync. */
export function applyCommittedManagedAgentRehostProjection(
	payload: ManagedAgentRehostSyncPayload,
	backendReceipt?: DureAgentRuntimeTransitionResultV1,
): boolean {
	// Ready proves the selected launch credential, not a registry generation.
	// Project that selection with its Host once; backend bookkeeping is not a
	// second source of current pane state.
	const credentialId =
		payload.targetCredentialId ?? payload.binding.credentialId;
	const resumeProfile: AgentExecutionProfileV1 | undefined =
		payload.launchKind !== "resume_new_host"
			? undefined
			: credentialId
				? {
						kind: "credential_reference",
						reference_id: credentialId,
						credential_generation: null,
					}
				: { kind: "provider_default" };
	let applied = false;
	const permissionMode = backendReceipt?.launchSelection.permissionMode;
	useStore.setState((current) => {
		const currentAgent = current.agents.find(
			(candidate) => candidate.id === payload.agentId,
		);
		// Client source drift is not a launch veto; the backend owns the commit.
		if (!currentAgent) return current;
		const generationInstalled =
			currentAgent.sessionId === payload.binding.sessionId &&
			sameManagedTargetRuntime(currentAgent.runtimeBinding, payload.binding);
		// Ready initializes a Host once; replay is not a new snapshot of provider
		// metadata or user intent that changed after this generation was installed.
		if (payload.launchKind === "resume_new_host" && generationInstalled) {
			applied = true;
			return current;
		}
		const projected: Agent = {
			...currentAgent,
			provider: payload.providerId,
			executionProfile:
				backendReceipt?.executionProfile ??
				resumeProfile ??
				currentAgent.executionProfile,
			sessionId: payload.binding.sessionId,
			runtimeBinding: payload.binding,
			conversationId: payload.conversationId ?? undefined,
			...managedAgentDispatchProjectionPatch(payload.dispatchProjection),
			...(permissionMode !== undefined || payload.permissionMode !== undefined
				? {
						skipPermissions:
							permissionMode !== undefined
								? permissionMode === "skip_permissions"
								: payload.permissionMode === "bypass_approvals",
					}
				: {}),
			started: true,
			pendingCredentialSwitch: undefined,
			...(payload.targetCredentialId !== undefined
				? {
						accountId: payload.targetCredentialId,
						credentialId: payload.targetCredentialId ?? undefined,
					}
				: {}),
			// The receipt proves the provider already launched; remount
			// must attach it rather than replay its immutable create.
			pendingCmd: undefined,
		};
		if (backendReceipt) {
			const patch = agentRuntimeTransitionStatePatch(
				current,
				currentAgent,
				projected,
				backendReceipt,
			);
			applied =
				!!patch.agents ||
				agentProjectsManagedRehostTarget(currentAgent, payload);
			return patch.agents ? patch : current;
		}
		applied = true;
		const sessionCwd = { ...current.sessionCwd };
		delete sessionCwd[payload.sourceBinding.sessionId];
		sessionCwd[payload.binding.sessionId] =
			currentAgent.worktreePath ?? payload.cwd;
		return {
			agents: current.agents.map((agent) =>
				agent.id === payload.agentId ? projected : agent,
			),
			...(!generationInstalled
				? {
						agentActivity: {
							...current.agentActivity,
							[payload.agentId]: "connecting" as const,
						},
					}
				: {}),
			sessionCwd,
		};
	});
	return applied;
}

function hasCommittedManagedAgentProjection(
	payload: ManagedAgentRehostSyncPayload,
): boolean {
	const agent = useStore
		.getState()
		.agents.find((candidate) => candidate.id === payload.agentId);
	return agent ? agentProjectsManagedRehostTarget(agent, payload) : false;
}

async function projectManagedAgentRehostReceipt(
	payload: ManagedAgentRehostSyncPayload,
	options?: ManagedAgentRehostCommitOptions,
	backendReceipt?: DureAgentRuntimeTransitionResultV1,
): Promise<ManagedAgentRehostCommitReceipt> {
	let agentApplied = false;
	try {
		agentApplied = applyCommittedManagedAgentRehostProjection(
			payload,
			backendReceipt,
		);
	} catch {
		agentApplied = hasCommittedManagedAgentProjection(payload);
	}
	if (!agentApplied) {
		return pendingManagedAgentRehostCommitReceipt(payload, "pending");
	}

	const resolved = await resolvePaneById(payload.panelId).catch(() => null);
	if (!hasCommittedManagedAgentProjection(payload)) {
		return pendingManagedAgentRehostCommitReceipt(payload, "pending");
	}
	if (!resolved) {
		return pendingManagedAgentRehostCommitReceipt(payload, "applied");
	}
	let livePanel: ReturnType<typeof resolved.api.getPanel>;
	try {
		livePanel = resolved.api.getPanel(payload.panelId);
		if (!livePanel || !findAgentPanel({ panels: [livePanel] }, payload.agentId)) {
			return pendingManagedAgentRehostCommitReceipt(payload, "applied");
		}
	} catch {
		return pendingManagedAgentRehostCommitReceipt(payload, "applied");
	}
	try {
		if (options?.activate !== false) livePanel.api.setActive();
		useStore.getState().saveLayout(resolved.desktopId, resolved.api.toJSON());
	} catch {
		// Presentation activation/persistence can converge after the commit.
	}
	return appliedManagedAgentRehostCommitReceipt(
		payload,
		resolved.desktopId,
		payload.cwd,
	);
}

async function convergeManagedAgentNativeResumeBackend(
	payload: ManagedAgentRehostSyncPayload,
): Promise<void> {
	const routeAuthority = await resolveManagedAgentRehostRouteAuthority(payload);
	if (!routeAuthority) return;
	const backendReceipt = await commitManagedAgentNativeResume(
		payload,
		routeAuthority,
		{ accounts: useStore.getState().accounts },
	);
	if (!backendReceipt) {
		await commitManagedAgentCheckpointBinding(
			routeAuthority,
			payload.agentId,
			payload.binding,
		);
	}
}

/** Commit one backend receipt and its Agent projection before consulting
 * Dockview. A missing presentation is a retryable projection outcome, never
 * replacement authority and never a transaction failure. */
export async function commitManagedAgentRehostReceipt(
	value: unknown,
	options?: ManagedAgentRehostCommitOptions,
): Promise<ManagedAgentRehostCommitReceipt | null> {
	const payload = parseManagedAgentRehostSyncPayload(value);
	if (!payload) return null;
	if (payload.launchKind === "resume_new_host") {
		// A Ready Hmux receipt is the Resume success authority. Install it before
		// starting any replaceable backend bookkeeping, and never let a missing
		// local Agent/pane projection turn a running Host back into a failure.
		const projected = projectManagedAgentRehostReceipt(payload, options);
		void convergeManagedAgentNativeResumeBackend(payload).catch(
			() => undefined,
		);
		return projected;
	}
	const currentState = useStore.getState();
	const currentAgent = currentState.agents.find(
		(candidate) => candidate.id === payload.agentId,
	);
	if (!currentAgent) {
		return null;
	}
	const routeAuthority = await resolveManagedAgentRehostRouteAuthority(payload);
	if (!routeAuthority) return null;

	const backendReceipt = await commitManagedAgentNativeRehost(
		payload,
		routeAuthority,
		{ accounts: currentState.accounts },
	);
	const committedPayload = committedManagedAgentRehostPayload(
		payload,
		routeAuthority,
		backendReceipt,
	);
	if (!backendReceipt) {
		await commitManagedAgentCheckpointBinding(
			routeAuthority,
			payload.agentId,
			payload.binding,
		);
	}
	return projectManagedAgentRehostReceipt(
		committedPayload,
		options,
		backendReceipt,
	);
}

/** Commit a previously observed durable successor through the same receipt
 * authority used by first-response replacement. */
export async function commitReconciledManagedAgentRehostReceipt(
	reconciliation: ReconciledManagedAgentRehost,
	options?: ManagedAgentRehostCommitOptions,
): Promise<ManagedAgentRehostCommitReceipt> {
	useStore.getState().setHmuxSessionMetadata(reconciliation.replacement);
	const committed = await commitManagedAgentRehostReceipt(
		reconciliation.payload,
		options,
	);
	if (!committed) {
		throw new PaneCommandError(
			"pane_changed",
			"managed rehost successor projection did not commit",
		);
	}
	return committed;
}
