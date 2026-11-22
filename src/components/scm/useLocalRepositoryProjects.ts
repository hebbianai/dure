import { useMemo } from "react";
import { localRepositoryProjects } from "@/lib/scm/worktrees/worktreeReclaim";
import { useStore } from "@/store";
import type { Project } from "@/types";

/** Registered local Git projects, the ones whose finished worktrees Dure can
 *  scan and remove. */
export function useLocalRepositoryProjects(): Project[] {
	const projects = useStore((state) => state.projects);
	return useMemo(() => localRepositoryProjects(projects), [projects]);
}
