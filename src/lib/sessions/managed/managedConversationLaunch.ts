import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { runCanonicalAddAgentPresenting } from "@/lib/agents/addAgentCanonicalRun";
import {
	conversationHistorySourceAuthority,
	sameConversationHistorySourceAuthority,
} from "@/lib/agents/agentConversationHistory";
import {
	launchAgentRegistrationEvidence,
	rollbackCreatedAgentRegistration,
} from "@/lib/agents/agentRegistrationRollback";
import { assertAgentRuntimeProjectionContext } from "@/lib/agents/agentRuntimeProfileSwitch";
import {
	inspectSelectedAgentRuntimeProjection,
	inspectStructuredAgentRuntimeProjectionContext,
} from "@/lib/agents/agentRuntimeProjectionRecovery";
import { computeTextDigest } from "@/lib/agents/promptIdentity";
import {
	ProviderExplicitResumeUnsupportedError,
	providerSupportsExplicitResume,
} from "@/lib/agents/providers";
import { t } from "@/lib/i18n";
import type { DureProviderPermissionModeV1 } from "@/lib/ipc/dureAgentRuntime";
import { isDureProviderConversationRefV1 } from "@/lib/ipc/dureProtocolIdentity";
import {
	ensureManagedAgentRuntime,
	MANAGED_BOOTSTRAP_GEOMETRY,
} from "@/lib/sessions/managed/managedAgentRuntime";
import { ManagedRecoveryRefusedError } from "@/lib/sessions/managed/managedAgentRuntimeErrors";
import {
	assertManagedConversationLaunchPermit,
	type ManagedConversationOwnership,
	ManagedConversationOwnershipUnavailableError,
	resolveManagedConversationOwnership,
	revalidateManagedConversationLaunchPermit,
} from "@/lib/sessions/managed/managedConversationOwnership";
import { admitManagedCreateRegistration } from "@/lib/sessions/managed/managedCreateRegistrationAdmission";
import { resumeExactManagedAgentPane } from "@/lib/sessions/managed/managedExactConversationResume";
import { openAgentPanel } from "@/lib/workspace/dock";
import type { PanelPosition } from "@/lib/workspace/pane/panePlacement";
import { useStore } from "@/store";
import type { Agent } from "@/types";

export class ManagedConversationAlreadyActiveError extends Error {
	readonly code = "conversation_already_active";

	constructor(readonly agentId: string) {
		super(`conversation is already active in agent ${agentId}`);
		this.name = "ManagedConversationAlreadyActiveError";
	}
}

export class ManagedConversationPresentedInBackgroundError extends Error {
	readonly code = "managed_conversation_presented_in_background";

	constructor(readonly agentId: string) {
		super(t("sessions.launch.presentedInBackground"));
		this.name = "ManagedConversationPresentedInBackgroundError";
	}
}

export type ManagedConversationMenuTarget =
	| { kind: "id"; id: string }
	| { kind: "fresh" }
	| { kind: "continue" };

type ExitedManagedConversationRecoveryInput =
	| {
			agentId: string;
			panelId: string;
			target: { kind: "fresh" };
	  }
	| {
			agentId: string;
			panelId?: string;
			target: { kind: "id"; id: string } | { kind: "continue" };
	  };

/** Translate a live pane's history menu target into a non-destructive sibling
 * launch. A provider's implicit "latest" alias is never safe here because the
 * selected conversation must stay exact across concurrent panes. */
export async function launchManagedConversationTargetInSibling(input: {
	sourceAgentId: string;
	desktopId: string;
	referencePanelId?: string;
	target: ManagedConversationMenuTarget;
}): Promise<Agent> {
	if (input.target.kind === "continue") {
		throw new Error("managed_exact_or_fresh_conversation_required");
	}
	return launchManagedConversationPane({
		sourceAgentId: input.sourceAgentId,
		desktopId: input.desktopId,
		...(input.referencePanelId
			? { referencePanelId: input.referencePanelId }
			: {}),
		...(input.target.kind === "id" ? { conversationId: input.target.id } : {}),
	});
}

/** Persist exact launch input before the Host side effect, but commit a pane
 * only after managed create admission succeeds. A rejected create rolls back
 * only this transaction's registration; it never stops or mutates a source. */
