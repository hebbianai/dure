// Where a repository head-row's quick-add lands: the working folder a new
// terminal or agent should start in, resolved once from the group and the
// project registry.
//
// The registered project wins over the panes. A repository can be registered
// remote while only a local terminal happens to be open on it (and vice
// versa), so reading the location off whichever pane is open would start the
// next session on the wrong host — the same failure the SSH badge already
// fixed by reading the project record.

import type { SpaceRepositoryGroup } from "@/lib/spaces/spaceRepositoryGroups";
import type { Project, Provider } from "@/types";

/** How many agent buttons the head row carries inline before the '+' menu.
 *  Three is what fits beside a readable repository name at a comfortable
 *  sidebar width; the rest of the providers stay one hover away in the menu. */
export const INLINE_QUICK_ADD_PROVIDER_LIMIT = 3;

export interface QuickAddSpaceRow {
	readonly projectId?: string;
	readonly projectName: string;
	readonly hostId?: string;
	readonly cwd?: string;
}

export interface RepositoryQuickAddTarget {
	/** Repository name — the head row's own label. */
	readonly label: string;
	/** Working folder for the new terminal or agent. */
	readonly path: string;
	/** Registered project, when the repository has one. */
	readonly projectId?: string;
	/** SSH host id for a remote repository; absent means local. */
	readonly hostId?: string;
}

/**
 * The quick-add target for a repository group, or null when no pane in it
 * knows a folder (a group built entirely from location-less rows — nothing
 * to start).
 */
export function repositoryQuickAddTarget<Row extends QuickAddSpaceRow>(
	group: SpaceRepositoryGroup<Row>,
	projects: readonly Project[],
): RepositoryQuickAddTarget | null {
	const projectId =
		group.projectId ?? group.spaces.find((space) => space.projectId)?.projectId;
	const project = projectId
		? projects.find((candidate) => candidate.id === projectId)
		: undefined;
	if (project) {
		return {
			label: group.label,
			path: project.path,
			projectId: project.id,
			...(project.kind === "ssh" && project.sshHostId
				? { hostId: project.sshHostId }
				: {}),
		};
	}
	// Unregistered location: the panes are all there is. Quick-add registers
	// the folder on demand, the same way the add-agent dialog does for a
	// hand-picked one.
	const row = group.spaces.find((space) => space.cwd);
	if (!row?.cwd) return null;
	return {
		label: group.label,
		path: row.cwd,
		...(row.hostId ? { hostId: row.hostId } : {}),
	};
}

/**
 * Registry name for a quick-added agent — `claude-3` style, the same shape
 * the add-agent dialog auto-names with.
 *
 * The count is a starting guess, not the answer: removals leave gaps, so the
 * name still has to step past collisions so the sidebar remains unambiguous.
 * Durable Run identity belongs to the user action, not this display name.
 */
export function quickAddAgentName(
	provider: Provider,
	projectAgentNames: readonly string[],
): string {
	let index = projectAgentNames.length + 1;
	while (projectAgentNames.includes(`${provider}-${index}`)) index += 1;
	return `${provider}-${index}`;
}
