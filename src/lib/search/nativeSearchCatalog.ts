import { pathBasename } from "@/lib/files/paths";
import {
	attentionEquivalentState,
	type AgentDisplayState,
	presentedAgentDisplayState,
} from "@/lib/agents/agentStateModel";
import { agentDisplayName } from "@/lib/agents/agentDisplayName";
import { panelsFromLayout } from "@/lib/workspace/layout/layoutLifecycle";
import type { SerializedPanelRef } from "@/lib/workspace/layout/layoutLifecycle";
import { agentIdFromPane } from "@/lib/workspace/layout/agentPaneParameters";
import { terminalSessionFromPanel } from "@/lib/workspace/layout/terminalSessionRefs";
import { bindingFromPane } from "@/lib/terminal/terminalBinding";
import {
	type NativeSearchItem,
	type NativeSearchStatus,
	nativeSearchStatus,
} from "@/lib/search/nativeSearch";
import {
	type Agent,
	type AgentActivity,
	type Space,
	type DetectedWorktree,
	PROVIDERS,
	type Project,
	type Provider,
	type SshHostConfig,
	type SshState,
} from "@/types";
import { sessionRuntimeDisplayState } from "@/lib/sessions/runtime/sessionRuntimeDisplayState";
import type { HmuxAgentRuntimeState } from "@/lib/ipc";

export interface NativeSearchPanelSnapshot extends SerializedPanelRef {
	desktopId: string;
}

export interface NativeSearchFileContext {
	id: string;
	label: string;
	root: string;
	source: "local" | "ssh";
	hostId?: string;
}

export interface NativeSearchCatalogInput {
	activeSpaceId: string;
	spaces: readonly Space[];
	layouts: Readonly<Record<string, unknown>>;
	livePanels?: readonly NativeSearchPanelSnapshot[];
	projects: readonly Project[];
	agents: readonly Agent[];
	detected: Readonly<Record<string, readonly DetectedWorktree[]>>;
	sshHosts: readonly SshHostConfig[];
	agentActivity: Readonly<Record<string, AgentActivity>>;
	agentDisplayStates: Readonly<Record<string, AgentDisplayState>>;
	sessionAgentRuntimeState: Readonly<
		Record<
			string,
			Pick<HmuxAgentRuntimeState, "lifecycle" | "activity" | "attention">
		>
	>;
	sessionCwd: Readonly<Record<string, string>>;
	sessionAgent: Readonly<Record<string, Provider | null>>;
	sessionAgentPin: Readonly<Record<string, Provider>>;
	sessionTitle: Readonly<Record<string, string>>;
	sessionActivity: Readonly<Record<string, { text: string; at?: number }>>;
	sshStates: Readonly<Record<string, SshState>>;
}

interface WorktreeCandidate {
	id: string;
	path: string;
	branch: string;
	project: Project;
	agent?: Agent;
	external?: DetectedWorktree;
}

function recordOf(value: unknown): Record<string, unknown> {
	return value && typeof value === "object"
		? (value as Record<string, unknown>)
		: {};
}

function stringField(value: unknown, key: string): string | undefined {
	const field = recordOf(value)[key];
	return typeof field === "string" && field ? field : undefined;
}

function joinDetail(parts: readonly (string | undefined | false)[]): string {
	return parts
		.filter((part): part is string => typeof part === "string" && !!part)
		.join(" · ");
}

function allPanelSnapshots(
	input: NativeSearchCatalogInput,
): NativeSearchPanelSnapshot[] {
	const snapshots: NativeSearchPanelSnapshot[] = [];
	const seen = new Set<string>();
	const livePanels = [...(input.livePanels ?? [])].sort(
		(left, right) =>
			Number(right.desktopId === input.activeSpaceId) -
			Number(left.desktopId === input.activeSpaceId),
	);
	for (const panel of livePanels) {
		if (seen.has(panel.id)) continue;
		seen.add(panel.id);
		snapshots.push(panel);
	}
	const spaces = [...input.spaces].sort(
		(left, right) =>
			Number(right.id === input.activeSpaceId) -
			Number(left.id === input.activeSpaceId),
	);
	for (const desktop of spaces) {
		for (const panel of panelsFromLayout(input.layouts[desktop.id])) {
			if (seen.has(panel.id)) continue;
			seen.add(panel.id);
			snapshots.push({ desktopId: desktop.id, ...panel });
		}
	}
	return snapshots;
}

