import { resolvePaneById, resolvePaneReference } from "@/lib/workspace/dock";
import { findAgentPanel } from "@/lib/workspace/dock/dockPanelParameters";
import { PaneCommandError } from "@/lib/workspace/pane/paneCommandError";
import { effectiveAgentPermissionMode } from "@/lib/agents/agentPermissionMode";
import { inspectHmuxSessionExact } from "@/lib/hmux/identity/exactHmuxSessionInspection";
import { hmuxSessionMetadataKey } from "@/lib/hmux/identity/hmuxSessionMetadata";
import { type HmuxRecoveryPlanReceipt, hmux } from "@/lib/ipc";
import { managedConversationId } from "@/lib/sessions/managed/managedConversationIdentity";
import {
	type ManagedAgentTarget,
	resolveLegacyAgentPaneTarget,
	resolveManagedAgentTarget,
} from "@/lib/sessions/managed/managedAgentTarget";
import { ensureManagedConversationIdentity } from "@/lib/sessions/managed/managedAgentRuntime";
import { providerSupportsExplicitResume } from "@/lib/agents/providers";
import type { HmuxManagedPaneBindingV1 } from "@/lib/terminal/terminalBinding";
import { useStore } from "@/store";
import type {
	Agent,
	DeferredCredentialSwitchIntentV1,
	Provider,
	TerminalEnvironment,
} from "@/types";

export interface ManagedAgentRehostInspection {
	agentId: string;
	agentName: string;
	projectId: string;
	providerId: Provider;
	sourceBinding: HmuxManagedPaneBindingV1;
	sourceConversationId?: string;
	sourceLifecycle: "ready" | "exited" | "unavailable";
	sourcePaneState: "present" | "absent";
	conversationId: string;
	cwd: string;
	desktopId: string;
	panelId: string;
	permissionMode: "default" | "bypass_approvals";
	credentialId?: string;
	terminalEnvironment: TerminalEnvironment;
	plan: HmuxRecoveryPlanReceipt;
}

// 계약은 leaf(managedAgentInspectionTypes)로 이동 — persistence 백본이 이
// 파일(useStore 런타임 의존)을 타입 때문에 임포트하던 순환 절단. 소비자
// 호환을 위해 재-export.
import type { ManagedAgentCredentialSwitchInspection } from "@/lib/sessions/managed/managedAgentInspectionTypes";
export type { ManagedAgentCredentialSwitchInspection };

class ManagedConversationIdentityRequiredError extends PaneCommandError {
	readonly reason = "conversation_identity_required";

	constructor() {
		super("invalid_request", "conversation_identity_required");
		this.name = "ManagedConversationIdentityRequiredError";
	}
}

/** Resolve one managed agent target and require its local project. Shared by
 * rehost and fresh-start inspections. */
export function resolveLocalManagedAgentTarget(name: string) {
	const target = resolveManagedAgentTarget(name);
	const state = useStore.getState();
	const project = state.projects.find(
		(candidate) => candidate.id === target.agent.projectId,
	);
	if (project?.kind !== "local") {
		throw new PaneCommandError(
			"invalid_request",
			`agent ${target.agent.name} is not a local project agent`,
		);
	}
	return { target, state, project };
}

function inspectManagedAgentBase(name: string): {
	target: ManagedAgentTarget;
	state: ReturnType<typeof useStore.getState>;
	projectId: string;
} {
	const { target, state, project } = resolveLocalManagedAgentTarget(name);
	if (!providerSupportsExplicitResume(target.agent.provider)) {
		throw new PaneCommandError(
			"invalid_request",
			"explicit_resume_unsupported",
		);
	}
	return { target, state, projectId: project.id };
}

