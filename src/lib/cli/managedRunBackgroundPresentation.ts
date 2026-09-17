import { sameAgentCanonicalSpawn } from "@/lib/agents/agentCanonicalSpawn";
import {
	type AgentRunPresentationWorktree,
	snapshotAgentRunPresentationWorktree,
} from "@/lib/agents/agentRunWorkspacePresentation";
import { inspectManagedRunPresentationBinding } from "@/lib/cli/cliManagedRunPresentation";
import {
	type CliManagedRunPresentationState,
	type ManagedRunProjectionInput,
	projectManagedRunPresentationAgent,
} from "@/lib/cli/managedRunPresentationModel";
import { sameHmuxManagedGeneration } from "@/lib/hmux/identity/hmuxManagedGeneration";
import type { DureNativeAgentRunResultV1 } from "@/lib/ipc/dureAgentRun";
import { useStore } from "@/store";
import type { Agent, Project } from "@/types";

export interface BackgroundManagedRunPresentationDependencies {
	inspectBinding: typeof inspectManagedRunPresentationBinding;
	ensureProject(path: string): Promise<Project>;
	readState(): CliManagedRunPresentationState;
	setState(
		producer: (
			state: CliManagedRunPresentationState,
		) => Partial<CliManagedRunPresentationState>,
	): void;
}

const defaultDependencies: BackgroundManagedRunPresentationDependencies = {
	inspectBinding: inspectManagedRunPresentationBinding,
	ensureProject: (path) => useStore.getState().ensureProjectForPath(path),
	readState: () => useStore.getState(),
	setState: (producer) => useStore.setState((state) => producer(state)),
};

function exactExistingProjection(
	state: CliManagedRunPresentationState,
	request: ManagedRunProjectionInput,
): Agent | undefined {
	if (!request.backendProfileId) return undefined;
	const agent = state.agents.find(
		(candidate) => candidate.id === request.agentId,
	);
	const binding = agent?.runtimeBinding;
	return agent &&
		sameAgentCanonicalSpawn(agent.canonicalSpawn, {
			schemaVersion: 1,
			backendProfileId: request.backendProfileId,
			operationId: request.operationId,
		}) &&
		agent.sessionId === request.sessionId &&
		binding?.runtime === "hmux_managed_v1" &&
		binding.source === "local" &&
		binding.hostId === "local" &&
		binding.sessionId === request.sessionId &&
		binding.workspaceId === request.workspaceId &&
		binding.createIdempotencyKey === request.launchIdempotencyKey &&
		binding.backendProfileId === request.backendProfileId &&
		sameHmuxManagedGeneration(binding.stopFence, request.generation)
		? agent
		: undefined;
}

/** Single authority for the pane-independent request fields projected from a
 * `DureAgentRunResultV1`. `localAgentRunPresentationRequest` (the foreground,
 * pane-attaching path) spreads this and adds only the window-coupled fields
 * (spaceId/windowLabel/referencePanelId) it needs on top. */
export function projectionInput(
	run: DureNativeAgentRunResultV1,
	projectPath: string,
): ManagedRunProjectionInput {
	return {
		schemaVersion: 1,
		runtime: "hmux_managed_v1",
		source: "local",
		hostId: "local",
		backendProfileId: "local",
		operationId: run.operationId,
		agentId: run.agentId,
		agentName: run.agentName,
		projectId: run.projectId,
		projectPath,
		providerId: run.providerId,
		executionProfile: run.executionProfile,
		preparedSessionId: run.preparedSessionId,
		sessionId: run.sessionId,
		launchIdempotencyKey: run.launchIdempotencyKey,
		workspaceId: run.workspaceId,
		providerConversationRef: run.providerConversationRef,
		worktree: run.worktree,
		generation: run.generation,
		permissionMode: run.permissionMode,
	};
}

/**
 * Store-projection-only presentation: the agent becomes visible in the
 * Spaces navigator (unopened agents) without opening a pane, mounting a
 * space, or waiting for attachment. Pane attachment happens when the user
 * opens the agent.
 */
export async function presentManagedRunInBackground(
	run: DureNativeAgentRunResultV1,
	target: {
		projectPath: string;
		presentationWorktree?: AgentRunPresentationWorktree;
	},
	dependencies: BackgroundManagedRunPresentationDependencies = defaultDependencies,
): Promise<Agent> {
	const request = projectionInput(run, target.projectPath);
	const initial = dependencies.readState();
	const existing = exactExistingProjection(initial, request);
	if (existing) return existing;
	const binding = await dependencies.inspectBinding(request, initial);
	const project = await dependencies.ensureProject(target.projectPath);
	const presentationWorktree =
		target.presentationWorktree ??
		snapshotAgentRunPresentationWorktree(
			run.worktree,
			initial.agents,
			project,
			run.providerId,
		);
	const projected = projectManagedRunPresentationAgent(
		dependencies.readState(),
		{ ...request, presentationWorktree },
		project,
		binding,
	);
	dependencies.setState(() => projected.patch);
	return projected.agent;
}
