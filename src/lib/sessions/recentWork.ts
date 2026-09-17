import type {
	ProviderConversationRecord,
	ProviderConversationTurn,
} from "@/lib/agents/providerConversationDiscovery";
import { normalizeSlashPath } from "@/lib/files/paths";
import { repositoryNameFromRemote } from "@/lib/spaces/repositoryDisplayName";
import type { Agent, AgentActivity, Project, Provider } from "@/types";
import { PROVIDERS } from "@/types";

export type RecentWorkConversation = ProviderConversationRecord;

export interface RecentSessionRegistrationDecision {
	kind: "register_or_import";
	provider: Provider;
	conversationId: string;
	cwd: string;
	workspaceRoot: string;
	workspaceKind: "git_repository" | "standalone_folder";
	groupIdentity: string;
	executionLocation: "local" | "ssh";
	hostId?: string;
	repositoryRemoteIdentity?: string;
	title: string;
	mtime: number;
	defaultSelected: boolean;
}

type RecentWorkAction =
	| { kind: "focus"; agentId: string }
	| {
			kind: "register_and_resume";
			decision: RecentSessionRegistrationDecision;
	  }
	| {
			kind: "needs_registration_decision";
			decision: RecentSessionRegistrationDecision;
	  };

export interface RecentWorkItem {
	key: string;
	conversationId: string;
	/** Exact persisted Agent that may already have a pane. Presentation hint only;
	 * activation still resolves the current managed generation. */
	paneAgentIdCandidate?: string;
	title: string;
	mtime: number;
	provider: Provider;
	cwd: string;
	workspaceRoot: string;
	groupIdentity: string;
	defaultSelected: boolean;
	recencyBucket: "recent" | "older";
	executionLocation: "local" | "ssh";
	hostId?: string;
	repositoryCommonDir?: string;
	repositoryRemoteIdentity?: string;
	branch?: string;
	model?: string;
	effort?: string;
	recentTurns: readonly ProviderConversationTurn[];
	subagentCount: number;
	action: RecentWorkAction;
}

export interface RecentWorkGroup {
	id: string;
	name: string;
	cwd: string;
	items: RecentWorkItem[];
}

export interface RecentWorkProjection {
	groups: RecentWorkGroup[];
	total: number;
}

function normalized(value: string): string {
	return value.normalize("NFKC").toLocaleLowerCase().trim();
}

function samePath(left: string, right: string): boolean {
	return normalizeSlashPath(left) === normalizeSlashPath(right);
}

function containsPath(root: string, candidate: string): boolean {
	const normalizedRoot = normalizeSlashPath(root).replace(/\/$/, "");
	const normalizedCandidate = normalizeSlashPath(candidate);
	return (
		normalizedCandidate === normalizedRoot ||
		normalizedCandidate.startsWith(`${normalizedRoot}/`)
	);
}

function pathName(value: string): string {
	const segments = normalizeSlashPath(value).split("/").filter(Boolean);
	return segments[segments.length - 1] ?? "/";
}

function isLive(activity: AgentActivity | undefined): boolean {
	return activity !== "exited";
}

function agentLocationMatches(
	entry: RecentWorkConversation,
	agent: Agent,
	projects: readonly Project[],
): boolean {
	const binding = agent.runtimeBinding;
	if (!binding) {
		return (
			entry.executionLocation === "local" &&
			projects.some(
				(project) => project.id === agent.projectId && project.kind === "local",
			)
		);
	}
	return (
		binding.source === entry.executionLocation &&
		binding.hostId ===
			(entry.executionLocation === "local" ? "local" : entry.hostId)
	);
}

function findLiveOwner(
	agents: readonly Agent[],
	projects: readonly Project[],
	activity: Readonly<Record<string, AgentActivity>>,
	entry: RecentWorkConversation,
): Agent | undefined {
	return agents.find(
		(agent) =>
			agent.provider === entry.provider &&
			agent.conversationId?.trim() === entry.id &&
			agentLocationMatches(entry, agent, projects) &&
			isLive(activity[agent.id]),
	);
}

function findManagedOwnerCandidate(
	agents: readonly Agent[],
	projects: readonly Project[],
	entry: RecentWorkConversation,
): Agent | undefined {
	if (entry.executionLocation !== "local") return undefined;
	return agents.find(
		(agent) =>
			agent.provider === entry.provider &&
			agent.conversationId?.trim() === entry.id &&
			agentLocationMatches(entry, agent, projects) &&
			agent.runtimeBinding?.runtime === "hmux_managed_v1" &&
			agent.runtimeBinding.source === "local" &&
			agent.runtimeBinding.hostId === "local",
	);
}