function managedSourceLifecycle(
	target: ManagedAgentTarget,
	state: ReturnType<typeof useStore.getState>,
): ManagedAgentRehostInspection["sourceLifecycle"] {
	const metadata =
		state.hmuxSessionMetadata[
			hmuxSessionMetadataKey(
				target.binding.workspaceId,
				target.binding.sessionId,
			)
		];
	if (
		metadata?.lifecycle === "exited" ||
		metadata?.health === "exited" ||
		state.sessionAgentRuntimeState[target.binding.sessionId]?.lifecycle ===
			"exited"
	) {
		return "exited";
	}
	if (
		metadata?.lifecycle === "unavailable" ||
		metadata?.health === "stale_transport" ||
		metadata?.health === "incompatible_protocol" ||
		metadata?.inputAllowed === false
	) {
		return "unavailable";
	}
	return "ready";
}

function inspectManagedAgentSource(name: string): ReturnType<
	typeof inspectManagedAgentBase
> & {
	conversationId: string;
} {
	const source = inspectManagedAgentBase(name);
	const conversationId = managedConversationId(source.target.agent);
	if (!conversationId) {
		throw new ManagedConversationIdentityRequiredError();
	}
	return { ...source, conversationId };
}

async function inspectManagedAgentSourceWhenReady(
	name: string,
): Promise<ReturnType<typeof inspectManagedAgentSource>> {
	const initial = inspectManagedAgentBase(name);
	if (managedSourceLifecycle(initial.target, initial.state) !== "ready") {
		return inspectManagedAgentSource(name);
	}
	if (!managedConversationId(initial.target.agent)) {
		await ensureManagedConversationIdentity(initial.target.agent);
	}
	return inspectManagedAgentSource(name);
}

export async function resolveFencedManagedAgentPanel(
	agentId: string,
	requestedPanelId?: string,
) {
	const resolved = requestedPanelId
		? await resolvePaneById(requestedPanelId)
		: await resolvePaneReference({ agentId });
	const { panelId } = resolved;
	const livePanel = resolved.api.getPanel(panelId);
	if (!livePanel) {
		throw new PaneCommandError(
			"pane_not_found",
			`agent pane ${panelId} detached during inspection`,
		);
	}
	if (!findAgentPanel({ panels: [livePanel] }, agentId)) {
		throw new PaneCommandError(
			"pane_changed",
			`pane ${panelId} no longer presents agent ${agentId}`,
		);
	}
	return { ...resolved, livePanel };
}

/** Resolve optional Dockview presentation without turning it into runtime
 * authority. Agent/source generation fences remain sufficient when unmounted. */
export async function resolveManagedAgentPresentationTarget(
	agent: Agent,
	state: ReturnType<typeof useStore.getState> = useStore.getState(),
	requestedPanelId?: string,
): Promise<{
	desktopId: string;
	panelId: string;
	sourcePaneState: "present" | "absent";
}> {
	try {
		const panel = await resolveFencedManagedAgentPanel(
			agent.id,
			requestedPanelId,
		);
		return {
			desktopId: panel.desktopId,
			panelId: panel.panelId,
			sourcePaneState: "present",
		};
	} catch (error) {
		if (
			!(error instanceof PaneCommandError) ||
			error.code !== "pane_not_found"
		) {
			throw error;
		}
		return {
			desktopId: state.activeSpaceId.trim() || "detached",
			panelId: requestedPanelId ?? resolveLegacyAgentPaneTarget(agent).panelId,
			sourcePaneState: "absent",
		};
	}
}

function normalizeRecoveryPlan(
	plan: HmuxRecoveryPlanReceipt,
	target: ManagedAgentTarget,
	refusal: string,
): HmuxRecoveryPlanReceipt {
	const confirmationPreview =
		!plan.allowed &&
		plan.action === "none" &&
		plan.reason === "update_requires_confirmation" &&
		plan.requiresConfirmation;
	if (
		plan.sessionId !== target.binding.sessionId ||
		(!confirmationPreview &&
			(!plan.allowed ||
				plan.action !== "replace_ai_provider_with_explicit_conversation"))
	) {
		throw new PaneCommandError("invalid_request", plan.reason ?? refusal);
	}
	return confirmationPreview
		? {
				...plan,
				action: "replace_ai_provider_with_explicit_conversation",
			}
		: plan;
}

