export interface RepositorySpaceRow {
	readonly projectId?: string;
	readonly projectName: string;
	readonly hostId?: string;
}
/** 저장소 원격 판정에 필요한 프로젝트 기록의 부분집합 */
export interface RepositoryHostProject {
	readonly id: string;
	readonly sshHostId?: string;
}

/**
 * Repository remoteness comes from the project record, not from whichever panes
 * happen to be open. A row carries `hostId` only for ssh panes and remote-session
 * agents, so a plain local terminal opened on a remote repository would otherwise
 * make the group look local until a remote pane joins it.
 */
export function repositoryRemoteHostId<Row extends RepositorySpaceRow>(
	group: SpaceRepositoryGroup<Row>,
	projects: readonly RepositoryHostProject[],
): string | undefined {
	const projectId = group.projectId ?? group.spaces.find((space) => space.projectId)?.projectId;
	const project = projectId
		? projects.find((candidate) => candidate.id === projectId)
		: undefined;
	// 기록이 있으면 그 기록이 끝이다 — 로컬로 등록된 저장소는 어떤 pane이
	// 붙어 있든 로컬이다. pane 폴백은 등록된 기록이 아예 없는 그룹 전용이고,
	// 빈 문자열 sshHostId는 식별자가 아니므로 없는 것으로 본다.
	if (project) return project.sshHostId || undefined;
	return group.spaces.find((space) => space.hostId)?.hostId;
}

export interface SpaceRepositoryGroup<Row extends RepositorySpaceRow> {
	readonly key: string;
	readonly label: string;
	/** The registered project the group stands for, when it stands for one —
	 *  a location group (unregistered folder) has none. Lets a group with no
	 *  rows still name where a new session starts. */
	readonly projectId?: string;
	readonly spaces: readonly Row[];
}

/** Repository identity of one row: the registered project when there is one,
 *  otherwise the (host, location label) pair. The one key every grouping and
 *  per-repository rollup in the Spaces pane agrees on. */
export function spaceRepositoryGroupKey(row: RepositorySpaceRow): string {
	return row.projectId
		? JSON.stringify(["project", row.projectId])
		: JSON.stringify(["location", row.hostId ?? null, row.projectName]);
}

/**
 * Repository group order follows the first visible pane. Pane order inside a
 * group stays identical to Dockview order, so runtime state changes never move
 * a row under the pointer.
 */
export function groupSpacesByRepository<Row extends RepositorySpaceRow>(
	spaces: readonly Row[],
): readonly SpaceRepositoryGroup<Row>[] {
	const groups = new Map<
		string,
		{ key: string; label: string; projectId?: string; spaces: Row[] }
	>();

	for (const space of spaces) {
		const key = spaceRepositoryGroupKey(space);
		const group = groups.get(key) ?? {
			key,
			label: space.projectName,
			projectId: space.projectId,
			spaces: [],
		};
		group.spaces.push(space);
		groups.set(key, group);
	}

	return [...groups.values()];
}

/** One desktop's rows inside a repository-first group, in Dockview order. */
interface RepositoryDesktopBucket<Row, Desktop> {
	readonly desktop: Desktop;
	readonly spaces: readonly Row[];
}

/** A repository-first group: the repository's rows across every desktop,
 *  plus the same rows bucketed per desktop for the nested space headers. */
export interface RepositoryFirstGroup<Row extends RepositorySpaceRow, Desktop>
	extends SpaceRepositoryGroup<Row> {
	readonly desktops: readonly RepositoryDesktopBucket<Row, Desktop>[];
}

/**
 * The project → space → pane hierarchy. Desktops are walked in the given
 * order, so repository order follows the first visible pane across desktops,
 * desktop order inside a repository follows the desktop list, and pane order
 * inside a bucket stays Dockview order — the same stability rule as
 * `groupSpacesByRepository`: runtime state never moves a row under the pointer.
 * `spaces` is the flat visual order (desktop by desktop), which selection and
 * per-repository rollups read. Desktops with no visible rows produce nothing.
 */
export function groupSpacesByRepositoryAcrossDesktops<
	Row extends RepositorySpaceRow & { readonly desktopId: string },
	Desktop extends { readonly id: string },
>(
	desktops: readonly Desktop[],
	rowsByDesktop: ReadonlyMap<string, readonly Row[]>,
): readonly RepositoryFirstGroup<Row, Desktop>[] {
	const groups = new Map<
		string,
		{
			key: string;
			label: string;
			projectId?: string;
			spaces: Row[];
			desktops: RepositoryDesktopBucket<Row, Desktop>[];
		}
	>();
	for (const desktop of desktops) {
		const rows = rowsByDesktop.get(desktop.id);
		if (!rows || rows.length === 0) continue;
		for (const bucket of groupSpacesByRepository(rows)) {
			const group = groups.get(bucket.key) ?? {
				key: bucket.key,
				label: bucket.label,
				projectId: bucket.projectId,
				spaces: [],
				desktops: [],
			};
			group.spaces.push(...bucket.spaces);
			group.desktops.push({ desktop, spaces: bucket.spaces });
			groups.set(bucket.key, group);
		}
	}
	return [...groups.values()];
}

/** The group key a registered project's rows carry — the same identity
 *  `spaceRepositoryGroupKey` derives from a row with that `projectId`. */
export function repositoryGroupKeyForProject(projectId: string): string {
	return JSON.stringify(["project", projectId]);
}

/**
 * Every registered repository stays listed, rows or not: a repository with
 * nothing open is still the place to start something (owner request
 * 2026-09-03). Pinned repositories lead in pin order — the one effect a pin
 * has in the Spaces list — then the repositories whose rows are visible in
 * their first-pane order, then the empty ones in registry order. The caller
 * skips this under a search, which hides what it leaves empty.
 */
export function withRegisteredRepositories<
	Row extends RepositorySpaceRow,
	Desktop,
>(
	groups: readonly RepositoryFirstGroup<Row, Desktop>[],
	projects: readonly { readonly id: string; readonly name: string }[],
	pinnedProjectIds: readonly string[],
): readonly RepositoryFirstGroup<Row, Desktop>[] {
	const listed = new Set(groups.map((group) => group.key));
	const empties: RepositoryFirstGroup<Row, Desktop>[] = projects
		.filter((project) => !listed.has(repositoryGroupKeyForProject(project.id)))
		.map((project) => ({
			key: repositoryGroupKeyForProject(project.id),
			label: project.name,
			// The quick-add rail starts here from the project record — there is
			// no open pane to borrow a folder from.
			projectId: project.id,
			spaces: [],
			desktops: [],
		}));
	const all = [...groups, ...empties];
	const byKey = new Map(all.map((group) => [group.key, group]));
	const pinnedKeys = pinnedProjectIds.map(repositoryGroupKeyForProject);
	const pinned = new Set(pinnedKeys);
	return [
		...pinnedKeys.flatMap((key) => {
			const group = byKey.get(key);
			return group ? [group] : [];
		}),
		...all.filter((group) => !pinned.has(group.key)),
	];
}