function repositoryName(
	entry: Pick<
		RecentWorkConversation,
		"repositoryCommonDir" | "repositoryRoot" | "repositoryRemoteIdentity"
	>,
): string | undefined {
	const remoteName = entry.repositoryRemoteIdentity
		? repositoryNameFromRemote(entry.repositoryRemoteIdentity)
		: undefined;
	if (remoteName) return remoteName;
	const commonDir = entry.repositoryCommonDir
		? normalizeSlashPath(entry.repositoryCommonDir)
		: undefined;
	if (commonDir) {
		const segments = commonDir.split("/").filter(Boolean);
		const marker = segments[segments.length - 1];
		if (marker === ".git") return segments[segments.length - 2];
		if (marker?.endsWith(".git") && marker.length > 4) {
			return marker.slice(0, -4);
		}
	}
	return entry.repositoryRoot ? pathName(entry.repositoryRoot) : undefined;
}

function preferredRepositoryGroupName(
	items: readonly RecentWorkItem[],
): string | undefined {
	const candidates = new Map<
		string,
		{ name: string; count: number; newestMtime: number }
	>();
	for (const item of items) {
		const name = repositoryName({
			repositoryCommonDir: item.repositoryCommonDir,
			repositoryRoot: item.workspaceRoot,
			repositoryRemoteIdentity: item.repositoryRemoteIdentity,
		});
		if (!name) continue;
		const key = normalized(name);
		const previous = candidates.get(key);
		candidates.set(key, {
			name: previous?.name ?? name,
			count: (previous?.count ?? 0) + 1,
			newestMtime: Math.max(previous?.newestMtime ?? 0, item.mtime),
		});
	}
	return [...candidates.values()].sort(
		(left, right) =>
			right.count - left.count ||
			right.newestMtime - left.newestMtime ||
			left.name.localeCompare(right.name),
	)[0]?.name;
}

function groupName(
	entry: RecentWorkConversation,
	agents: readonly Agent[],
	projects: readonly Project[],
): string {
	const repository = repositoryName(entry);
	if (repository) return repository;
	const cwd = entry.cwd;
	const projectById = new Map(projects.map((project) => [project.id, project]));
	const agentProject = agents
		.filter((agent) => samePath(agent.worktreePath, cwd))
		.map((agent) => projectById.get(agent.projectId))
		.find((project): project is Project => project !== undefined);
	if (agentProject) return agentProject.name;
	return (
		projects.find(
			(project) => project.kind === "local" && samePath(project.path, cwd),
		)?.name ?? pathName(cwd)
	);
}

const DEFAULT_SELECTED_AGE_SECONDS = 7 * 24 * 60 * 60;
const MAX_VISIBLE_AGE_SECONDS = 30 * 24 * 60 * 60;

function hostIdentity(
	entry: RecentWorkConversation,
	uniqueKey: string,
): string {
	if (entry.executionLocation === "local") return "local";
	return entry.hostId ? `ssh\0${entry.hostId}` : `ssh\0unknown\0${uniqueKey}`;
}

function repositoryInstanceIdentity(
	entry: RecentWorkConversation,
	uniqueKey: string,
): string {
	return `${hostIdentity(entry, uniqueKey)}\0${entry.repositoryCommonDir ?? entry.repositoryRoot ?? entry.cwd}`;
}

function knownWorkspaceRoot(
	entry: RecentWorkConversation,
	agents: readonly Agent[],
	projects: readonly Project[],
): string {
	const candidates = [
		entry.repositoryRoot,
		...agents
			.filter((agent) => agentLocationMatches(entry, agent, projects))
			.map((agent) => agent.worktreePath),
		...projects
			.filter((project) =>
				entry.executionLocation === "local"
					? project.kind === "local"
					: project.kind === "ssh" && project.sshHostId === entry.hostId,
			)
			.map((project) => project.path),
	]
		.filter((path): path is string => Boolean(path))
		.filter((path) => containsPath(path, entry.cwd));
	return (
		candidates.sort(
			(left, right) =>
				normalizeSlashPath(right).length - normalizeSlashPath(left).length,
		)[0] ?? entry.cwd
	);
}

/** Project provider-owned global records into user-actionable recent sessions.
 *
 * Registration and Hmux ownership never filter inventory. They are consulted
 * only after discovery to optimize a click into focus or exact managed resume.
 * An unregistered local cwd returns a just-in-time registration plan; remote
 * records retain an explicit host-scoped decision. This pure layer never creates
 * a project, trust grant, desktop, agent, process, or network request. */