async function planExactRecovery(
	target: ManagedAgentTarget,
	conversationId: string,
	refusal: string,
) {
	return normalizeRecoveryPlan(
		await hmux.planRecovery({
			sessionId: target.binding.sessionId,
			workspaceId: target.binding.workspaceId,
			expectedSourceFence: target.binding.stopFence,
			conversationId,
			adapterSupportsExplicitResume: true,
			confirmed: false,
		}),
		target,
		refusal,
	);
}

/** Fields every rehost inspection derives identically from one fenced target. */
function rehostInspectionCommonFields(
	target: ManagedAgentTarget,
	state: ReturnType<typeof useStore.getState>,
	presentation: Awaited<
		ReturnType<typeof resolveManagedAgentPresentationTarget>
	>,
) {
	return {
		agentId: target.agent.id,
		agentName: target.agent.name,
		providerId: target.agent.provider,
		sourceBinding: { ...target.binding },
		cwd: target.agent.worktreePath,
		...presentation,
		permissionMode: effectiveAgentPermissionMode(
			target.agent,
			state.skipPermissions,
		),
		credentialId: target.binding.credentialId ?? target.agent.credentialId,
		terminalEnvironment: { ...(target.agent.terminalEnv ?? {}) },
	};
}

/** Read-only source/conversation/build fence. */
export async function inspectManagedAgentRehost(
	name: string,
	requestedPanelId?: string,
): Promise<ManagedAgentRehostInspection> {
	const initial = inspectManagedAgentBase(name);
	if (managedSourceLifecycle(initial.target, initial.state) !== "ready") {
		const conversationId = managedConversationId(initial.target.agent);
		if (!conversationId) throw new ManagedConversationIdentityRequiredError();
		return inspectDisconnectedManagedAgentRecovery(
			name,
			conversationId,
			requestedPanelId,
		);
	}
	const { target, state, projectId, conversationId } =
		await inspectManagedAgentSourceWhenReady(name);
	const presentation = await resolveManagedAgentPresentationTarget(
		target.agent,
		state,
		requestedPanelId,
	);
	return {
		...rehostInspectionCommonFields(target, state, presentation),
		projectId,
		sourceConversationId: conversationId,
		sourceLifecycle: managedSourceLifecycle(target, state),
		conversationId,
		plan: await planExactRecovery(
			target,
			conversationId,
			"managed_rehost_refused",
		),
	};
}

/** Inspect a disconnected source against one exact user-selected conversation. */
export async function inspectDisconnectedManagedAgentRecovery(
	name: string,
	conversationId: string,
	requestedPanelId?: string,
): Promise<ManagedAgentRehostInspection> {
	const exactConversationId = conversationId.trim();
	if (!exactConversationId) {
		throw new ManagedConversationIdentityRequiredError();
	}
	const { target, state, projectId } = inspectManagedAgentBase(name);
	const sourceLifecycle = managedSourceLifecycle(target, state);
	const presentation = await resolveManagedAgentPresentationTarget(
		target.agent,
		state,
		requestedPanelId,
	);
	return {
		...rehostInspectionCommonFields(target, state, presentation),
		projectId,
		sourceConversationId: managedConversationId(target.agent),
		sourceLifecycle,
		conversationId: exactConversationId,
		plan: await planExactRecovery(
			target,
			exactConversationId,
			"managed_exited_recovery_refused",
		),
	};
}

/** Compatibility name for callers that already selected an exited conversation. */

