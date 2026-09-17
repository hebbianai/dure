export type SessionsGrouping = "repository" | "provider" | "none";
export type SessionsOrdering = "updated" | "oldest" | "name";
export type SessionsPaneFilter = "all" | "exclude_open" | "open_only";

/** One persisted projection contract for the recent-provider-session list. */
export interface SessionsViewOptions {
	readonly groupBy: SessionsGrouping;
	readonly orderBy: SessionsOrdering;
	readonly paneFilter: SessionsPaneFilter;
}

export const DEFAULT_SESSIONS_VIEW_OPTIONS: SessionsViewOptions = {
	groupBy: "repository",
	orderBy: "updated",
	paneFilter: "all",
};

function recordValue(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

/** Parse localStorage and CLI-written values once at the preference boundary. */
export function normalizeSessionsViewOptions(
	value: unknown,
): SessionsViewOptions {
	const record = recordValue(value);
	const groupBy =
		record.groupBy === "provider" || record.groupBy === "none"
			? record.groupBy
			: "repository";
	const orderBy =
		record.orderBy === "oldest" || record.orderBy === "name"
			? record.orderBy
			: "updated";
	const paneFilter =
		record.paneFilter === "exclude_open" || record.paneFilter === "open_only"
			? record.paneFilter
			: "all";
	return { groupBy, orderBy, paneFilter };
}
