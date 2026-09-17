import type { AgentDisplayState } from "@/lib/agents/agentStateModel";

/** The user-controlled projection of the current Spaces rows. More grouping,
 * ordering, field, and filter facets extend this one contract instead of
 * creating independent preferences for each menu section. */
export interface SpacesViewOptions {
	readonly groupBy: SpacesGrouping;
	readonly orderBy: SpacesOrdering;
	readonly visibleFields: readonly SpacesVisibleField[];
	/** Show › Space. On, the space is a heading tier under each repository
	 * and a row says it only where no heading does (the pinned band, a folded
	 * repository's lone focused row). Off, the tier folds away — rows run
	 * flat under the repository — and no row says it either: the dimension
	 * is hidden. A boolean rather than a visible field so prefs saved before
	 * it existed keep their spaces. */
	readonly showSpaces: boolean;
	readonly filters: SpacesFilters;
}

export type SpacesGrouping =
	| "repository"
	| "location"
	| "space"
	| "environment"
	| "updated"
	| "status";
export type SpacesFacetGrouping = Extract<
	SpacesGrouping,
	"location" | "environment" | "updated" | "status"
>;
export type SpacesOrdering = "stable" | "updated" | "status";

/** Fields the Show menu offers on a row's info line. Space sits in the same
 * list but is `showSpaces`, a tier toggle, not a field. The environment
 * stays a field — "Local" on every row was asked back (owner call
 * 2026-09-14) — and leaves only the rows whose band states it. */
const SPACES_VISIBLE_FIELDS = [
	"updated",
	"environment",
	"branch",
	"machine",
	"details",
	"gitStatus",
] as const;
export type SpacesVisibleField = (typeof SPACES_VISIBLE_FIELDS)[number];
/** What the Show list offers: the fields, plus the space tier toggle. */
export type SpacesShowItem = SpacesVisibleField | "space";

export const SPACES_STATUS_FILTER_VALUES = [
	"error",
	"blocked",
	"input",
	"working",
	"connecting",
	"waiting",
	"exited",
	"unknown",
] as const;
export type SpacesStatusFilter = AgentDisplayState | "unknown";
export const SPACES_ENVIRONMENTS = ["local", "ssh", "unknown"] as const;
export type SpacesEnvironment = (typeof SPACES_ENVIRONMENTS)[number];
export type SpacesSource = `provider:${string}` | "shell" | "ssh";

/** Empty means "all" for each facet. Values inside one facet are ORed; the
 * non-empty facets are ANDed. Repository and location identities are opaque
 * canonical keys produced by the row-facet projector. */
export interface SpacesFilters {
	readonly status: readonly SpacesStatusFilter[];
	readonly environment: readonly SpacesEnvironment[];
	readonly repository: readonly string[];
	readonly location: readonly string[];
	readonly source: readonly SpacesSource[];
}

export type SpacesFilterFacet = keyof SpacesFilters;

const DEFAULT_SPACES_VISIBLE_FIELDS: readonly SpacesVisibleField[] = [
	"updated",
	"branch",
	"details",
	"gitStatus",
];

export const EMPTY_SPACES_FILTERS: SpacesFilters = {
	status: [],
	environment: [],
	repository: [],
	location: [],
	source: [],
};

export const DEFAULT_SPACES_VIEW_OPTIONS: SpacesViewOptions = {
	groupBy: "repository",
	orderBy: "stable",
	visibleFields: DEFAULT_SPACES_VISIBLE_FIELDS,
	showSpaces: true,
	filters: EMPTY_SPACES_FILTERS,
};