async function inspectManagedAgentCredentialReplacement(
	name: string,
	targetCredentialId: string | null,
	requestedPanelId?: string,
): Promise<ManagedAgentCredentialSwitchInspection> {
	const { target, state, projectId, conversationId } =
		await inspectManagedAgentSourceWhenReady(name);
	const sourceCredentialId =
		target.binding.credentialId ?? target.agent.credentialId;
	if ((sourceCredentialId ?? null) === targetCredentialId) {
		throw new PaneCommandError(
			"invalid_request",
			"credential_selection_unchanged",
		);
	}
	const targetAccount = targetCredentialId
		? state.accounts.find(
				(account) =>
					account.id === targetCredentialId &&
					account.provider === target.agent.provider,
			)
		: undefined;
	if (targetCredentialId && !targetAccount) {
		throw new PaneCommandError(
			"invalid_request",
			"credential_reference_unavailable",
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
		projectId,
		providerId: target.agent.provider,
		sourceBinding: { ...target.binding },
		...presentation,
		sourceCredentialId,
		sourceConversationId: conversationId,
		targetCredentialId,
		targetAccount: targetAccount ? { ...targetAccount } : undefined,
		conversationId,
		cwd: target.agent.worktreePath,
		permissionMode: effectiveAgentPermissionMode(
			target.agent,
			state.skipPermissions,
		),
		terminalEnvironment: { ...(target.agent.terminalEnv ?? {}) },
	};
}

/** Inspect a healthy managed source for an explicit credential change. */
export function inspectManagedAgentCredentialSwitch(
	name: string,
	targetCredentialId: string | null,
	requestedPanelId?: string,
): Promise<ManagedAgentCredentialSwitchInspection> {
	return inspectManagedAgentCredentialReplacement(
		name,
		targetCredentialId,
		requestedPanelId,
	);
}

/** Resume a user-authorized credential switch after its destructive backend
 * transaction crossed the source-stop boundary. The persisted intent is only
 * a client equality hint: executeRecovery still replays the backend's
 * canonical journal and rejects changed launch inputs. */
export async function inspectInterruptedManagedAgentCredentialSwitch(
	name: string,
	intent: DeferredCredentialSwitchIntentV1,
): Promise<ManagedAgentCredentialSwitchInspection> {
	const { target, state, projectId, conversationId } =
		inspectManagedAgentSource(name);
	const binding = target.binding;
	const sourceCredentialId = binding.credentialId ?? target.agent.credentialId;
	if (
		binding.sessionId !== intent.sourceSessionId ||
		binding.workspaceId !== intent.sourceWorkspaceId ||
		(binding.createIdempotencyKey ?? null) !==
			intent.sourceCreateIdempotencyKey ||
		(binding.credentialGeneration ?? null) !==
			intent.sourceCredentialGeneration ||
		(sourceCredentialId ?? null) !== intent.sourceCredentialId ||
		binding.stopFence?.terminalEpoch !== intent.sourceTerminalEpoch ||
		conversationId !== intent.sourceConversationId
	) {
		throw new PaneCommandError(
			"pane_changed",
			"persisted credential switch source fence changed",
		);
	}
	const source = await inspectHmuxSessionExact({
		sessionId: intent.sourceSessionId,
		workspaceId: intent.sourceWorkspaceId,
	});
	if (source && source.lifecycle !== "exited" && source.health !== "exited") {
		throw new PaneCommandError(
			"pane_changed",
			"persisted credential switch source is still live",
		);
	}
	const targetAccount = intent.targetCredentialId
		? state.accounts.find(
				(account) =>
					account.id === intent.targetCredentialId &&
					account.provider === target.agent.provider,
			)
		: undefined;
	if (
		(intent.targetCredentialId !== null && !targetAccount) ||
		(targetAccount?.dir ?? null) !== intent.targetCredentialDirectory
	) {
		throw new PaneCommandError(
			"invalid_request",
			"credential_reference_unavailable",
		);
	}
	const presentation = await resolveManagedAgentPresentationTarget(
		target.agent,
		state,
	);
	return {
		agentId: target.agent.id,
		agentName: target.agent.name,
		projectId,
		providerId: target.agent.provider,
		sourceBinding: { ...binding },
		...presentation,
		sourceCredentialId,
		sourceConversationId: conversationId,
		targetCredentialId: intent.targetCredentialId,
		targetAccount: targetAccount ? { ...targetAccount } : undefined,
		conversationId,
		cwd: target.agent.worktreePath,
		permissionMode: effectiveAgentPermissionMode(
			target.agent,
			state.skipPermissions,
		),
		terminalEnvironment: { ...(target.agent.terminalEnv ?? {}) },
	};
}
