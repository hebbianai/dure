// The Spaces list can be read two ways — space → repository → pane, or
// repository → space → pane — and both start from the same pass over the
// rows. This module owns that pass and the desktop ordering; the grouping
// itself is `spaceRepositoryGroups`.
import {
	type RepositorySpaceRow,
	spaceRepositoryGroupKey,
} from "@/lib/spaces/spaceRepositoryGroups";
import type { NeedsPersonReason } from "@/lib/agents/needsPerson";
import {
	countsTowardNeedsPersonRollup,
	countsTowardProgramStatusRollup,
} from "@/lib/spaces/spacesStateFilter";
import {
	isPanePinned,
	panePinKey,
	type PinnedPanes,
} from "@/lib/workspace/pane/panePin";

export interface HierarchySpaceRow extends RepositorySpaceRow {
	readonly desktopId: string;
	readonly displayState?: string;
	/** Why a person is needed, from the needs-person authority. */
	readonly needsPerson?: NeedsPersonReason;
	readonly programStatusKind?: string;
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
	/** Programs reporting they wait, on rows Host attention did not count. */
	readonly programStatusByDesktop: ReadonlyMap<string, number>;
	readonly programStatusByRepository: ReadonlyMap<string, number>;
}

function increment(counts: Map<string, number>, key: string): void {
	counts.set(key, (counts.get(key) ?? 0) + 1);
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
	const programStatusByDesktop = new Map<string, number>();
	const programStatusByRepository = new Map<string, number>();
	for (const row of rows) {
		if (countsTowardNeedsPersonRollup(row)) {
			increment(attentionByDesktop, row.desktopId);
			increment(attentionByRepository, spaceRepositoryGroupKey(row));
		} else if (countsTowardProgramStatusRollup(row)) {
			increment(programStatusByDesktop, row.desktopId);
			increment(programStatusByRepository, spaceRepositoryGroupKey(row));
		}
		if (!isVisible(row)) continue;
		const bucket = visibleByDesktop.get(row.desktopId);
		if (bucket) bucket.push(row);
		else visibleByDesktop.set(row.desktopId, [row]);
	}
	return {
		visibleByDesktop,
		attentionByDesktop,
		attentionByRepository,
		programStatusByDesktop,
		programStatusByRepository,
	};
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

/** What a row needs to take part in lead/worker nesting. */
export interface LeadWorkerRow {
	readonly key: string;
	readonly desktopId?: string;
	/** The row's node in the relation forest: its Agent, or the plain shell
	 * row itself (`shellRowKey`). */
	readonly relationKey?: string;
	/** The node this row's Agent was started from, when resolved: its
	 * display manager. */
	readonly leadKey?: string;
	/** Start order among the lead's workers. */
	readonly workerOrder?: number;
}

export interface LeadWorkerEntry<Row> {
	readonly row: Row;
	/** This row's workers, in start order; empty for every other row. */
	readonly workers: readonly Row[];
}

const NO_WORKERS: readonly never[] = [];

/** The fold that hides a lead's workers. Keyed by the lead's relation node,
 *  so for an Agent the decision holds when its pane moves, closes or
 *  reopens. */
export function leadWorkersFoldKey(leadKey: string): string {
	return `lead-workers:${leadKey}`;
}

/** One list's rows with each lead's workers lifted under it, one step deep.
 *  A worker nests only when its lead's row is in the same list and the same
 *  space, and that lead is not itself nested; otherwise it keeps its own
 *  place, as does every row without a lead. Leads and ordinary rows keep the
 *  order they came in. Staying inside one space keeps the nesting identical
 *  whether a repository's rows are drawn space by space or as one run. */
export function nestLeadWorkers<Row extends LeadWorkerRow>(
	rows: readonly Row[],
): readonly LeadWorkerEntry<Row>[] {
	if (!rows.some((row) => row.leadKey !== undefined)) {
		return rows.map((row) => ({ row, workers: NO_WORKERS }));
	}
	const rowByNode = new Map<string, Row>();
	for (const row of rows) {
		if (row.relationKey && !rowByNode.has(row.relationKey)) {
			rowByNode.set(row.relationKey, row);
		}
	}
	const leadRowOf = (row: Row): Row | undefined => {
		if (row.leadKey === undefined || row.leadKey === row.relationKey) {
			return undefined;
		}
		const lead = rowByNode.get(row.leadKey);
		return lead?.desktopId === row.desktopId ? lead : undefined;
	};
	const workersByLead = new Map<string, Row[]>();
	const nested = new Set<string>();
	for (const row of rows) {
		const lead = leadRowOf(row);
		if (!lead || leadRowOf(lead)) continue;
		const workers = workersByLead.get(lead.key);
		if (workers) workers.push(row);
		else workersByLead.set(lead.key, [row]);
		nested.add(row.key);
	}
	const position = new Map(rows.map((row, index) => [row.key, index]));
	const startOrder = (row: Row) =>
		row.workerOrder ?? Number.MAX_SAFE_INTEGER;
	return rows
		.filter((row) => !nested.has(row.key))
		.map((row) => {
			const workers = workersByLead.get(row.key);
			return {
				row,
				workers: workers
					? workers.sort(
							(left, right) =>
								startOrder(left) - startOrder(right) ||
								(position.get(left.key) ?? 0) - (position.get(right.key) ?? 0),
						)
					: NO_WORKERS,
			};
		});
}

/** The keys of one list's rows in the order they are drawn: each lead, then
 *  its workers unless their fold is closed — a closed fold still shows the
 *  focused pane's row, like a folded repository. */
export function leadWorkerRowKeys(
	rows: readonly LeadWorkerRow[],
	collapsed: Readonly<Record<string, true>>,
	focusedKey: string | null = null,
): string[] {
	return nestLeadWorkers(rows).flatMap(({ row, workers }) => [
		row.key,
		...(row.relationKey && collapsed[leadWorkersFoldKey(row.relationKey)]
			? workers.filter((worker) => worker.key === focusedKey)
			: workers
		).map((worker) => worker.key),
	]);
}

/** The rows a person can currently see and select, in visual order — the
 *  buckets are repository groups as rendered (repository-first: the top-level
 *  groups; space-first: every repository sub-group, space by space). Rows
 *  behind a folded repository are not rendered, so a shift-range, a bulk
 *  action, or a multi-row drag must never reach them — except the focused
 *  pane's row, which a folded repository keeps showing. Workers follow their
 *  lead, as drawn. */
export function selectableRowKeys(
	buckets: readonly {
		readonly key: string;
		readonly spaces: readonly LeadWorkerRow[];
	}[],
	collapsed: Readonly<Record<string, true>>,
	focusedKey: string | null = null,
): readonly string[] {
	return buckets.flatMap((bucket) =>
		collapsed[bucket.key]
			? bucket.spaces
					.filter((row) => row.key === focusedKey)
					.map((row) => row.key)
			: leadWorkerRowKeys(bucket.spaces, collapsed, focusedKey),
	);
}
