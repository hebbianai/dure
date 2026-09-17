import {
	groupSpacesByRepositoryAcrossDesktops,
	type RepositoryFirstGroup,
	type RepositorySpaceRow,
	repositoryGroupKeyForProject,
	spaceRepositoryGroupKey,
	withRegisteredRepositories,
} from "@/lib/spaces/spaceRepositoryGroups";
import { selectableRowKeys } from "@/lib/spaces/spacesHierarchy";
import type { SpacesFacetGrouping } from "@/lib/spaces/spacesViewOptions";
import {
	groupSpacesRows,
	type SpacesFacetBucket,
	type SpacesFacetSource,
} from "@/lib/spaces/spacesViewProjection";

type FacetRow = RepositorySpaceRow &
	SpacesFacetSource & {
		readonly key: string;
		readonly desktopId: string;
	};

interface FacetDesktop {
	readonly id: string;
}

export interface SpacesFacetHierarchyGroup<
	Row extends FacetRow,
	Desktop extends FacetDesktop,
> {
	readonly key: string;
	readonly bucket: SpacesFacetBucket;
	readonly spaces: readonly Row[];
	readonly repositoryGroups: readonly RepositoryFirstGroup<Row, Desktop>[];
	/** The repository subtree kept beside a focused row when the facet folds. */
	readonly focusedRepository?: RepositoryFirstGroup<Row, Desktop>;
	readonly attentionCount: number;
}

export interface SpacesFacetHierarchyProjection<
	Row extends FacetRow,
	Desktop extends FacetDesktop,
> {
	readonly groups: readonly SpacesFacetHierarchyGroup<Row, Desktop>[];
	readonly trailingRepositories: readonly RepositoryFirstGroup<Row, Desktop>[];
	readonly selectionOrder: readonly string[];
	readonly collapsibleGroupKeys: readonly string[];
	readonly visibleCollapsibleGroupKeys: readonly string[];
}

function focusedRepositoryProjection<
	Row extends FacetRow,
	Desktop extends FacetDesktop,
>(
	repositories: readonly RepositoryFirstGroup<Row, Desktop>[],
	focusedRowKey: string | null,
): RepositoryFirstGroup<Row, Desktop> | undefined {
	if (!focusedRowKey) return undefined;
	for (const repository of repositories) {
		const focused = repository.spaces.find((row) => row.key === focusedRowKey);
		if (!focused) continue;
		return {
			...repository,
			spaces: [focused],
			desktops: repository.desktops.flatMap(({ desktop, spaces }) =>
				spaces.some((row) => row.key === focusedRowKey)
					? [{ desktop, spaces: [focused] }]
					: [],
			),
		};
	}
	return undefined;
}

/** Project one runtime facet above the canonical repository/desktop tree.
 * Search visibility changes rows, while attention still reads every source
 * row in a bucket. Fold and focus policy is derived in the same pass. */
export function projectSpacesFacetHierarchy<
	Row extends FacetRow,
	Desktop extends FacetDesktop,
>({
	rows,
	visibleRowKeys,
	desktops,
	projects,
	axis,
	nowMs,
	includeEmptyRepositories,
	collapsed,
	focusedRowKey,
}: {
	readonly rows: readonly Row[];
	readonly visibleRowKeys: ReadonlySet<string>;
	readonly desktops: readonly Desktop[];
	readonly projects: readonly { readonly id: string; readonly name: string }[];
	readonly axis: SpacesFacetGrouping;
	readonly nowMs: number;
	readonly includeEmptyRepositories: boolean;
	readonly collapsed: Readonly<Record<string, true>>;
	readonly focusedRowKey: string | null;
}): SpacesFacetHierarchyProjection<Row, Desktop> {
	const groups = groupSpacesRows(rows, axis, nowMs, (row) =>
		visibleRowKeys.has(row.key),
	).map((group): SpacesFacetHierarchyGroup<Row, Desktop> => {
		const rowsByDesktop = new Map(
			desktops.map((desktop) => [
				desktop.id,
				group.spaces.filter((row) => row.desktopId === desktop.id),
			]),
		);
		const repositoryGroups = groupSpacesByRepositoryAcrossDesktops(
			desktops,
			rowsByDesktop,
		);
		return {
			...group,
			repositoryGroups,
			focusedRepository: focusedRepositoryProjection(
				repositoryGroups,
				focusedRowKey,
			),
		};
	});
	const repositoryGroups = groups.flatMap((group) => group.repositoryGroups);
	const repositoryKeys = [
		...new Set(repositoryGroups.map((repository) => repository.key)),
	];
	const facetKeys = groups.map((group) => group.key);
	const visibleRepositoryKeys = [
		...new Set(
			groups
				.filter((group) => !collapsed[group.key])
				.flatMap((group) => group.repositoryGroups)
				.map((repository) => repository.key),
		),
	];
	const representedRepositories = new Set(rows.map(spaceRepositoryGroupKey));
	const emptyProjects = projects.filter(
		(project) =>
			!representedRepositories.has(repositoryGroupKeyForProject(project.id)),
	);
	const trailingRepositories = includeEmptyRepositories
		? withRegisteredRepositories<Row, Desktop>([], emptyProjects, [])
		: [];
	const trailingRepositoryKeys = trailingRepositories.map(
		(repository) => repository.key,
	);
	return {
		groups,
		trailingRepositories,
		selectionOrder: groups.flatMap((group) =>
			collapsed[group.key]
				? (group.focusedRepository?.spaces.map((row) => row.key) ?? [])
				: selectableRowKeys(group.repositoryGroups, collapsed, focusedRowKey),
		),
		collapsibleGroupKeys: [
			...new Set([...facetKeys, ...repositoryKeys, ...trailingRepositoryKeys]),
		],
		visibleCollapsibleGroupKeys: [
			...new Set([
				...facetKeys,
				...visibleRepositoryKeys,
				...trailingRepositoryKeys,
			]),
		],
	};
}
