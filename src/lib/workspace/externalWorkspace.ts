import type { ExternalOpenTarget } from "@/lib/ipc/externalWorkspace";
import {
	externalWorkspaceTargets,
	type NativeExternalWorkspaceOpenReceipt,
	openExternalWorkspaceNative,
} from "@/lib/ipc/externalWorkspace";
import { normalizeSlashPath } from "@/lib/files/paths";
import { sessionKindExecutionProfile } from "@/lib/terminal/sessionKindExecutionProfile";
import { getTerminalExecutionLocation } from "@/lib/terminal/terminalExecutionLocationStore";
import { getDockview } from "@/lib/workspace/dock/dockRegistry";
import { dockPanelReference } from "@/lib/workspace/dock/dockPanelParameters";
import { agentIdFromPane } from "@/lib/workspace/layout/agentPaneParameters";
import { bindingFromPane } from "@/lib/terminal/terminalBinding";
import { useStore } from "@/store";
import type { Agent, DetectedWorktree, Project } from "@/types";

interface ExternalWorkspaceReference {
	spaceId: string;
	panelId: string;
}

export interface ExternalWorkspaceOpenRequest
	extends ExternalWorkspaceReference {
	targetId?: string;
}

export interface ExternalWorkspaceOpenReceipt
	extends NativeExternalWorkspaceOpenReceipt,
		ExternalWorkspaceReference {
	kind: "agent" | "project" | "terminal";
}

export class ExternalWorkspaceActionError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly targetId?: string,
	) {
		super(message);
		this.name = "ExternalWorkspaceActionError";
	}
}

interface PaneLike {
	id: string;
	params?: unknown;
	api: { component: string; getParameters(): unknown };
}

interface DockviewLike {
	getPanel(panelId: string): PaneLike | undefined;
}

interface WorkspaceState {
	agents: Agent[];
	projects: Project[];
	detected: Record<string, DetectedWorktree[] | undefined>;
	spaces: { id: string }[];
	sessionCwd: Record<string, string | undefined>;
	uiPrefs: { defaultExternalOpenTargetId?: string };
	setUiPrefs(preferences: { defaultExternalOpenTargetId: string }): void;
}

export interface ExternalWorkspaceDependencies {
	dockview(spaceId: string): DockviewLike | undefined;
	state(): WorkspaceState;
	executionLocation(
		sessionId: string,
	): { kind: "local" } | { kind: "unknown" } | { kind: "ssh"; target: string };
	open(
		path: string,
		targetId: string,
	): Promise<NativeExternalWorkspaceOpenReceipt>;
}

const productionDependencies: ExternalWorkspaceDependencies = {
	dockview: getDockview,
	state: () => useStore.getState(),
	executionLocation: getTerminalExecutionLocation,
	open: openExternalWorkspaceNative,
};

function stringMember(
	value: Record<string, unknown>,
	key: string,
): string | undefined {
	const member = value[key];
	return typeof member === "string" && member.trim()
		? member.trim()
		: undefined;
}

function typedError(
	error: unknown,
	targetId?: string,
): ExternalWorkspaceActionError {
	if (error instanceof ExternalWorkspaceActionError) return error;
	if (error && typeof error === "object" && !Array.isArray(error)) {
		const payload = error as Record<string, unknown>;
		const code = typeof payload.code === "string" ? payload.code : undefined;
		const message =
			typeof payload.message === "string" ? payload.message : undefined;
		if (code && message) {
			return new ExternalWorkspaceActionError(code, message, targetId);
		}
	}
	return new ExternalWorkspaceActionError(
		"external_open_failed",
		error instanceof Error ? error.message : String(error),
		targetId,
	);
}

