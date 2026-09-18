// Projects store slice — registered projects (local and SSH), the pinned
// ordering, and the on-disk worktree scan results. Extracted from store.ts as
// a composition slice (precedent: sessionRuntimeStoreSlice); implementations
// moved verbatim so update and error semantics are unchanged. Destructive
// removal belongs to resourceLifecycle's durable projection transaction.
import { nanoid } from "nanoid";
import { t } from "@/lib/i18n";
import {
	hostToOpts,
	parseWorktreeScan,
	remoteProjectDirectory,
	scanWorktrees,
	scanWorktreesCommand,
	sshExecOnce,
} from "@/lib/ipc";
import { track } from "@/lib/ipc/telemetry";
import { reorder } from "@/lib/persistence/storeCollections";
import { createLocalProject, projectAtPath } from "@/lib/spaces/projectAdd";
import { repositoryDisplayName } from "@/lib/spaces/repositoryDisplayName";
import type { DetectedWorktree, Project, SshHostConfig } from "@/types";

export interface ProjectsStoreSlice {
	projects: Project[];
	pinnedProjects: string[];
	/** projectId -> 디스크에서 발견한 워크트리 (이 앱이 안 만든 것 포함) */
	detected: Record<string, DetectedWorktree[]>;

	/** Resolve only after the shared registration writer commits the project. */
	addLocalProject: (path: string) => Promise<Project>;
	addRemoteProject: (hostId: string, path: string) => Promise<Project>;
	/** 같은 (path, host)의 프로젝트가 있으면 재사용, 없으면 등록해 돌려준다.
	 *  디렉토리 기반 에이전트 생성이 중복 프로젝트를 만들지 않게 한다. */
	ensureProjectForPath: (path: string, hostId?: string) => Promise<Project>;
	toggleProjectPin: (id: string) => void;
	moveProject: (dragId: string, targetId: string) => void;
	scanProject: (projectId: string) => Promise<void>;
}

/** addRemoteProject / scanProject read the host store's SSH hosts. */
type ProjectsHostState = ProjectsStoreSlice & {
	sshHosts: SshHostConfig[];
};

type SliceSet = (
	updater: (
		state: ProjectsHostState,
	) => ProjectsHostState | Partial<ProjectsHostState>,
) => void;

export function createProjectsStoreSlice(
	set: SliceSet,
	get: () => ProjectsHostState,
	registerProject: (candidate: Project) => Promise<Project>,
): ProjectsStoreSlice {
	// A registration the store already knew is a lookup, not an addition.
	const registerNew = async (
		candidate: Project,
		kind: "local" | "ssh",
	): Promise<Project> => {
		const known = new Set(get().projects.map((project) => project.id));
		const registered = await registerProject(candidate);
		if (!known.has(registered.id)) track("project_added", { kind });
		return registered;
	};
	return {
		projects: [],
		pinnedProjects: [],
		detected: {},

		addLocalProject: async (path) => {
			return registerNew(await createLocalProject(path), "local");
		},

		addRemoteProject: async (hostId, path) => {
			const host = get().sshHosts.find((h) => h.id === hostId);
			if (!host) throw new Error(t("common.sshHostNotFound"));
			const directory = await remoteProjectDirectory(host, path);
			const p: Project = {
				id: `proj-${nanoid(8)}`,
				name: repositoryDisplayName(
					directory.path,
					directory.origin ?? undefined,
				),
				path: directory.path,
				kind: "ssh",
				sshHostId: hostId,
				isRepo: directory.isRepo,
			};
			return registerNew(p, "ssh");
		},

		ensureProjectForPath: async (path, hostId) => {
			const existing = projectAtPath(get().projects, path, hostId);
			if (existing) return existing;
			return hostId
				? get().addRemoteProject(hostId, path)
				: get().addLocalProject(path);
		},

		toggleProjectPin: (id) =>
			set((s) => ({
				pinnedProjects: s.pinnedProjects.includes(id)
					? s.pinnedProjects.filter((x) => x !== id)
					: [...s.pinnedProjects, id],
			})),
		moveProject: (dragId, targetId) =>
			set((s) => ({ projects: reorder(s.projects, dragId, targetId) })),

		scanProject: async (projectId) => {
			const state = get();
			const project = state.projects.find((p) => p.id === projectId);
			if (!project?.isRepo) return;
			try {
				let wts: DetectedWorktree[];
				if (project.kind === "local") {
					wts = await scanWorktrees(project.path);
				} else {
					const host = state.sshHosts.find((h) => h.id === project.sshHostId);
					if (!host) return;
					const cmd = await scanWorktreesCommand(project.path);
					const r = await sshExecOnce(hostToOpts(host), cmd);
					if (r.code !== 0) return;
					wts = await parseWorktreeScan(r.stdout);
				}
				set((s) => ({ detected: { ...s.detected, [projectId]: wts } }));
			} catch {
				// repo may have moved/been deleted, or the host is unreachable —
				// keep last known result
			}
		},
	};
}