function worktreeCandidates(
	input: Pick<NativeSearchCatalogInput, "projects" | "agents" | "detected">,
): WorktreeCandidate[] {
	const projectById = new Map(
		input.projects.map((project) => [project.id, project]),
	);
	const byLocation = new Map<string, WorktreeCandidate>();
	const locationKey = (project: Project, path: string) =>
		`${project.kind}:${project.sshHostId ?? ""}:${path.replace(/\/+$/, "")}`;

	for (const agent of input.agents) {
		const project = projectById.get(agent.projectId);
		if (!project) continue;
		const key = locationKey(project, agent.worktreePath);
		const previous = byLocation.get(key);
		if (!previous || previous.agent === undefined) {
			byLocation.set(key, {
				id: key,
				path: agent.worktreePath,
				branch: agent.branch,
				project,
				agent,
			});
		}
	}
	for (const project of input.projects) {
		for (const detected of input.detected[project.id] ?? []) {
			const key = locationKey(project, detected.path);
			if (byLocation.has(key)) continue;
			byLocation.set(key, {
				id: key,
				path: detected.path,
				branch: detected.branch,
				project,
				external: detected,
			});
		}
		const rootKey = locationKey(project, project.path);
		if (!byLocation.has(rootKey)) {
			byLocation.set(rootKey, {
				id: rootKey,
				path: project.path,
				branch: "",
				project,
			});
		}
	}
	return [...byLocation.values()];
}

function panelStatus(
	input: NativeSearchCatalogInput,
	sessionId: string,
	source: "local" | "ssh",
): NativeSearchStatus | undefined {
	const observed = sessionRuntimeDisplayState(
		input.sessionAgentRuntimeState[sessionId],
	);
	if (observed) {
		return observed === "blocked" ? "blocked" : nativeSearchStatus(observed);
	}
	if (source === "ssh") {
		const sshState = input.sshStates[sessionId];
		if (sshState) return nativeSearchStatus(sshState);
	}
	return undefined;
}