export async function launchPreparedManagedConversationPane(
	agent: Agent,
	desktopId: string,
	options: {
		existingOwner?: "reject" | "return";
		ownership?: ManagedConversationOwnership;
		position?: PanelPosition;
	} = {},
): Promise<Agent> {
	const conversationId = agent.conversationId?.trim();
	const ownership =
		options.ownership ??
		(conversationId
			? await resolveManagedConversationOwnership({
					providerId: agent.provider,
					conversationId,
				})
			: undefined);
	if (ownership?.state === "active") {
		if (options.existingOwner === "return") return ownership.agent;
		throw new ManagedConversationAlreadyActiveError(ownership.agent.id);
	}
	const retained = ownership?.state === "pending";
	const launchAgent = retained ? ownership.agent : agent;
	const rollbackEvidence = launchAgentRegistrationEvidence(launchAgent);
	const permit = ownership?.permit;
	if (!retained) {
		useStore.setState((current) => {
			if (current.agents.some((candidate) => candidate.id === agent.id)) {
				throw new Error(
					`managed conversation agent already exists: ${agent.id}`,
				);
			}
			if (permit) assertManagedConversationLaunchPermit(permit, current);
			return {
				agents: [...current.agents, agent],
				agentActivity: {
					...current.agentActivity,
					[agent.id]: "connecting",
				},
			};
		});
	}

	const admission = await admitManagedCreateRegistration(
		launchAgent,
		(candidate) =>
			ensureManagedAgentRuntime(candidate, {
				...MANAGED_BOOTSTRAP_GEOMETRY,
				...(permit
					? {
							beforeCreate: () =>
								revalidateManagedConversationLaunchPermit(
									permit,
									launchAgent.id,
								),
						}
					: {}),
			}),
	);
	if (admission.state === "rejected") {
		if (!retained) {
			await rollbackCreatedAgentRegistration(admission.agent, rollbackEvidence);
		}
		throw admission.error;
	}
	if (admission.state === "retained") throw admission.error;
	const launched = admission.value.agent;
	const paneOpened = options.position
		? openAgentPanel(desktopId, launched, options.position)
		: openAgentPanel(desktopId, launched);
	if (!paneOpened) {
		throw new Error("managed conversation target desktop is not mounted");
	}
	useStore.setState((current) => ({
		stats: {
			...current.stats,
			agentsStarted: current.stats.agentsStarted + 1,
		},
	}));
	return launched;
}

export function managedConversationLaunchFailureMessage(
	error: unknown,
): string {
	if (error instanceof ManagedConversationPresentedInBackgroundError) {
		return error.message;
	}
	if (error instanceof ManagedConversationOwnershipUnavailableError) {
		return t("sessions.launch.ownershipUnavailable", {
			reason: error.reason,
		});
	}
	if (!(error instanceof ManagedRecoveryRefusedError)) return String(error);
	return t("sessions.launch.recoveryRefused", {
		reason: error.message,
	});
}

function nextResumeName(
	agents: readonly Pick<Agent, "name" | "projectId">[],
	projectId: string,
	sourceName: string,
	fresh: boolean,
): string {
	const names = new Set(
		agents
			.filter((agent) => agent.projectId === projectId)
			.map((agent) => agent.name),
	);
	const base = `${sourceName}-${fresh ? "new" : "resume"}`;
	let name = base;
	for (let suffix = 2; names.has(name); suffix += 1) {
		name = `${base}-${suffix}`;
	}
	return name;
}

function conversationRunPermissionOverride(
	permissionMode: DureProviderPermissionModeV1,
) {
	switch (permissionMode) {
		case "default":
			return "require_approvals" as const;
		case "auto_edit":
			return "auto_edit" as const;
		case "skip_permissions":
			return "bypass_approvals" as const;
	}
}

/** Register and open a sibling managed pane for a header history action.
 *
 * The live source Agent, provider, and pane binding are read-only. Reusing an
 * exited pane is a separate recovery action with a destructive source fence.
 */
