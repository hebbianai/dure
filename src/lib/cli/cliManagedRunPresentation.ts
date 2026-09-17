import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
	type AgentRunPresentationWorktree,
	snapshotAgentRunPresentationWorktree,
} from "@/lib/agents/agentRunWorkspacePresentation";
import { resolveRunPresentationProject } from "@/lib/agents/runPresentationProject";
import { resolveBackendPresentationSshHost } from "@/lib/cli/backendPresentationTarget";
import { claimCliRequest } from "@/lib/cli/cliRequestBroker";
import {
	CliManagedRunPresentationError,
	type CliManagedRunPresentationRequest,
	type CliManagedRunPresentationState,
	failCliManagedRunPresentation,
	type ManagedRunPresentationBinding,
	type ManagedRunProjectionInput,
	parseCliManagedRunPresentationRequest,
	projectManagedRunPresentationAgent,
	requireManagedRunPresentationGeneration,
} from "@/lib/cli/managedRunPresentationModel";
import { waitForExactHmuxPaneAttachment } from "@/lib/hmux/hmuxPaneAttachment";
import { inspectHmuxSessionExact } from "@/lib/hmux/identity/exactHmuxSessionInspection";
import { hmuxManagedGeneration } from "@/lib/hmux/identity/hmuxManagedGeneration";
import { resolveRemoteHmuxStandaloneController } from "@/lib/hmux/remote/remoteHmuxControllerResolution";
import { type HmuxSessionSummary, hmux } from "@/lib/ipc";
import {
	hmuxManagedBinding,
	remoteHmuxManagedBinding,
} from "@/lib/terminal/terminalBinding";
import { requestDesktopPrewarm } from "@/lib/workspace/desktop/desktopPrewarm";
import { openAgentPanel, resolvePaneById } from "@/lib/workspace/dock";
import { waitForDesktopDockview } from "@/lib/workspace/dock/dockRegistry";
import type { PanelPosition } from "@/lib/workspace/pane/panePlacement";
import { spaceWindowLabel } from "@/lib/workspace/window/windowLabel";
import { useStore } from "@/store";
import type { Agent, Project } from "@/types";

export type ManagedRunPanePresentationRequest =
	CliManagedRunPresentationRequest & {
		panePosition?: PanelPosition;
		presentationWorktree?: AgentRunPresentationWorktree;
	};

export interface ManagedRunPaneCommit {
	readonly spaceId: string;
	readonly desktopId: string;
	readonly panelId: string;
	readonly agentId: string;
	readonly sessionId: string;
	readonly workspaceId: string;
	readonly runtime: "hmux_managed_v1";
	readonly outcome: "created" | "reused";
}

/** The Dockview commit already happened; only the bounded attachment
 * confirmation failed. Callers must not reinterpret this as a pane-less
 * presentation and open a second/background path. */
export class ManagedRunPaneCommittedError extends CliManagedRunPresentationError {
	readonly phase = "pane_committed" as const;

	constructor(
		readonly pane: ManagedRunPaneCommit,
		readonly attachmentFailure: unknown,
	) {
		const failure = errorPayload(attachmentFailure);
		super(failure.code, failure.message);
		this.name = "ManagedRunPaneCommittedError";
	}
}

export interface CliManagedRunPresentationDependencies {
	claim(reqId: string): Promise<boolean>;
	windowLabel(): string;
	readState(): CliManagedRunPresentationState;
	setState(
		project: (
			state: CliManagedRunPresentationState,
		) => Partial<CliManagedRunPresentationState>,
	): void;
	ensureProject(path: string, hostId?: string): Promise<Project>;
	inspectBinding(
		request: CliManagedRunPresentationRequest,
		state: CliManagedRunPresentationState,
	): Promise<ManagedRunPresentationBinding>;
	resolveReference(panelId: string): Promise<{
		desktopId: string;
		panelId: string;
	}>;
	requestSpaceMount(spaceId: string): void;
	waitForSpace(spaceId: string): Promise<unknown | undefined>;
	openAgent(
		spaceId: string,
		agent: Agent,
		position?: PanelPosition,
	): string | false;
	waitForAttachment(identity: {
		desktopId: string;
		panelId: string;
		sessionId: string;
		workspaceId: string;
	}): Promise<unknown>;
}