export function buildNativeSearchCatalog(
	input: NativeSearchCatalogInput,
): NativeSearchItem[] {
	const items: NativeSearchItem[] = [];
	const projectById = new Map(
		input.projects.map((project) => [project.id, project]),
	);
	const desktopById = new Map(
		input.spaces.map((desktop) => [desktop.id, desktop]),
	);
	const hostById = new Map(input.sshHosts.map((host) => [host.id, host]));
	const panels = allPanelSnapshots(input);
	const panelByAgentId = new Map<string, NativeSearchPanelSnapshot>();
	for (const panel of panels) {
		const agentId = agentIdFromPane(panel);
		if (agentId && !panelByAgentId.has(agentId)) panelByAgentId.set(agentId, panel);
	}

	for (const agent of input.agents) {
		const project = projectById.get(agent.projectId);
		const panel = panelByAgentId.get(agent.id);
		const provider = PROVIDERS[agent.provider].label;
		items.push({
			id: `agent:${agent.id}`,
			kind: "agent",
			title: agentDisplayName(agent),
			detail: joinDetail([
				provider,
				project?.name,
				agent.branch,
				panel ? desktopById.get(panel.desktopId)?.name : undefined,
			]),
			keywords: [
				agent.name,
				agent.id,
				agent.sessionId,
				agent.worktreePath,
				project?.path ?? "",
			],
			// 검색 결과 상태 칩은 error를 blocked(주의 필요)로 정규화한다 —
			// nativeSearchStatus의 "error"는 SSH 연결 오류(→exited) 의미다.
			status: nativeSearchStatus(
				attentionEquivalentState(
					presentedAgentDisplayState(
						input.agentDisplayStates[agent.id],
						input.agentActivity[agent.id],
					),
				),
			),
			action: panel
				? { type: "focus-panel", desktopId: panel.desktopId, panelId: panel.id }
				: {
						type: "open-agent",
						agentId: agent.id,
						desktopId: input.activeSpaceId,
					},
		});
	}

	for (const panel of panels) {
		const terminal = terminalSessionFromPanel(panel);
		if (!terminal) continue;
		const binding = bindingFromPane(panel, input.agents, input.projects);
		if (panel.params.binding !== undefined && !binding) continue;
		const source = binding?.source ?? (terminal.kind === "ssh" ? "ssh" : "local");
		const sessionId = terminal.sessionId;
		const cwd =
			input.sessionCwd[sessionId] ?? stringField(panel.params, "cwd") ?? "";
		const hostId = binding?.source === "ssh" ? binding.hostId : stringField(panel.params, "hostId");
		const provider =
			input.sessionAgentPin[sessionId] ?? input.sessionAgent[sessionId];
		const title =
			input.sessionActivity[sessionId]?.text ??
			input.sessionTitle[sessionId] ??
			pathBasename(cwd) ??
			sessionId;
		items.push({
			id: `session:${panel.id}`,
			kind: "session",
			title: title || sessionId,
			detail: joinDetail([
				provider ? PROVIDERS[provider].label : undefined,
				source === "ssh"
					? (hostById.get(hostId ?? "")?.name ?? hostId)
					: undefined,
				desktopById.get(panel.desktopId)?.name,
				cwd,
			]),
			keywords: [sessionId, panel.id, cwd],
			status: panelStatus(input, sessionId, source),
			action: {
				type: "focus-panel",
				desktopId: panel.desktopId,
				panelId: panel.id,
			},
		});
	}

	for (const worktree of worktreeCandidates(input)) {
		const host = worktree.project.sshHostId
			? hostById.get(worktree.project.sshHostId)
			: undefined;
		const panel = worktree.agent
			? panelByAgentId.get(worktree.agent.id)
			: undefined;
		const externalProviders = worktree.external
			? [
					worktree.external.codexSessions > 0 ? "Codex" : undefined,
					worktree.external.claudeSessions > 0 ? "Claude" : undefined,
				]
			: [];
		items.push({
			id: `worktree:${worktree.id}`,
			kind: "worktree",
			title: pathBasename(worktree.path),
			detail: joinDetail([
				worktree.branch || undefined,
				worktree.project.name,
				host?.name,
				worktree.path,
			]),
			keywords: [
				worktree.project.path,
				worktree.agent?.name ?? "",
				...externalProviders.filter(
					(provider): provider is string => !!provider,
				),
			],
			status: worktree.agent
				? nativeSearchStatus(
						attentionEquivalentState(
							presentedAgentDisplayState(
								input.agentDisplayStates[worktree.agent.id],
								input.agentActivity[worktree.agent.id],
							),
						),
					)
				: undefined,
			action:
				worktree.agent && panel
					? {
							type: "focus-panel",
							desktopId: panel.desktopId,
							panelId: panel.id,
						}
					: worktree.agent
						? {
								type: "open-agent",
								agentId: worktree.agent.id,
								desktopId: input.activeSpaceId,
							}
						: {
								type: "open-worktree",
								path: worktree.path,
								source: worktree.project.kind,
								hostId: worktree.project.sshHostId,
							},
		});
	}

	for (const project of input.projects) {
		if (!project.isRepo) continue;
		const projectAgents = input.agents.filter(
			(agent) => agent.projectId === project.id,
		);
		const branches = projectAgents.map((agent) => agent.branch).filter(Boolean);
		items.push({
			id: `repository:${project.id}`,
			kind: "repository",
			title: project.name,
			detail: joinDetail([
				project.kind === "ssh"
					? hostById.get(project.sshHostId ?? "")?.name
					: undefined,
				project.path,
			]),
			keywords: branches,
			action: {
				type: "open-repository",
				projectId: project.id,
				name: project.name,
			},
		});
	}

	return items;
}

export function nativeSearchFileContexts(
	input: Pick<NativeSearchCatalogInput, "projects" | "agents" | "detected">,
): NativeSearchFileContext[] {
	const contexts: NativeSearchFileContext[] = [];
	const seen = new Set<string>();
	for (const worktree of worktreeCandidates(input)) {
		if (seen.has(worktree.id)) continue;
		seen.add(worktree.id);
		contexts.push({
			id: worktree.id,
			label: worktree.agent?.name ?? worktree.project.name,
			root: worktree.path,
			source: worktree.project.kind,
			hostId: worktree.project.sshHostId,
		});
	}
	return contexts;
}