function recordValue(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function stringValues<T extends string>(
	value: unknown,
	isValue: (candidate: string) => candidate is T,
): readonly T[] {
	if (!Array.isArray(value)) return [];
	return [
		...new Set(
			value.filter(
				(candidate): candidate is T =>
					typeof candidate === "string" && isValue(candidate),
			),
		),
	];
}

const isVisibleField = (value: string): value is SpacesVisibleField =>
	(SPACES_VISIBLE_FIELDS as readonly string[]).includes(value);
const isStatusFilter = (value: string): value is SpacesStatusFilter =>
	(SPACES_STATUS_FILTER_VALUES as readonly string[]).includes(value);
const isEnvironment = (value: string): value is SpacesEnvironment =>
	(SPACES_ENVIRONMENTS as readonly string[]).includes(value);
const isOpaqueFacetValue = (value: string): value is string => value.length > 0;
const isSource = (value: string): value is SpacesSource =>
	value === "shell" ||
	value === "ssh" ||
	(value.startsWith("provider:") && value.length > "provider:".length);

function normalizeFilters(value: unknown): SpacesFilters {
	const record = recordValue(value);
	return {
		status: stringValues(record.status, isStatusFilter),
		environment: stringValues(record.environment, isEnvironment),
		repository: stringValues(record.repository, isOpaqueFacetValue),
		location: stringValues(record.location, isOpaqueFacetValue),
		source: stringValues(record.source, isSource),
	};
}

/** Parse persisted or CLI-written bytes once. `legacyGroupBy` migrates the
 * former `uiPrefs.spacesGroupBy` preference without changing the user's view. */
export function normalizeSpacesViewOptions(
	value: unknown,
	legacyGroupBy?: unknown,
): SpacesViewOptions {
	const record = recordValue(value);
	const groupBy =
		record.groupBy === "repository" ||
		record.groupBy === "location" ||
		record.groupBy === "space" ||
		record.groupBy === "environment" ||
		record.groupBy === "updated" ||
		record.groupBy === "status"
			? record.groupBy
			: legacyGroupBy === "space"
				? "space"
				: "repository";
	const orderBy =
		record.orderBy === "updated" || record.orderBy === "status"
			? record.orderBy
			: "stable";
	const persistedFields = Array.isArray(record.visibleFields)
		? new Set(stringValues(record.visibleFields, isVisibleField))
		: undefined;
	const visibleFields = persistedFields
		? SPACES_VISIBLE_FIELDS.filter((field) => persistedFields.has(field))
		: DEFAULT_SPACES_VISIBLE_FIELDS;
	return {
		groupBy,
		orderBy,
		visibleFields,
		// Absent means shown: the toggle arrived after prefs were being saved.
		showSpaces: record.showSpaces !== false,
		filters: normalizeFilters(record.filters),
	};
}

export function hasActiveSpacesFilters(filters: SpacesFilters): boolean {
	return Object.values(filters).some((values) => values.length > 0);
}

export function hasDefaultSpacesFieldsAndFilters(
	value: SpacesViewOptions,
): boolean {
	return (
		value.visibleFields.length === DEFAULT_SPACES_VISIBLE_FIELDS.length &&
		value.visibleFields.every(
			(field, index) => field === DEFAULT_SPACES_VISIBLE_FIELDS[index],
		) &&
		value.showSpaces &&
		!hasActiveSpacesFilters(value.filters)
	);
}

export function resetSpacesFieldsAndFilters(
	value: SpacesViewOptions,
): SpacesViewOptions {
	return {
		...value,
		visibleFields: DEFAULT_SPACES_VISIBLE_FIELDS,
		showSpaces: true,
		filters: EMPTY_SPACES_FILTERS,
	};
}

/** The Show fields a grouping's headings already state. The menu does not
 * offer them and a row under those headings leaves them out, so nothing is
 * said twice. A location heading is "host · path": it names the machine, and
 * with it the environment; the Local/SSH band names the environment. The day
 * buckets do not state Updated — the row's minutes are finer than the
 * bucket — and the repository heading's folder is not a field (the row's
 * detail is relative to it below the root). */
export function spacesFieldsStatedBy(
	groupBy: SpacesGrouping,
): readonly SpacesShowItem[] {
	switch (groupBy) {
		case "space":
			return ["space"];
		case "location":
			return ["environment", "machine"];
		case "environment":
			return ["environment"];
		default:
			return [];
	}
}

/** The orderings a grouping's buckets already impose. Inside a status bucket
 * every row has the same status, so ordering by it changes nothing; the menu
 * does not offer it there and shows pane order in its place, keeping the
 * stored preference for the other groupings. The day buckets do not make
 * ordering by time moot — rows inside "Today" still differ by the minute. */
export function spacesOrderingsStatedBy(
	groupBy: SpacesGrouping,
): readonly SpacesOrdering[] {
	return groupBy === "status" ? ["status"] : [];
}

/** The ordering the list actually follows: the stored one, unless the
 * grouping's buckets already impose it, when it is pane order. */
export function effectiveSpacesOrdering(value: SpacesViewOptions): SpacesOrdering {
	return spacesOrderingsStatedBy(value.groupBy).includes(value.orderBy)
		? "stable"
		: value.orderBy;
}

export function toggleSpacesVisibleField(
	fields: readonly SpacesVisibleField[],
	field: SpacesVisibleField,
	checked: boolean,
): readonly SpacesVisibleField[] {
	const selected = new Set(fields);
	if (checked) selected.add(field);
	else selected.delete(field);
	return SPACES_VISIBLE_FIELDS.filter((candidate) => selected.has(candidate));
}

export function toggleSpacesFilter<Facet extends SpacesFilterFacet>(
	filters: SpacesFilters,
	facet: Facet,
	value: SpacesFilters[Facet][number],
	checked: boolean,
): SpacesFilters {
	const selected = new Set<string>(filters[facet]);
	if (checked) selected.add(value);
	else selected.delete(value);
	return { ...filters, [facet]: [...selected] };
}
