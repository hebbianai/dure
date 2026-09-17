import { normalizeSlashPath } from "@/lib/files/paths";
import {
	inspectLocalProjectIdentity,
	type LocalProjectIdentity,
} from "@/lib/spaces/projectAdd";
import { useStore } from "@/store";
import type { Agent, DetectedWorktree, Project } from "@/types";

interface LocalProjectState {
	projects: readonly Project[];
	agents: readonly Agent[];
	pinnedProjects: readonly string[];
	detected: Readonly<Record<string, DetectedWorktree[]>>;
}

export interface LocalProjectReconciliation extends LocalProjectState {
	changed: boolean;
}

/** Merge persisted checkout-shaped Projects by Git's canonical primary
 * worktree and refresh their origin-backed display name. Runtime Hmux
 * workspace identity and per-Agent worktree paths are intentionally left
 * untouched. */
export function reconcileLocalProjectState(
	state: LocalProjectState,
	identityByProjectId: ReadonlyMap<string, LocalProjectIdentity>,
): LocalProjectReconciliation {
	const groups = new Map<
		string,
		{ project: Project; identity: LocalProjectIdentity }[]
	>();
	for (const project of state.projects) {
		const identity = identityByProjectId.get(project.id);
		if (project.kind !== "local" || !project.isRepo || !identity) continue;
		const key = normalizeSlashPath(identity.path);
		groups.set(key, [...(groups.get(key) ?? []), { project, identity }]);
	}

	const replacementId = new Map<string, string>();
	const canonicalIdentity = new Map<string, LocalProjectIdentity>();
	for (const [path, entries] of groups) {
		const keeper =
			entries.find(
				(entry) => normalizeSlashPath(entry.project.path) === path,
			) ?? entries[0];
		canonicalIdentity.set(keeper.project.id, {
			path,
			name: keeper.identity.name,
		});
		for (const { project } of entries) {
			replacementId.set(project.id, keeper.project.id);
		}
	}

	let changed = false;
	const projects = state.projects.flatMap((project) => {
		const keeperId = replacementId.get(project.id);
		if (!keeperId) return [project];
		if (keeperId !== project.id) {
			changed = true;
			return [];
		}
		const identity = canonicalIdentity.get(project.id);
		const path = identity?.path ?? project.path;
		const name = identity?.name ?? project.name;
		if (project.path === path && project.name === name) return [project];
		changed = true;
		return [{ ...project, path, name }];
	});

	const agents = state.agents.map((agent) => {
		const projectId = replacementId.get(agent.projectId) ?? agent.projectId;
		if (projectId === agent.projectId) return agent;
		changed = true;
		return { ...agent, projectId };
	});

	const pinnedProjects: string[] = [];
	for (const projectId of state.pinnedProjects) {
		const nextId = replacementId.get(projectId) ?? projectId;
		if (nextId !== projectId || pinnedProjects.includes(nextId)) changed = true;
		if (!pinnedProjects.includes(nextId)) pinnedProjects.push(nextId);
	}

	const detected: Record<string, DetectedWorktree[]> = {};
	for (const [projectId, worktrees] of Object.entries(state.detected)) {
		const nextId = replacementId.get(projectId) ?? projectId;
		if (nextId !== projectId) changed = true;
		if (!(nextId in detected) || nextId === projectId) {
			detected[nextId] = worktrees;
		}
	}

	return { projects, agents, pinnedProjects, detected, changed };
}

/** One startup reconciliation for pre-canonical persisted Projects. */
export async function reconcilePersistedLocalProjects(): Promise<void> {
	const snapshot = useStore.getState();
	const candidates = snapshot.projects.filter(
		(project) => project.kind === "local" && project.isRepo,
	);
	const resolved = await Promise.all(
		candidates.map(async (project) => [
			project.id,
			await inspectLocalProjectIdentity(project.path),
		] as const),
	);
	const identities = new Map(resolved);
	useStore.setState((current) => {
		const applicable = new Map(
			current.projects.flatMap((project) => {
				const source = snapshot.projects.find(
					(candidate) => candidate.id === project.id,
				);
				const identity = identities.get(project.id);
				return source?.path === project.path &&
					source.name === project.name &&
					identity
					? [[project.id, identity] as const]
					: [];
			}),
		);
		const next = reconcileLocalProjectState(current, applicable);
		return next.changed
			? {
					projects: [...next.projects],
					agents: [...next.agents],
					pinnedProjects: [...next.pinnedProjects],
					detected: { ...next.detected },
				}
			: {};
	});
}