function requireLocalManagedSession(
	session: HmuxSessionSummary | undefined,
	request: ManagedRunProjectionInput,
) {
	if (!session) {
		failCliManagedRunPresentation(
			"managed_session_not_found",
			"managed Run session was not found",
		);
	}
	if (
		session.sessionId !== request.sessionId ||
		session.workspaceId !== request.workspaceId ||
		session.sessionClass !== "managed" ||
		session.lifecycle !== "ready" ||
		!session.stopFence
	) {
		failCliManagedRunPresentation(
			"managed_session_identity_mismatch",
			"managed Run session is not one exact ready Host generation",
		);
	}
	requireManagedRunPresentationGeneration(
		session.stopFence,
		request.generation,
	);
	return session;
}

export async function inspectManagedRunPresentationBinding(
	request: ManagedRunProjectionInput,
	state: CliManagedRunPresentationState,
): Promise<ManagedRunPresentationBinding> {
	const createIdempotencyKey = request.launchIdempotencyKey;
	if (request.source === "local") {
		const session = requireLocalManagedSession(
			await inspectHmuxSessionExact({
				sessionId: request.sessionId,
				workspaceId: request.workspaceId,
			}),
			request,
		);
		return {
			...hmuxManagedBinding(
				request.sessionId,
				request.workspaceId,
				undefined,
				undefined,
				session.stopFence,
				request.backendProfileId,
			),
			createIdempotencyKey,
		};
	}
	const host = resolveBackendPresentationSshHost(
		request,
		state.sshHosts,
		failCliManagedRunPresentation,
	);
	const provisional = remoteHmuxManagedBinding(
		request.sessionId,
		request.workspaceId,
		host.id,
		`bridge_${request.agentId}`,
		createIdempotencyKey,
	);
	const { session } = await resolveRemoteHmuxStandaloneController(
		state.sshHosts,
		provisional,
	);
	if (session.providerId !== request.providerId) {
		failCliManagedRunPresentation(
			"managed_session_identity_mismatch",
			"remote managed Run provider identity changed",
		);
	}
	const generation = hmuxManagedGeneration(session);
	requireManagedRunPresentationGeneration(generation, request.generation);
	return remoteHmuxManagedBinding(
		request.sessionId,
		request.workspaceId,
		host.id,
		provisional.commandBridgeNonce,
		createIdempotencyKey,
		generation,
		undefined,
		undefined,
		request.backendProfileId,
	);
}

async function resolveProject(
	request: CliManagedRunPresentationRequest,
	state: CliManagedRunPresentationState,
	dependencies: CliManagedRunPresentationDependencies,
) {
	const hostId =
		request.source === "ssh"
			? resolveBackendPresentationSshHost(
					request,
					state.sshHosts,
					failCliManagedRunPresentation,
				).id
			: undefined;
	return resolveRunPresentationProject(
		state.projects,
		request.projectPath,
		hostId,
		dependencies.ensureProject,
		failCliManagedRunPresentation,
	);
}

const defaultDependencies: CliManagedRunPresentationDependencies = {
	claim: claimCliRequest,
	windowLabel: () => getCurrentWebviewWindow().label,
	readState: () => useStore.getState(),
	setState: (project) => useStore.setState((state) => project(state)),
	ensureProject: (path, hostId) =>
		useStore.getState().ensureProjectForPath(path, hostId),
	inspectBinding: inspectManagedRunPresentationBinding,
	resolveReference: resolvePaneById,
	requestSpaceMount: requestDesktopPrewarm,
	waitForSpace: waitForDesktopDockview,
	openAgent: openAgentPanel,
	waitForAttachment: (identity) =>
		waitForExactHmuxPaneAttachment(
			{
				...identity,
				windowLabel: getCurrentWebviewWindow().label,
			},
			({ ownerId, sessionId, workspaceId }) =>
				hmux.paneAttachmentStatus(ownerId, sessionId, workspaceId),
		),
};

function errorPayload(error: unknown) {
	return {
		code:
			error &&
			typeof error === "object" &&
			"code" in error &&
			typeof error.code === "string"
				? error.code
				: "managed_run_presentation_failed",
		message: error instanceof Error ? error.message : String(error),
	};
}

