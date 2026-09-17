import type { SessionsViewOptions } from "@/lib/sessions/sessionsViewOptions";
import type {
	RecentWorkGroup,
	RecentWorkItem,
	RecentWorkProjection,
} from "@/lib/sessions/recentWork";
import { PROVIDERS } from "@/types";

function isOpenInPane(
	item: RecentWorkItem,
	openPaneSessionKeys: ReadonlySet<string>,
): boolean {
	return openPaneSessionKeys.has(item.key);
}

function orderItems(
	items: readonly RecentWorkItem[],
	orderBy: SessionsViewOptions["orderBy"],
): RecentWorkItem[] {
	return items
		.map((item, index) => ({ item, index }))
		.sort((left, right) => {
			const order =
				orderBy === "name"
					? left.item.title.localeCompare(right.item.title, undefined, {
							sensitivity: "base",
						})
					: orderBy === "oldest"
						? left.item.mtime - right.item.mtime
						: right.item.mtime - left.item.mtime;
			return order || left.index - right.index;
		})
		.map(({ item }) => item);
}

function groupItems(
	items: readonly RecentWorkItem[],
	projection: RecentWorkProjection,
	groupBy: SessionsViewOptions["groupBy"],
	orderBy: SessionsViewOptions["orderBy"],
): RecentWorkGroup[] {
	if (items.length === 0) return [];
	if (groupBy === "none") {
		return [{ id: "sessions\0all", name: "", cwd: "", items: [...items] }];
	}

	const repositoryGroups = new Map(
		projection.groups.map((group) => [group.id, group] as const),
	);
	const groups = new Map<string, RecentWorkGroup>();
	for (const item of items) {
		const source = repositoryGroups.get(item.groupIdentity);
		const id =
			groupBy === "provider"
				? `provider\0${item.provider}`
				: `repository\0${item.groupIdentity}`;
		const group = groups.get(id) ?? {
			id,
			name:
				groupBy === "provider"
					? PROVIDERS[item.provider].label
					: (source?.name ?? item.workspaceRoot),
			cwd:
				groupBy === "provider"
					? PROVIDERS[item.provider].label
					: (source?.cwd ?? item.workspaceRoot),
			items: [],
		};
		group.items.push(item);
		groups.set(id, group);
	}
	const result = [...groups.values()];
	if (orderBy === "name") {
		result.sort((left, right) =>
			left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
		);
	}
	return result;
}

/** Apply user-selected presentation only after the provider inventory and
 * exact pane-presence facts have each been projected by their owner. */
export function projectRecentSessionsView(input: {
	projection: RecentWorkProjection;
	options: SessionsViewOptions;
	openPaneSessionKeys: ReadonlySet<string>;
	limit?: number;
}): RecentWorkProjection {
	const paneFilter = input.options.paneFilter;
	const filtered = input.projection.groups
		.flatMap((group) => group.items)
		.filter((item) => {
			if (paneFilter === "all") return true;
			const open = isOpenInPane(item, input.openPaneSessionKeys);
			return paneFilter === "open_only" ? open : !open;
		});
	const ordered = orderItems(filtered, input.options.orderBy).slice(
		0,
		Math.max(0, input.limit ?? Number.MAX_SAFE_INTEGER),
	);
	return {
		groups: groupItems(
			ordered,
			input.projection,
			input.options.groupBy,
			input.options.orderBy,
		),
		total: ordered.length,
	};
}

/** A group the reader has not opened or folded follows the list's default:
 * the first group open, the rest folded. */
export function recentSessionGroupOpen(
	openGroups: Readonly<Record<string, boolean>>,
	groupId: string,
	index: number,
): boolean {
	return openGroups[groupId] ?? index === 0;
}

/** Which bulk fold commands would change the list. Neither applies when the
 * list is not foldable: ungrouped, or a search holding every group open. */
export function recentSessionsFoldAvailability(
	groups: readonly RecentWorkGroup[],
	openGroups: Readonly<Record<string, boolean>>,
	foldable: boolean,
): { canExpandAll: boolean; canCollapseAll: boolean } {
	const open = groups.map((group, index) =>
		recentSessionGroupOpen(openGroups, group.id, index),
	);
	return {
		canExpandAll: foldable && open.some((value) => !value),
		canCollapseAll: foldable && open.some(Boolean),
	};
}

/** Open or fold every projected group at once. Choices for groups the current
 * projection does not show are kept for when they return. */
export function foldRecentSessionGroups(
	openGroups: Readonly<Record<string, boolean>>,
	groups: readonly RecentWorkGroup[],
	action: "expand" | "collapse",
): Record<string, boolean> {
	const next = { ...openGroups };
	for (const group of groups) next[group.id] = action === "expand";
	return next;
}
