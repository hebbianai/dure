import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { localRepositoryStatus, type RepositoryStatus } from "@/lib/ipc/git";
import { useStore } from "@/store";
import type { Project } from "@/types";

export type ProjectRepositoryState = RepositoryStatus | { status: "checking" };

/** Refresh local registration metadata when a launch surface opens or changes
 * location. Remote paths retain their host-owned registration; never probe them
 * on this machine. No polling, trust changes, sessions, or worktree creation. */
export function useProjectRepository(project: Project | null, enabled = true) {
	const projectRef = useRef(project);
	projectRef.current = project;
	const [request, setRequest] = useState(0);
	const check = useMemo(
		() => ({
			id: project?.id,
			path: project?.path,
			kind: project?.kind,
			enabled,
			request,
		}),
		[project?.id, project?.path, project?.kind, enabled, request],
	);
	const [observation, setObservation] = useState<{
		check: typeof check;
		value: RepositoryStatus;
	} | null>(null);
	const recheck = useCallback(() => setRequest((value) => value + 1), []);
	useEffect(() => {
		const project = projectRef.current;
		if (!check.enabled || check.kind !== "local" || !project) return;
		let disposed = false;
		void (async () => {
			try {
				const value = await localRepositoryStatus(project.path);
				if (disposed) return;
				if (
					value.status !== "unknown" &&
					project.isRepo !== (value.status === "repository")
				) {
					await useStore
						.getState()
						.observeProjectRepository(project, value.status === "repository");
				}
				if (!disposed) setObservation({ check, value });
			} catch (error) {
				if (!disposed)
					setObservation({
						check,
						value: { status: "unknown", detail: String(error) },
					});
			}
		})();
		return () => {
			disposed = true;
		};
	}, [check]);

	const state: ProjectRepositoryState | null =
		!project || !enabled || project.kind !== "local"
			? null
			: observation?.check === check
				? observation.value
				: { status: "checking" };
	return { state, recheck };
}