function localAgentPath(agent: Agent, project: Project | undefined): string {
	if (!project) {
		throw new ExternalWorkspaceActionError(
			"workspace_stale",
			`Project ${agent.projectId} is no longer available.`,
		);
	}
	if (
		project.kind !== "local" ||
		sessionKindExecutionProfile(agent.sessionKind).locationOverride() !==
			undefined
	) {
		throw new ExternalWorkspaceActionError(
			"workspace_remote",
			"Remote workspaces cannot be opened by a local application.",
		);
	}
	if (!agent.worktreePath.trim()) {
		throw new ExternalWorkspaceActionError(
			"workspace_unavailable",
			"The Agent workspace path is unavailable.",
		);
	}
	return agent.worktreePath;
}

function containsPath(root: string, candidate: string): boolean {
	const normalizedRoot = normalizeSlashPath(root.trim());
	const normalizedCandidate = normalizeSlashPath(candidate.trim());
	return (
		normalizedCandidate === normalizedRoot ||
		(normalizedRoot === "/"
			? normalizedCandidate.startsWith("/")
			: normalizedCandidate.startsWith(`${normalizedRoot}/`))
	);
}

function localFileWorkspace(path: string, state: WorkspaceState) {
	const candidates: Array<{
		kind: "agent" | "project";
		path: string;
	}> = [];
	for (const agent of state.agents) {
		const project = state.projects.find(
			(candidate) => candidate.id === agent.projectId,
		);
		if (
			project?.kind !== "local" ||
			sessionKindExecutionProfile(agent.sessionKind).locationOverride() !==
				undefined ||
			!agent.worktreePath.trim() ||
			!containsPath(agent.worktreePath, path)
		) {
			continue;
		}
		candidates.push({ kind: "agent", path: agent.worktreePath });
	}
	for (const project of state.projects) {
		if (project.kind === "local") {
			for (const worktree of state.detected[project.id] ?? []) {
				if (worktree.path.trim() && containsPath(worktree.path, path)) {
					candidates.push({ kind: "project", path: worktree.path });
				}
			}
		}
		if (
			project.kind === "local" &&
			project.path.trim() &&
			containsPath(project.path, path)
		) {
			candidates.push({ kind: "project", path: project.path });
		}
	}
	return candidates.sort((left, right) => {
		const depth =
			normalizeSlashPath(right.path).length -
			normalizeSlashPath(left.path).length;
		if (depth || left.kind === right.kind) return depth;
		return left.kind === "agent" ? -1 : 1;
	})[0];
}