export async function launchManagedConversationPane(input: {
	sourceAgentId: string;
	desktopId: string;
	conversationId?: string;
	/** Recent Sessions may focus a current exact owner instead of duplicating it. */
	existingOwner?: "reject" | "return";
	/** Explicit sidebar drop placement. Button/menu launches keep auto-split. */
	position?: PanelPosition;
	/** Exact source pane for normal sibling presentation. */
	referencePanelId?: string;
}): Promise<Agent> {
	const initialState = useStore.getState();
	const initialSource = initialState.agents.find(
		(candidate) => candidate.id === input.sourceAgentId,
	);
	if (!initialSource)
		throw new Error("managed conversation source agent was not found");
	const initialBinding = initialSource.runtimeBinding;
	const initialStructuredProfile = initialSource.interactionProfile;
	if (
		(initialBinding?.runtime !== "hmux_managed_v1" ||
			initialBinding.source !== "local") &&
		initialStructuredProfile?.kind !== "structured_protocol"
	) {
		throw new Error("managed conversation source is not a local managed agent");
	}
	const initialProject = initialState.projects.find(
		(candidate) => candidate.id === initialSource.projectId,
	);
	if (initialProject?.kind !== "local") {
		throw new Error("managed conversation source is not a local project agent");
	}
	const initialAuthority = conversationHistorySourceAuthority(
		initialSource,
		initialProject,
	);
	const desktopId = input.desktopId.trim();
	if (!desktopId)
		throw new Error("managed conversation target desktop is required");

	const conversationId = input.conversationId;
	if (
		conversationId !== undefined &&
		!isDureProviderConversationRefV1(conversationId)
	) {
		throw new Error("invalid_conversation_identity");
	}
	if (
		conversationId &&
		!providerSupportsExplicitResume(initialSource.provider)
	) {
		throw new ProviderExplicitResumeUnsupportedError(initialSource.provider);
	}
	const exactConversationActionDigest = conversationId
		? await computeTextDigest(
				JSON.stringify([
					initialProject.id,
					initialSource.id,
					initialSource.provider,
					conversationId,
				]),
			)
		: null;
	const ownership = conversationId
		? await resolveManagedConversationOwnership({
				providerId: initialSource.provider,
				conversationId,
			})
		: undefined;
	if (ownership?.state === "active") {
		if (input.existingOwner === "return") return ownership.agent;
		throw new ManagedConversationAlreadyActiveError(ownership.agent.id);
	}
	if (ownership?.state === "pending") {
		return launchPreparedManagedConversationPane(ownership.agent, desktopId, {
			ownership,
		});
	}
	const projection = initialStructuredProfile
		? await inspectStructuredAgentRuntimeProjectionContext({
				agentId: initialSource.id,
				backendProfileId: initialStructuredProfile.backendProfileId,
				interactionSessionId: initialStructuredProfile.interactionSessionId,
			})
		: await inspectSelectedAgentRuntimeProjection(initialSource.id);
	if (projection.state !== "stable") {
		throw new ManagedConversationOwnershipUnavailableError(
			"conversation source runtime is not stable",
		);
	}
	assertAgentRuntimeProjectionContext(initialSource, initialProject, {
		projectionContext: projection.projectionContext,
		routeAuthority: projection.routeAuthority,
		sshHosts: initialState.sshHosts,
	});
	if (ownership?.state === "vacant") {
		await revalidateManagedConversationLaunchPermit(
			ownership.permit,
			`canonical-history:${initialSource.id}`,
		);
	}

	// Ownership resolution crosses Hmux/Host boundaries. The Agent used as the
	// launch template must still be the exact snapshot the user activated.
	const state = useStore.getState();
	const source = state.agents.find(
		(candidate) => candidate.id === input.sourceAgentId,
	);
	const project = state.projects.find(
		(candidate) => candidate.id === source?.projectId,
	);
	if (
		!source ||
		!project ||
		!sameConversationHistorySourceAuthority(
			conversationHistorySourceAuthority(source, project),
			initialAuthority,
		)
	) {
		throw new ManagedConversationOwnershipUnavailableError(
			"conversation source changed during exact ownership resolution",
		);
	}
	if (project?.kind !== "local") {
		throw new ManagedConversationOwnershipUnavailableError(
			"conversation source project changed during exact ownership resolution",
		);
	}
	const agentName = nextResumeName(
		state.agents,
		project.id,
		source.name,
		!conversationId,
	);
	const presentation = await runCanonicalAddAgentPresenting(
		{
			project,
			actionId: exactConversationActionDigest
				? `managed-conversation:${exactConversationActionDigest.slice("sha256:".length)}`
				: `managed-conversation:${project.id}:${agentName}`,
			agentName,
			provider: source.provider,
			accountId: null,
			useWorktree: false,
			setupCommand: null,
			permissionOverride: conversationRunPermissionOverride(
				projection.launchSelection.permissionMode,
			),
			...(projection.launchSelection.model
				? { model: projection.launchSelection.model }
				: {}),
			...(projection.launchSelection.effort
				? { effort: projection.launchSelection.effort }
				: {}),
			existingWorkspace: {
				sourceAgentId: source.id,
				workspaceId: projection.projectionContext.agent.workspaceId,
				branch: source.branch,
				executionProfile: projection.executionProfile,
				providerConversationRef: conversationId ?? null,
				routeAuthority: projection.routeAuthority,
			},
		},
		{
			spaceId: desktopId,
			windowLabel: getCurrentWebviewWindow().label,
			...(input.position ? { position: input.position } : {}),
			...(!input.position && input.referencePanelId
				? { referencePanelId: input.referencePanelId }
				: {}),
		},
	);
	const launched = useStore
		.getState()
		.agents.find((candidate) => candidate.id === presentation.run.agentId);
	if (!launched) throw new Error("agent_run_presentation_missing");
	if (presentation.disposition === "background") {
		throw new ManagedConversationPresentedInBackgroundError(launched.id);
	}
	return launched;
}