function requireTargetSpaceWindow(
	request: CliManagedRunPresentationRequest,
	state: CliManagedRunPresentationState,
	windowLabel: string,
) {
	const targetSpace = state.spaces.find(
		(space) => space.id === request.spaceId,
	);
	if (!targetSpace) {
		failCliManagedRunPresentation(
			"client_space_not_found",
			`Space ${request.spaceId} was not found`,
		);
	}
	let expectedWindowLabel: string;
	try {
		expectedWindowLabel = spaceWindowLabel(targetSpace);
	} catch {
		failCliManagedRunPresentation(
			"client_space_window_changed",
			`Space ${request.spaceId} no longer has a valid window address`,
		);
	}
	if (
		request.windowLabel !== expectedWindowLabel ||
		windowLabel !== expectedWindowLabel
	) {
		failCliManagedRunPresentation(
			"client_space_window_changed",
			`Space ${request.spaceId} moved to another window before presentation`,
		);
	}
}

async function performManagedRunPresentation(
	request: ManagedRunPanePresentationRequest,
	dependencies: CliManagedRunPresentationDependencies,
	authorize: () => Promise<boolean>,
) {
	const initial = dependencies.readState();
	requireTargetSpaceWindow(request, initial, dependencies.windowLabel());
	if (!(await authorize())) return null;
	const binding = await dependencies.inspectBinding(request, initial);
	dependencies.requestSpaceMount(request.spaceId);
	if (!(await dependencies.waitForSpace(request.spaceId))) {
		failCliManagedRunPresentation(
			"client_space_mount_timeout",
			`Space ${request.spaceId} did not publish its Dockview`,
		);
	}
	const project = await resolveProject(
		request,
		dependencies.readState(),
		dependencies,
	);
	const presentationWorktree =
		request.presentationWorktree ??
		snapshotAgentRunPresentationWorktree(
			request.worktree,
			initial.agents,
			project,
			request.providerId,
		);
	let position = request.panePosition;
	if (!position && request.referencePanelId) {
		const reference = await dependencies.resolveReference(
			request.referencePanelId,
		);
		if (reference.desktopId !== request.spaceId) {
			failCliManagedRunPresentation(
				"client_source_pane_changed",
				"invoking pane moved to another Space before presentation",
			);
		}
		position = {
			referencePanel: reference.panelId,
			direction: "right",
		};
	}
	requireTargetSpaceWindow(
		request,
		dependencies.readState(),
		dependencies.windowLabel(),
	);
	const projected = projectManagedRunPresentationAgent(
		dependencies.readState(),
		{ ...request, presentationWorktree },
		project,
		binding,
	);
	dependencies.setState(() => projected.patch);
	const panelId = dependencies.openAgent(
		request.spaceId,
		projected.agent,
		position,
	);
	if (!panelId) {
		failCliManagedRunPresentation(
			"client_space_changed",
			`Space ${request.spaceId} changed before pane commit`,
		);
	}
	const pane: ManagedRunPaneCommit = {
		spaceId: request.spaceId,
		desktopId: request.spaceId,
		panelId,
		agentId: projected.agent.id,
		sessionId: request.sessionId,
		workspaceId: request.workspaceId,
		runtime: "hmux_managed_v1",
		outcome: projected.outcome,
	};
	try {
		await dependencies.waitForAttachment({
			desktopId: pane.desktopId,
			panelId: pane.panelId,
			sessionId: pane.sessionId,
			workspaceId: pane.workspaceId,
		});
	} catch (cause) {
		throw new ManagedRunPaneCommittedError(pane, cause);
	}
	return { ok: true, pane };
}

/** Present one already-created managed Run in this client. The backend Run is
 * authoritative; this transaction only projects it into IDE state and a pane. */
export async function presentManagedRun(
	params: ManagedRunPanePresentationRequest,
	dependencies: CliManagedRunPresentationDependencies = defaultDependencies,
) {
	const result = await performManagedRunPresentation(
		params,
		dependencies,
		async () => true,
	);
	if (!result) {
		failCliManagedRunPresentation(
			"client_presentation_not_authorized",
			"managed Run presentation was not authorized",
		);
	}
	return result;
}

export async function handleCliManagedRunPresentation(
	params: Record<string, unknown>,
	reqId: string,
	dependencies: CliManagedRunPresentationDependencies = defaultDependencies,
) {
	let claimed = false;
	const claim = async () => {
		if (claimed) return true;
		claimed = await dependencies.claim(reqId);
		return claimed;
	};
	try {
		return await performManagedRunPresentation(
			parseCliManagedRunPresentationRequest(params),
			dependencies,
			claim,
		);
	} catch (error) {
		if (!(await claim())) return null;
		if (error instanceof ManagedRunPaneCommittedError) {
			return { ok: true, pane: error.pane };
		}
		return { ok: false, error: errorPayload(error) };
	}
}
