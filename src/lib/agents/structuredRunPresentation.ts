import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
	type AgentCanonicalSpawnV1,
	sameAgentCanonicalSpawn,
} from "@/lib/agents/agentCanonicalSpawn";
import {
	type AgentRunPresentationWorktree,
	projectAgentRunWorkspace,
	snapshotAgentRunPresentationWorktree,
} from "@/lib/agents/agentRunWorkspacePresentation";
import { resolveRunPresentationProject } from "@/lib/agents/runPresentationProject";
import {
	type BackendPresentationTarget,
	resolveBackendPresentationSshHost,
} from "@/lib/cli/backendPresentationTarget";
import type { CliManagedRunPresentationState } from "@/lib/cli/managedRunPresentationModel";
import type { DureStructuredAgentRunResultV1 } from "@/lib/ipc/dureAgentRun";
import { requestDesktopPrewarm } from "@/lib/workspace/desktop/desktopPrewarm";
import { openAgentPanel, resolvePaneById } from "@/lib/workspace/dock";
import { waitForDesktopDockview } from "@/lib/workspace/dock/dockRegistry";
import type { PanelPosition } from "@/lib/workspace/pane/panePlacement";
import { spaceWindowLabel } from "@/lib/workspace/window/windowLabel";
import { useStore } from "@/store";
import type { Agent, Project } from "@/types";

export interface StructuredRunPresentationDependencies {
	windowLabel(): string;
	readState(): CliManagedRunPresentationState;
	setState(
		producer: (
			state: CliManagedRunPresentationState,
		) => Partial<CliManagedRunPresentationState>,
	): void;
	ensureProject(path: string, hostId?: string): Promise<Project>;
	requestSpaceMount(spaceId: string): void;
	waitForSpace(spaceId: string): Promise<unknown | undefined>;
	resolveReference(panelId: string): Promise<{
		desktopId: string;
		panelId: string;
	}>;
	openAgent(
		spaceId: string,
		agent: Agent,
		position?: PanelPosition,
		preferredPanelId?: string,
	): string | false;
}

const defaultDependencies: StructuredRunPresentationDependencies = {
	windowLabel: () => getCurrentWebviewWindow().label,
	readState: () => useStore.getState(),
	setState: (producer) => useStore.setState((state) => producer(state)),
	ensureProject: (path, hostId) =>
		useStore.getState().ensureProjectForPath(path, hostId),
	requestSpaceMount: requestDesktopPrewarm,
	waitForSpace: waitForDesktopDockview,
	resolveReference: resolvePaneById,
	openAgent: openAgentPanel,
};

function fail(code: string, message: string): never {
	throw Object.assign(new Error(message), { code });
}

async function resolvePresentationProject(
	path: string | undefined,
	executionTarget: BackendPresentationTarget,
	dependencies: StructuredRunPresentationDependencies,
) {
	const hostId =
		executionTarget.source === "ssh"
			? resolveBackendPresentationSshHost(
					executionTarget,
					dependencies.readState().sshHosts,
					fail,
				).id
			: undefined;
	return resolveRunPresentationProject(
		dependencies.readState().projects,
		path,
		hostId,
		dependencies.ensureProject,
		fail,
	);
}

function presentationExecutionTarget(
	run: DureStructuredAgentRunResultV1,
	target: BackendPresentationTarget | undefined,
): BackendPresentationTarget {
	if (target) {
		if (target.source === "ssh" && target.hostId !== run.backendProfileId) {
			return fail(
				"client_backend_profile_mismatch",
				"structured Agent backend profile and SSH target disagree",
			);
		}
		return target;
	}
	if (run.backendProfileId === "local") {
		return { source: "local", hostId: "local" };
	}
	return fail(
		"client_backend_target_missing",
		"structured Agent backend target is unavailable",
	);
}

