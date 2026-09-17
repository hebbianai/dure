// Spaces list hierarchy derivation. Repositories, desktops, or a runtime facet
// can lead; each view reads the same row projection and nests the existing
// repository/desktop hierarchy beneath it. The pane only renders the returned
// shape; grouping rules live in lib/spaces.
import { useMemo } from "react";
import { useLocalDayTick } from "@/components/spaces/useNowTick";
import type { SpaceRow } from "@/components/spaces/useSpaces";
import {
	groupSpacesByRepository,
	groupSpacesByRepositoryAcrossDesktops,
	type RepositoryFirstGroup,
	repositoryGroupKeyForProject,
	type SpaceRepositoryGroup,
	withRegisteredRepositories,
} from "@/lib/spaces/spaceRepositoryGroups";
import { useSpacesCollapsedGroups } from "@/lib/spaces/spacesCollapsedGroupsStore";
import {
	type SpacesFacetHierarchyGroup as FacetHierarchyGroup,
	projectSpacesFacetHierarchy,
} from "@/lib/spaces/spacesFacetHierarchy";
import {
	bucketVisibleSpaces,
	orderDesktopsWithPopouts,
	partitionSpacesByPins,
	selectableRowKeys,
} from "@/lib/spaces/spacesHierarchy";
import {
	matchesSpacesQuery,
	openSpaceRowSearchParts,
} from "@/lib/spaces/spacesSearch";
import type {
	SpacesFacetGrouping,
	SpacesFilters,
	SpacesGrouping,
	SpacesOrdering,
} from "@/lib/spaces/spacesViewOptions";
import {
	orderSpacesRows,
	projectSpacesRows,
} from "@/lib/spaces/spacesViewProjection";
import {
	type HiddenFilePaneRecord,
	useHiddenFilePanes,
} from "@/lib/workspace/pane/hiddenFilePanesStore";
import type { Desktop } from "@/types";
import type { PinnedPanes } from "@/lib/workspace/pane/panePin";

interface SpacesDesktopGroup {
	readonly desktop: Desktop;
	readonly repositoryGroups: readonly SpaceRepositoryGroup<SpaceRow>[];
	/** Flat rows in visual order — selection ranges read this. */
	readonly spaces: readonly SpaceRow[];
	readonly attentionCount: number;
}

interface HierarchyCommon {
	/** Individually pinned panes lead the band, outside all group folds. */
	readonly pinnedRows: readonly SpaceRow[];
	/** Pinned repositories, in pin order, for the band under the search row.
	 *  They are always listed — narrowing only filters their rows — and they
	 *  are left out of the body so nothing appears twice (owner decision
	 *  2026-09-03: pins gather at the top and stay visible). */
	readonly pinnedGroups: readonly RepositoryFirstGroup<SpaceRow, Desktop>[];
	/** Keys of the rows a person can currently see, in visual order. Folded
	 *  repositories contribute only the focused pane's row (the one they keep
	 *  showing), so a shift-range, a bulk action, or a multi-row drag never
	 *  reaches a row nobody can see. */
	readonly selectionOrder: readonly string[];
	/** Every useful fold in the current search and grouping projection. */
	readonly collapsibleGroupKeys: readonly string[];
	/** Useful folds currently on screen. A folded outer group hides its nested
	 * folds, so Collapse all must not act on those invisible descendants. */
	readonly visibleCollapsibleGroupKeys: readonly string[];
	/** Repository attention for the pinned band, independent of grouping. */
	readonly attentionByRepository: ReadonlyMap<string, number>;
	/** Open rows surviving search and filters, before grouping. */
	readonly visibleRowCount: number;
}

export type SpacesFacetHierarchyGroup = FacetHierarchyGroup<SpaceRow, Desktop>;

export type SpacesHierarchy =
	| (HierarchyCommon & {
			readonly groupBy: "space";
			readonly groups: readonly SpacesDesktopGroup[];
			/** Registered folders with no open pane have no Space placement yet. */
			readonly trailingRepositories: readonly RepositoryFirstGroup<SpaceRow, Desktop>[];
	  })
	| (HierarchyCommon & {
			readonly groupBy: "repository";
			readonly groups: readonly RepositoryFirstGroup<SpaceRow, Desktop>[];
			/** Spaces holding hidden file panes. They belong to a space, not a
			 *  repository, so they trail the repositories as their own sections;
			 *  a narrowed view hides them like any space it leaves without rows. */
			readonly hiddenFileDesktops: readonly Desktop[];
	  })
	| (HierarchyCommon & {
			readonly groupBy: SpacesFacetGrouping;
			readonly groups: readonly SpacesFacetHierarchyGroup[];
			/** Registered repositories with no rows have no runtime facet. */
			readonly trailingRepositories: readonly RepositoryFirstGroup<
				SpaceRow,
				Desktop
			>[];
			/** Hidden file panes likewise have no open-row facet fact. */
			readonly hiddenFileDesktops: readonly Desktop[];
	  });

