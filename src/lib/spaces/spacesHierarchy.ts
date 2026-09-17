// The Spaces list can be read two ways — space → repository → pane, or
// repository → space → pane — and both start from the same pass over the
// rows. This module owns that pass and the desktop ordering; the grouping
// itself is `spaceRepositoryGroups`.
import {
	type RepositorySpaceRow,
	spaceRepositoryGroupKey,
} from "@/lib/spaces/spaceRepositoryGroups";
import { ATTENTION_DISPLAY_STATES } from "@/lib/spaces/spacesStateFilter";
import {
	isPanePinned,
	panePinKey,
	type PinnedPanes,
} from "@/lib/workspace/pane/panePin";

export interface HierarchySpaceRow extends RepositorySpaceRow {
	readonly desktopId: string;
	readonly displayState?: string;
}

/** Pane pins take precedence over repository pins; every row has one home.
 * Preserve the caller's ordering and the canonical desktop-scoped pin key. */
export function partitionSpacesByPins<Row extends HierarchySpaceRow & { readonly key: string }>(
	rows: readonly Row[],
	pinnedPanes: PinnedPanes,
	pinnedRepositories: ReadonlySet<string>,
): { panes: Row[]; repositories: Row[]; body: Row[] } {
	const result: { panes: Row[]; repositories: Row[]; body: Row[] } = {
		panes: [], repositories: [], body: [],
	};
	for (const row of rows) {
		const destination = isPanePinned(pinnedPanes, panePinKey(row.desktopId, row.key))
			? result.panes
			: pinnedRepositories.has(spaceRepositoryGroupKey(row))
				? result.repositories
				: result.body;
		destination.push(row);
	}
	return result;
}

export interface VisibleSpaceBuckets<Row> {
	/** Rows that pass the search, per desktop, in Dockview order. */
	readonly visibleByDesktop: ReadonlyMap<string, readonly Row[]>;
	/** Attention rollups ignore the search — a heading speaks for every
	 *  waiting session in its desktop or repository, not for the listed ones. */
	readonly attentionByDesktop: ReadonlyMap<string, number>;
	readonly attentionByRepository: ReadonlyMap<string, number>;
}

/** One pass: bucket the visible rows per desktop and roll attention up per
 *  desktop and per repository. */
export function bucketVisibleSpaces<Row extends HierarchySpaceRow>(
	rows: readonly Row[],
	isVisible: (row: Row) => boolean,
): VisibleSpaceBuckets<Row> {
	const visibleByDesktop = new Map<string, Row[]>();
	const attentionByDesktop = new Map<string, number>();
	const attentionByRepository = new Map<string, number>();
	for (const row of rows) {
		if (
			row.displayState !== undefined &&
			ATTENTION_DISPLAY_STATES.has(row.displayState)
		) {
			attentionByDesktop.set(
				row.desktopId,
				(attentionByDesktop.get(row.desktopId) ?? 0) + 1,
			);
			const repositoryKey = spaceRepositoryGroupKey(row);
			attentionByRepository.set(
				repositoryKey,
				(attentionByRepository.get(repositoryKey) ?? 0) + 1,
			);
		}
		if (!isVisible(row)) continue;
		const bucket = visibleByDesktop.get(row.desktopId);
		if (bucket) bucket.push(row);
		else visibleByDesktop.set(row.desktopId, [row]);
	}
	return { visibleByDesktop, attentionByDesktop, attentionByRepository };
}

/** Popout desktops sit right after their origin (사용자 요청); a popout whose
 *  origin is gone trails the list so its panes keep a surface. The origin is
 *  `originSpaceId` — the field the store writes and rehydrates; the
 *  compatibility view's `originDesktopId` is stripped on every write. */
export function orderDesktopsWithPopouts<
	D extends {
		readonly id: string;
		readonly kind?: "popout";
		readonly originSpaceId?: string;
	},
>(desktops: readonly D[]): readonly D[] {
	const regular = desktops.filter((desktop) => desktop.kind !== "popout");
	const popouts = desktops.filter((desktop) => desktop.kind === "popout");
	const attached = new Set<string>();
	const ordered = regular.flatMap((desktop) => [
		desktop,
		...popouts.filter((popout) => {
			const match = popout.originSpaceId === desktop.id;
			if (match) attached.add(popout.id);
			return match;
		}),
	]);
	return [...ordered, ...popouts.filter((popout) => !attached.has(popout.id))];
}

/** The rows a person can currently see and select, in visual order — the
 *  buckets are repository groups as rendered (repository-first: the top-level
 *  groups; space-first: every repository sub-group, space by space). Rows
 *  behind a folded repository are not rendered, so a shift-range, a bulk
 *  action, or a multi-row drag must never reach them — except the focused
 *  pane's row, which a folded repository keeps showing. */
export function selectableRowKeys(
	buckets: readonly {
		readonly key: string;
		readonly spaces: readonly { readonly key: string }[];
	}[],
	collapsed: Readonly<Record<string, true>>,
	focusedKey: string | null = null,
): readonly string[] {
	return buckets.flatMap((bucket) =>
		collapsed[bucket.key]
			? bucket.spaces
					.filter((row) => row.key === focusedKey)
					.map((row) => row.key)
			: bucket.spaces.map((row) => row.key),
	);
}