function resolveWorkspace(
	reference: ExternalWorkspaceReference,
	dependencies: ExternalWorkspaceDependencies,
) {
	const state = dependencies.state();
	if (!state.spaces.some((space) => space.id === reference.spaceId)) {
		throw new ExternalWorkspaceActionError(
			"workspace_stale",
			`Space ${reference.spaceId} is no longer available.`,
		);
	}
	const dockview = dependencies.dockview(reference.spaceId);
	const panel = dockview?.getPanel(reference.panelId);
	if (!dockview || !panel) {
		throw new ExternalWorkspaceActionError(
			"workspace_stale",
			`Pane ${reference.panelId} is no longer available in Space ${reference.spaceId}.`,
		);
	}
	const pane = dockPanelReference(panel);
	const { params, component } = pane;
	const agentId = component === "diff"
		? stringMember(params, "agentId")
		: agentIdFromPane(pane);
	if (component === "agent" || agentId) {
		const agent = state.agents.find((candidate) => candidate.id === agentId);
		if (!agent) {
			throw new ExternalWorkspaceActionError(
				"workspace_stale",
				`Agent ${agentId} is no longer available.`,
			);
		}
		return {
			dockview,
			panel,
			kind: "agent" as const,
			path: localAgentPath(
				agent,
				state.projects.find((project) => project.id === agent.projectId),
			),
		};
	}

	const projectId = ["git", "github", "diff"].includes(component ?? "")
		? stringMember(params, "projectId")
		: undefined;
	if (projectId) {
		const project = state.projects.find(
			(candidate) => candidate.id === projectId,
		);
		if (!project) {
			throw new ExternalWorkspaceActionError(
				"workspace_stale",
				`Project ${projectId} is no longer available.`,
			);
		}
		if (project.kind !== "local") {
			throw new ExternalWorkspaceActionError(
				"workspace_remote",
				"Remote workspaces cannot be opened by a local application.",
			);
		}
		return {
			dockview,
			panel,
			kind: "project" as const,
			path: project.path,
		};
	}

	if (component === "fileviewer") {
		const source = stringMember(params, "source");
		if (source === "ssh") {
			throw new ExternalWorkspaceActionError(
				"workspace_remote",
				"Remote workspaces cannot be opened by a local application.",
			);
		}
		const filePath = source === "local" ? stringMember(params, "path") : undefined;
		if (!filePath) {
			throw new ExternalWorkspaceActionError(
				"workspace_stale",
				"The selected file pane does not identify a local file target.",
			);
		}
		const workspace = localFileWorkspace(filePath, state);
		if (!workspace) {
			throw new ExternalWorkspaceActionError(
				"workspace_unavailable",
				"This pane does not expose an authoritative local workspace path.",
			);
		}
		return { dockview, panel, ...workspace };
	}

	if (component !== "terminal" && component !== "ssh" && component !== "diff") {
		throw new ExternalWorkspaceActionError(
			"workspace_unavailable",
			"This pane does not expose an authoritative local workspace path.",
		);
	}
	const binding = bindingFromPane(pane, state.agents, state.projects);
	if (params.binding !== undefined && !binding) {
		throw new ExternalWorkspaceActionError(
			"workspace_stale",
			"The terminal target has changed.",
		);
	}
	const sessionId =
		binding?.sessionId ?? stringMember(params, "sessionId");
	const executionLocation = sessionId
		? dependencies.executionLocation(sessionId)
		: { kind: "local" as const };
	if (executionLocation.kind === "unknown") {
		throw new ExternalWorkspaceActionError(
			"workspace_unavailable",
			"The terminal execution location has not been resolved yet.",
		);
	}
	const remote =
		component === "ssh" ||
		binding?.source === "ssh" ||
		(stringMember(params, "hostId") !== undefined &&
			stringMember(params, "hostId") !== "local") ||
		executionLocation.kind === "ssh";
	if (remote) {
		throw new ExternalWorkspaceActionError(
			"workspace_remote",
			"Remote workspaces cannot be opened by a local application.",
		);
	}
	const path =
		(sessionId ? state.sessionCwd[sessionId]?.trim() : undefined) ??
		stringMember(params, "cwd");
	if (!path) {
		throw new ExternalWorkspaceActionError(
			"workspace_unavailable",
			"This pane does not expose an authoritative local workspace path.",
		);
	}
	return { dockview, panel, kind: "terminal" as const, path };
}

/** Resolves the current pane generation immediately before the native launch. */
export async function openExternalWorkspaceForPane(
	request: ExternalWorkspaceOpenRequest,
	dependencies: ExternalWorkspaceDependencies = productionDependencies,
): Promise<ExternalWorkspaceOpenReceipt> {
	const targetId =
		request.targetId?.trim() ||
		dependencies.state().uiPrefs.defaultExternalOpenTargetId;
	if (!targetId) {
		throw new ExternalWorkspaceActionError(
			"target_required",
			"Choose an external application before opening this workspace.",
		);
	}
	const resolved = resolveWorkspace(request, dependencies);
	if (
		dependencies.dockview(request.spaceId) !== resolved.dockview ||
		resolved.dockview.getPanel(request.panelId) !== resolved.panel
	) {
		throw new ExternalWorkspaceActionError(
			"workspace_stale",
			"The selected pane changed before the workspace could be opened.",
			targetId,
		);
	}
	try {
		const receipt = await dependencies.open(resolved.path, targetId);
		dependencies
			.state()
			.setUiPrefs({ defaultExternalOpenTargetId: receipt.targetId });
		return {
			...receipt,
			spaceId: request.spaceId,
			panelId: request.panelId,
			kind: resolved.kind,
		};
	} catch (error) {
		throw typedError(error, targetId);
	}
}

export function loadExternalOpenTargets(): Promise<
	readonly ExternalOpenTarget[]
> {
	return externalWorkspaceTargets();
}