/** Resolve an exited-pane action without treating the dead source Host as
 * conversation authority. Pane-scoped actions replace that pane; recovery
 * actions without a pane reference open or attach an owner in the desktop. */
export async function recoverExitedManagedConversationPane(
	input: ExitedManagedConversationRecoveryInput,
	lease?: { checkpoint(): void },
): Promise<string | null> {
	if (input.target.kind === "fresh") {
		if (!input.panelId) {
			throw new Error("managed fresh conversation pane is required");
		}
		const agent = useStore.getState().agents.find(
			(candidate) => candidate.id === input.agentId,
		);
		if (agent?.runtimeBinding?.source === "ssh" && !agent.runtimeBinding.stopFence) {
			// A create interrupted by login still owns its original Agent/key.
			// This explicit action resumes it; a pane mount never creates it.
			const { ensureRemoteManagedAgentRuntime } = await import(
				"@/lib/sessions/launch/remoteManagedAgentRuntime"
			);
			lease?.checkpoint();
			await ensureRemoteManagedAgentRuntime(agent, MANAGED_BOOTSTRAP_GEOMETRY);
			return null;
		}
		const { startFreshManagedAgentPane } = await import(
			"@/lib/sessions/managed/managedAgentFreshStart"
		);
		lease?.checkpoint();
		await startFreshManagedAgentPane(input.agentId, input.panelId);
		return null;
	}
	if (input.target.kind === "continue") {
		throw new Error("managed_exact_or_fresh_conversation_required");
	}
	if (input.panelId) {
		const committed = await resumeExactManagedAgentPane(
			input.agentId,
			input.panelId,
			input.target.id,
		);
		return committed.payload.conversationId ?? input.target.id.trim();
	}
	const initialState = useStore.getState();
	const desktopId = initialState.activeSpaceId.trim();
	if (!desktopId) {
		throw new Error("managed conversation target desktop is required");
	}
	const existingAgentIds = new Set(
		initialState.agents.map((candidate) => candidate.id),
	);
	const resumed = await launchManagedConversationPane({
		sourceAgentId: input.agentId,
		desktopId,
		conversationId: input.target.id,
		existingOwner: "return",
	});
	// Launch admission already opens a new owner. Only a verified owner that
	// predated this action needs an explicit focus/attach presentation.
	if (existingAgentIds.has(resumed.id) && !openAgentPanel(desktopId, resumed)) {
		throw new Error("managed conversation target desktop is not mounted");
	}
	return resumed.conversationId?.trim() ?? input.target.id.trim();
}