const NO_HIDDEN_FILE_PANES: Record<string, HiddenFilePaneRecord> = {};

export function useSpacesGroups({
	spaces,
	desktops,
	projects,
	pinnedProjectIds,
	pinnedPanes,
	groupBy,
	orderBy,
	filters,
	normalizedQuery,
	focusedRowKey,
}: {
	spaces: readonly SpaceRow[];
	desktops: readonly Desktop[];
	/** Registered repositories: listed even with nothing open (repository-first). */
	projects: readonly { readonly id: string; readonly name: string }[];
	/** Pinned repositories lead the repository-first list, in pin order. */
	pinnedProjectIds: readonly string[];
	pinnedPanes: PinnedPanes;
	groupBy: SpacesGrouping;
	orderBy: SpacesOrdering;
	filters: SpacesFilters;
	normalizedQuery: string;
	/** Key of the focused pane's row when it is in the active space — the row
	 *  a folded repository still shows. */
	focusedRowKey: string | null;
}): SpacesHierarchy {
	const orderedDesktops = useMemo(
		() => orderDesktopsWithPopouts(desktops),
		[desktops],
	);
	const pinnedKeys = useMemo(
		() => new Set(pinnedProjectIds.map(repositoryGroupKeyForProject)),
		[pinnedProjectIds],
	);
	const narrowed =
		normalizedQuery.length > 0 ||
		Object.values(filters).some((values) => values.length > 0);
	const orderedSpaces = useMemo(
		() => orderSpacesRows(spaces, orderBy),
		[spaces, orderBy],
	);
	const projectedSpaces = useMemo(
		() =>
			projectSpacesRows(spaces, {
				filters,
				orderBy,
				matchesSearch: normalizedQuery
					? (space) =>
							matchesSpacesQuery(
								normalizedQuery,
								openSpaceRowSearchParts(space),
							)
					: undefined,
			}),
		[spaces, filters, orderBy, normalizedQuery],
	);
	const allRowsByPin = useMemo(
		() => partitionSpacesByPins(orderedSpaces, pinnedPanes, pinnedKeys),
		[orderedSpaces, pinnedPanes, pinnedKeys],
	);
	const visibleRowsByPin = useMemo(
		() => partitionSpacesByPins(projectedSpaces, pinnedPanes, pinnedKeys),
		[projectedSpaces, pinnedPanes, pinnedKeys],
	);
	const buckets = useMemo(
		() => {
			const visible = bucketVisibleSpaces(visibleRowsByPin.body, () => true);
			const pinned = bucketVisibleSpaces(
				visibleRowsByPin.repositories, () => true,
			);
			const attention = bucketVisibleSpaces(
				[...allRowsByPin.repositories, ...allRowsByPin.body], () => false,
			);
			const bodyAttention = bucketVisibleSpaces(allRowsByPin.body, () => false);
			return {
				visibleByDesktop: visible.visibleByDesktop,
				pinnedByDesktop: pinned.visibleByDesktop,
				attentionByDesktop: bodyAttention.attentionByDesktop,
				attentionByRepository: attention.attentionByRepository,
			};
		},
		[visibleRowsByPin, allRowsByPin],
	);
	const collapsed = useSpacesCollapsedGroups((state) => state.collapsed);
	const updatedDay = useLocalDayTick(groupBy === "updated");
	const facetNow = groupBy === "updated" ? updatedDay : 0;
	// Repository- and facet-first views list hidden-file desktops separately.
	// Space-first leaves them to HiddenFilePaneRows, so a hide or restore there
	// must not re-render this hierarchy.
	const hiddenFilePanes = useHiddenFilePanes((state) =>
		groupBy === "space" ? NO_HIDDEN_FILE_PANES : state.hidden,
	);
	return useMemo(() => {
		const pinnedProjects = pinnedProjectIds.flatMap((id) => {
			const project = projects.find((candidate) => candidate.id === id);
			return project ? [project] : [];
		});
		const pinnedRows = visibleRowsByPin.panes;
		const pinnedRowKeys = pinnedRows.map((row) => row.key);
		const bodyRowsByDesktop = buckets.visibleByDesktop;
		// Pinned repositories: their visible rows, in pin order, and every
		// pinned repository even when nothing matched.
		const pinnedGroups = withRegisteredRepositories(
			groupSpacesByRepositoryAcrossDesktops(
				orderedDesktops,
				buckets.pinnedByDesktop,
			).filter((group) => pinnedKeys.has(group.key)),
			pinnedProjects,
			pinnedProjectIds,
		);
		const unpinnedProjects = projects.filter(
			(project) => !pinnedKeys.has(repositoryGroupKeyForProject(project.id)),
		);
		const pinnedGroupKeys = pinnedGroups.map((group) => group.key);
		if (groupBy === "repository") {
			const visibleGroups = groupSpacesByRepositoryAcrossDesktops(
				orderedDesktops,
				bodyRowsByDesktop,
			);
			// A narrowed view shows only matching repositories; otherwise every
			// registered repository follows the ones with rows.
			const groups = narrowed
				? visibleGroups
				: withRegisteredRepositories(visibleGroups, unpinnedProjects, []);
			const withHiddenFiles = new Set(
				Object.values(hiddenFilePanes).map((record) => record.desktopId),
			);
			const collapsibleGroupKeys = [
				...pinnedGroupKeys,
				...groups.map((group) => group.key),
			];
			return {
				groupBy,
				groups,
				pinnedGroups,
				pinnedRows,
				visibleRowCount: projectedSpaces.length,
				attentionByRepository: buckets.attentionByRepository,
				hiddenFileDesktops: narrowed
					? []
					: orderedDesktops.filter((desktop) =>
							withHiddenFiles.has(desktop.id),
						),
				selectionOrder: [
					...pinnedRowKeys,
					...selectableRowKeys([...pinnedGroups, ...groups], collapsed, focusedRowKey),
				],
				collapsibleGroupKeys,
				visibleCollapsibleGroupKeys: collapsibleGroupKeys,
			};
		}
		if (groupBy === "space") {
			const representedProjects = new Set(
				[...allRowsByPin.body, ...allRowsByPin.panes].map((row) => row.projectId),
			);
			const trailingRepositories = narrowed
				? []
				: withRegisteredRepositories<SpaceRow, Desktop>(
						[],
						unpinnedProjects.filter((project) => !representedProjects.has(project.id)),
						[],
					);
			const groups = orderedDesktops
				.map((desktop) => {
					const repositoryGroups = groupSpacesByRepository(
						bodyRowsByDesktop.get(desktop.id) ?? [],
					);
					return {
						desktop,
						repositoryGroups,
						spaces: repositoryGroups.flatMap((group) => group.spaces),
						attentionCount: buckets.attentionByDesktop.get(desktop.id) ?? 0,
					};
				})
				// Empty desktops stay listed while nothing narrows the list — they
				// are drop targets and add-menu anchors; search or filters hide them.
				.filter((group) => !narrowed || group.spaces.length > 0);
			const repositoryGroups = groups.flatMap(
				(group) => group.repositoryGroups,
			);
			const collapsibleGroupKeys = [
				...new Set([
					...pinnedGroupKeys,
					...repositoryGroups.map((repository) => repository.key),
					...trailingRepositories.map((repository) => repository.key),
				]),
			];
			return {
				groupBy,
				groups,
				trailingRepositories,
				pinnedGroups,
				pinnedRows,
				visibleRowCount: projectedSpaces.length,
				attentionByRepository: buckets.attentionByRepository,
				selectionOrder: [
					...pinnedRowKeys,
					...selectableRowKeys([...pinnedGroups, ...repositoryGroups], collapsed, focusedRowKey),
				],
				collapsibleGroupKeys,
				visibleCollapsibleGroupKeys: collapsibleGroupKeys,
			};
		}

		// Facet groupings are explicit dynamic views. Capture the calendar once,
		// then use the same projected buckets for headings, rows, and rollups.
		const nowMs = facetNow;
		const bodyRows = allRowsByPin.body;
		const visibleBodyRows = orderedDesktops.flatMap(
			(desktop) => bodyRowsByDesktop.get(desktop.id) ?? [],
		);
		const visibleBodyKeys = new Set(visibleBodyRows.map((row) => row.key));
		const hiddenDesktopIds = new Set(
			Object.values(hiddenFilePanes).map((record) => record.desktopId),
		);
		const hiddenFileDesktops = narrowed
			? []
			: orderedDesktops.filter((desktop) => hiddenDesktopIds.has(desktop.id));
		const facet = projectSpacesFacetHierarchy({
			rows: bodyRows,
			visibleRowKeys: visibleBodyKeys,
			desktops: orderedDesktops,
			projects: unpinnedProjects,
			axis: groupBy,
			nowMs,
			includeEmptyRepositories: !narrowed,
			collapsed,
			focusedRowKey,
		});
		return {
			groupBy,
			groups: facet.groups,
			pinnedGroups,
			pinnedRows,
			trailingRepositories: facet.trailingRepositories,
			hiddenFileDesktops,
			visibleRowCount: projectedSpaces.length,
			attentionByRepository: buckets.attentionByRepository,
			selectionOrder: [
				...pinnedRowKeys,
				...selectableRowKeys(pinnedGroups, collapsed, focusedRowKey),
				...facet.selectionOrder,
			],
			collapsibleGroupKeys: [
				...new Set([...pinnedGroupKeys, ...facet.collapsibleGroupKeys]),
			],
			visibleCollapsibleGroupKeys: [
				...new Set([
					...pinnedGroupKeys,
					...facet.visibleCollapsibleGroupKeys,
				]),
			],
		};
	}, [
		groupBy,
		projects,
		pinnedProjectIds,
		pinnedKeys,
		orderedDesktops,
		allRowsByPin,
		visibleRowsByPin,
		buckets,
		narrowed,
		projectedSpaces.length,
		collapsed,
		hiddenFilePanes,
		focusedRowKey,
		facetNow,
	]);
}