export function projectStructuredRunAgent(
	state: CliManagedRunPresentationState,
	run: DureStructuredAgentRunResultV1,
	project: Project,
	presentationWorktree?: AgentRunPresentationWorktree,
): {
	patch: Partial<CliManagedRunPresentationState>;
	agent: Agent;
	outcome: "created" | "reused";
} {
	const canonicalSpawn: AgentCanonicalSpawnV1 = {
		schemaVersion: 1,
		backendProfileId: run.backendProfileId,
		operationId: run.operationId,
	};
	const location = projectAgentRunWorkspace(
		presentationWorktree ??
			snapshotAgentRunPresentationWorktree(
				run.worktree,
				state.agents,
				project,
				run.providerId,
			),
		project.path,
	);
	const interactionOwners = state.agents.filter(
		(agent) =>
			agent.interactionProfile?.kind === "structured_protocol" &&
			agent.interactionProfile.backendProfileId === run.backendProfileId &&
			agent.interactionProfile.interactionSessionId ===
				run.interactionSessionId,
	);
	if (interactionOwners.length > 1) {
		fail(
			"client_agent_interaction_ambiguous",
			"structured interaction already has multiple Agent projections",
		);
	}
	const idOwner = state.agents.find((agent) => agent.id === run.agentId);
	const existing = interactionOwners[0];
	if (idOwner && idOwner !== existing) {
		fail(
			"client_agent_identity_conflict",
			"structured Agent identity is already in use",
		);
	}
	const credentialId =
		run.executionProfile.kind === "credential_reference"
			? run.executionProfile.reference_id
			: undefined;
	const profile = {
		schemaVersion: 1 as const,
		kind: "structured_protocol" as const,
		backendProfileId: run.backendProfileId,
		interactionSessionId: run.interactionSessionId,
	};
	if (existing) {
		if (
			existing.id !== run.agentId ||
			existing.name !== run.agentName ||
			existing.provider !== run.providerId ||
			existing.projectId !== project.id ||
			existing.worktreePath !== location.path ||
			existing.branch !== location.branch ||
			(existing.conversationId ?? null) !== run.providerConversationRef ||
			existing.runtimeBinding !== undefined ||
			(existing.canonicalSpawn !== undefined &&
				!sameAgentCanonicalSpawn(existing.canonicalSpawn, canonicalSpawn))
		) {
			fail(
				"client_agent_identity_conflict",
				"existing projection disagrees with the structured Agent identity",
			);
		}
		const agent: Agent = {
			...existing,
			canonicalSpawn,
			started: true,
			interactionProfile: profile,
			executionProfile: run.executionProfile,
			accountId: credentialId ?? null,
			credentialId,
			...(run.providerConversationRef
				? { conversationId: run.providerConversationRef }
				: {}),
		};
		return {
			agent,
			outcome: "reused",
			patch: {
				agents: state.agents.map((candidate) =>
					candidate.id === agent.id ? agent : candidate,
				),
				sessionCwd: { ...state.sessionCwd, [agent.sessionId]: location.path },
			},
		};
	}
	if (
		state.agents.some(
			(agent) => agent.projectId === project.id && agent.name === run.agentName,
		)
	) {
		fail(
			"client_agent_name_conflict",
			"structured Agent name is already in use for this project",
		);
	}
	const agent: Agent = {
		id: run.agentId,
		canonicalSpawn,
		name: run.agentName,
		provider: run.providerId,
		projectId: project.id,
		worktreePath: location.path,
		branch: location.branch,
		sessionId: run.agentId,
		sessionKind: project.kind === "ssh" ? "ssh" : "pty",
		interactionProfile: profile,
		executionProfile: run.executionProfile,
		started: true,
		skipPermissions: run.permissionMode === "skip_permissions",
		accountId: credentialId ?? null,
		credentialId,
		...(run.providerConversationRef
			? { conversationId: run.providerConversationRef }
			: {}),
	};
	return {
		agent,
		outcome: "created",
		patch: {
			agents: [...state.agents, agent],
			agentActivity: { ...state.agentActivity, [agent.id]: "connecting" },
			sessionCwd: { ...state.sessionCwd, [agent.sessionId]: location.path },
			stats: {
				...state.stats,
				agentsStarted: state.stats.agentsStarted + 1,
			},
		},
	};
}