export function projectRecentWork(input: {
	entries: readonly RecentWorkConversation[];
	agents: readonly Agent[];
	projects: readonly Project[];
	activity: Readonly<Record<string, AgentActivity>>;
	query?: string;
	limit?: number;
	nowSeconds?: number;
}): RecentWorkProjection {
	const query = normalized(input.query ?? "");
	const limit = Math.max(0, input.limit ?? 8);
	const nowSeconds = input.nowSeconds ?? Date.now() / 1000;
	const eligibleEntries = input.entries.filter(
		(entry) =>
			entry.resumeCapability === "exact" &&
			entry.workingDirectoryAvailable !== false &&
			Math.max(0, nowSeconds - entry.mtime) <= MAX_VISIBLE_AGE_SECONDS,
	);
	const items = eligibleEntries
		.flatMap((entry): RecentWorkItem[] => {
			const age = Math.max(0, nowSeconds - entry.mtime);
			const recencyBucket =
				age <= DEFAULT_SELECTED_AGE_SECONDS ? "recent" : "older";
			const defaultSelected =
				recencyBucket === "recent" &&
				entry.interactionKind !== "non_interactive";
			const workspaceRoot = knownWorkspaceRoot(
				entry,
				input.agents,
				input.projects,
			);
			const uniqueKey = `${entry.provider}\0${entry.id}`;
			const remote = entry.repositoryRemoteIdentity?.trim();
			const groupIdentity = remote
				? `remote\0${remote}`
				: repositoryInstanceIdentity(entry, uniqueKey);
			// A persisted managed Agent is only a candidate. Client activity cannot
			// prove that its exact workspace/session generation still exists, so the
			// click must resolve Hmux ownership before it focuses or creates.
			const managedOwner = findManagedOwnerCandidate(
				input.agents,
				input.projects,
				entry,
			);
			const live = managedOwner
				? undefined
				: findLiveOwner(input.agents, input.projects, input.activity, entry);
			const paneAgentCandidate =
				live ??
				(managedOwner && isLive(input.activity[managedOwner.id])
					? managedOwner
					: undefined);
			const registrationDecision: RecentSessionRegistrationDecision = {
				kind: "register_or_import",
				provider: entry.provider,
				conversationId: entry.id,
				cwd: entry.cwd,
				workspaceRoot,
				workspaceKind: entry.repositoryRoot
					? "git_repository"
					: "standalone_folder",
				groupIdentity,
				executionLocation: entry.executionLocation,
				...(entry.hostId ? { hostId: entry.hostId } : {}),
				...(remote ? { repositoryRemoteIdentity: remote } : {}),
				title: entry.title,
				mtime: entry.mtime,
				defaultSelected,
			};
			const action: RecentWorkAction = live
				? { kind: "focus", agentId: live.id }
				: {
						kind:
							entry.executionLocation === "local"
								? "register_and_resume"
								: "needs_registration_decision",
						decision: registrationDecision,
					};

			const name = groupName(entry, input.agents, input.projects);
			if (query) {
				const searchable = normalized(
					[
						entry.title,
						name,
						entry.cwd,
						workspaceRoot,
						PROVIDERS[entry.provider].label,
						entry.branch,
						entry.model,
						entry.effort,
						...(entry.recentTurns?.map((turn) => turn.text) ?? []),
					]
						.filter(Boolean)
						.join("\n"),
				);
				if (!searchable.includes(query)) return [];
			}

			return [
				{
					key: `${hostIdentity(entry, uniqueKey)}\0${uniqueKey}`,
					conversationId: entry.id,
					...(paneAgentCandidate
						? { paneAgentIdCandidate: paneAgentCandidate.id }
						: {}),
					title: entry.title,
					mtime: entry.mtime,
					provider: entry.provider,
					cwd: entry.cwd,
					workspaceRoot,
					groupIdentity,
					defaultSelected,
					recencyBucket,
					recentTurns: entry.recentTurns ?? [],
					subagentCount: entry.subagentCount ?? 0,
					executionLocation: entry.executionLocation,
					...(entry.branch ? { branch: entry.branch } : {}),
					...(entry.model ? { model: entry.model } : {}),
					...(entry.effort ? { effort: entry.effort } : {}),
					...(entry.hostId ? { hostId: entry.hostId } : {}),
					...(entry.repositoryCommonDir
						? { repositoryCommonDir: entry.repositoryCommonDir }
						: {}),
					...(remote ? { repositoryRemoteIdentity: remote } : {}),
					action,
				},
			];
		})
		.sort((left, right) => right.mtime - left.mtime)
		.slice(0, limit);

	const groups = new Map<string, RecentWorkGroup>();
	for (const item of items) {
		const id = item.groupIdentity;
		const group = groups.get(id) ?? {
			id,
			name: pathName(item.workspaceRoot),
			cwd: item.workspaceRoot,
			items: [],
		};
		group.items.push(item);
		group.name = preferredRepositoryGroupName(group.items) ?? group.name;
		groups.set(id, group);
	}

	return { groups: [...groups.values()], total: items.length };
}