export async function presentStructuredRunInBackground(
	run: DureStructuredAgentRunResultV1,
	target: {
		projectPath?: string;
		executionTarget?: BackendPresentationTarget;
		presentationWorktree?: AgentRunPresentationWorktree;
	},
	dependencies: StructuredRunPresentationDependencies = defaultDependencies,
): Promise<Agent> {
	const initial = dependencies.readState();
	const project = await resolvePresentationProject(
		target.projectPath,
		presentationExecutionTarget(run, target.executionTarget),
		dependencies,
	);
	const projected = projectStructuredRunAgent(
		dependencies.readState(),
		run,
		project,
		target.presentationWorktree ??
			snapshotAgentRunPresentationWorktree(
				run.worktree,
				initial.agents,
				project,
				run.providerId,
			),
	);
	dependencies.setState(() => projected.patch);
	return projected.agent;
}

function requireTargetWindow(
	spaceId: string,
	expectedWindowLabel: string,
	dependencies: StructuredRunPresentationDependencies,
) {
	const space = dependencies
		.readState()
		.spaces.find((candidate) => candidate.id === spaceId);
	if (
		!space ||
		spaceWindowLabel(space) !== expectedWindowLabel ||
		dependencies.windowLabel() !== expectedWindowLabel
	) {
		fail(
			"client_space_window_changed",
			"structured Agent target Space moved before presentation",
		);
	}
}

export async function presentStructuredRun(
	run: DureStructuredAgentRunResultV1,
	target: {
		executionTarget?: BackendPresentationTarget;
		projectPath?: string;
		spaceId: string;
		windowLabel: string;
		referencePanelId?: string;
		position?: PanelPosition;
		presentationWorktree?: AgentRunPresentationWorktree;
	},
	dependencies: StructuredRunPresentationDependencies = defaultDependencies,
) {
	const initial = dependencies.readState();
	requireTargetWindow(target.spaceId, target.windowLabel, dependencies);
	dependencies.requestSpaceMount(target.spaceId);
	if (!(await dependencies.waitForSpace(target.spaceId))) {
		fail("client_space_mount_timeout", "structured Agent Space did not mount");
	}
	const project = await resolvePresentationProject(
		target.projectPath,
		presentationExecutionTarget(run, target.executionTarget),
		dependencies,
	);
	const position = target.position;
	let preferredPanelId: string | undefined;
	if (!position && target.referencePanelId) {
		const reference = await dependencies.resolveReference(
			target.referencePanelId,
		);
		if (reference.desktopId !== target.spaceId) {
			fail(
				"client_source_pane_changed",
				"structured Agent reference pane moved to another Space",
			);
		}
		preferredPanelId = reference.panelId;
	}
	requireTargetWindow(target.spaceId, target.windowLabel, dependencies);
	const projected = projectStructuredRunAgent(
		dependencies.readState(),
		run,
		project,
		target.presentationWorktree ??
			snapshotAgentRunPresentationWorktree(
				run.worktree,
				initial.agents,
				project,
				run.providerId,
			),
	);
	dependencies.setState(() => projected.patch);
	const panelId = dependencies.openAgent(
		target.spaceId,
		projected.agent,
		position,
		preferredPanelId,
	);
	if (!panelId) {
		fail(
			"client_space_changed",
			"structured Agent Space changed before pane commit",
		);
	}
	return {
		ok: true,
		pane: {
			spaceId: target.spaceId,
			desktopId: target.spaceId,
			panelId,
			agentId: projected.agent.id,
			interactionSessionId: run.interactionSessionId,
			interactionProfile: "structured_protocol" as const,
			outcome: projected.outcome,
		},
	};
}
