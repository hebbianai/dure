import type { AgentDisplayState } from "@/lib/agents/agentStateModel";
import { spaceRepositoryGroupKey } from "@/lib/spaces/spaceRepositoryGroups";
import { ATTENTION_DISPLAY_STATES } from "@/lib/spaces/spacesStateFilter";
import {
	hasActiveSpacesFilters,
	SPACES_ENVIRONMENTS,
	SPACES_STATUS_FILTER_VALUES,
	spacesFieldsStatedBy,
	type SpacesEnvironment,
	type SpacesFacetGrouping,
	type SpacesFilters,
	type SpacesGrouping,
	type SpacesOrdering,
	type SpacesSource,
	type SpacesStatusFilter,
	type SpacesVisibleField,
} from "@/lib/spaces/spacesViewOptions";

export interface SpacesFacetSource {
	readonly activityAt?: number;
	readonly displayState?: AgentDisplayState;
	readonly projectId?: string;
	readonly projectName?: string;
	readonly cwd?: string;
	readonly desktopId?: string;
	readonly desktopName?: string;
	readonly kind?: "agent" | "term" | "ssh";
	readonly hostId?: string;
	readonly hostLabel?: string;
	readonly provider?: string | null;
	readonly branch?: string;
}

interface SpacesFacetOption {
	readonly value: string;
	readonly label?: string;
}

export interface SpacesRowFacets {
	readonly updatedAt?: number;
	readonly status: SpacesStatusFilter;
	readonly environment: SpacesEnvironment;
	readonly repository: SpacesFacetOption;
	readonly location: SpacesFacetOption;
	readonly space: SpacesFacetOption;
	readonly machine: SpacesFacetOption;
	readonly source: SpacesSource;
	readonly branch?: string;
}

type SpacesUpdatedBucket =
	| "today"
	| "yesterday"
	| "lastSevenDays"
	| "older"
	| "unknown";
type SpacesStatusBucket = SpacesStatusFilter;
export type SpacesFacetBucket =
	| {
			readonly axis: "location";
			readonly value: string;
			readonly label?: string;
	  }
	| { readonly axis: "environment"; readonly value: SpacesEnvironment }
	| { readonly axis: "updated"; readonly value: SpacesUpdatedBucket }
	| { readonly axis: "status"; readonly value: SpacesStatusBucket };

export interface SpacesFacetGroup<Row> {
	readonly key: string;
	readonly bucket: SpacesFacetBucket;
	readonly spaces: readonly Row[];
	readonly attentionCount: number;
}

const STATUS_RANK: Record<SpacesStatusBucket, number> = {
	error: 0,
	blocked: 1,
	input: 2,
	working: 3,
	connecting: 4,
	waiting: 5,
	exited: 6,
	unknown: 7,
};

const UPDATED_RANK: Record<SpacesUpdatedBucket, number> = {
	today: 0,
	yesterday: 1,
	lastSevenDays: 2,
	older: 3,
	unknown: 4,
};

const ENVIRONMENT_RANK: Record<SpacesEnvironment, number> = {
	local: 0,
	ssh: 1,
	unknown: 2,
};

const UNKNOWN_VALUE = "unknown";

/** Read every view facet from one row once. Grouping, ordering, filters, and
 * visible metadata consume this projection instead of reinterpreting runtime,
 * host, folder, or provider facts in their own components. */
export function spacesRowFacets(row: SpacesFacetSource): SpacesRowFacets {
	const environment: SpacesEnvironment =
		row.kind === "ssh" || row.hostId
			? "ssh"
			: row.kind === "agent" || row.kind === "term"
				? "local"
				: "unknown";
	const repository = row.projectId
		? {
				value: spaceRepositoryGroupKey({
					projectId: row.projectId,
					projectName: row.projectName ?? "",
					hostId: row.hostId,
				}),
				label: row.projectName || undefined,
			}
		: { value: UNKNOWN_VALUE };
	const remoteHost = row.hostId ?? row.hostLabel;
	const hasExactLocation =
		Boolean(row.cwd) &&
		(environment === "local" || (environment === "ssh" && Boolean(remoteHost)));
	const location = hasExactLocation
		? {
				value: JSON.stringify([
					"location",
					environment === "ssh" ? (remoteHost ?? null) : null,
					row.cwd,
				]),
				label:
					environment === "ssh" && remoteHost
						? `${row.hostLabel ?? row.hostId} · ${row.cwd}`
						: row.cwd,
			}
		: { value: UNKNOWN_VALUE };
	// A local row's host label is the generic "Local" — the environment's
	// word, not a machine's name — so the machine facet has nothing to add
	// there; only a remote host names one. (A nested SSH session reads as
	// "ssh" with its target as the host.)
	const machine =
		environment === "local"
			? { value: JSON.stringify(["machine", "local"]) }
			: environment === "ssh" && remoteHost
				? {
						value: JSON.stringify(["machine", remoteHost]),
						label: row.hostLabel ?? row.hostId,
					}
				: { value: UNKNOWN_VALUE };
	return {
		updatedAt:
			row.activityAt !== undefined && Number.isFinite(row.activityAt)
				? row.activityAt
				: undefined,
		status: row.displayState ?? "unknown",
		environment,
		repository,
		location,
		space: {
			value: row.desktopId || UNKNOWN_VALUE,
			label: row.desktopName || undefined,
		},
		machine,
		source: row.provider
			? `provider:${row.provider}`
			: row.kind === "ssh"
				? "ssh"
				: "shell",
		branch: row.branch || undefined,
	};
}

function compareSpacesRowFacets(
	a: SpacesRowFacets,
	b: SpacesRowFacets,
	orderBy: SpacesOrdering,
): number {
	if (orderBy === "stable") return 0;
	if (orderBy === "updated") {
		if (a.updatedAt === undefined) return b.updatedAt === undefined ? 0 : 1;
		if (b.updatedAt === undefined) return -1;
		return b.updatedAt - a.updatedAt;
	}
	return STATUS_RANK[a.status] - STATUS_RANK[b.status];
}

export function spacesLocalDayStart(at: number): number {
	const date = new Date(at);
	date.setHours(0, 0, 0, 0);
	return date.getTime();
}

function localDaysBefore(dayStart: number, days: number): number {
	const date = new Date(dayStart);
	date.setDate(date.getDate() - days);
	return date.getTime();
}

/** Bucket an already projected row. Updated groups use local calendar dates,
 * so daylight-saving changes cannot turn a calendar day into a duration. */
export function spacesFacetBucket(
	facets: SpacesRowFacets,
	axis: SpacesFacetGrouping,
	nowMs: number,
): SpacesFacetBucket {
	if (axis === "location") {
		return { axis, ...facets.location };
	}
	if (axis === "environment") return { axis, value: facets.environment };
	if (axis === "status") return { axis, value: facets.status };
	if (facets.updatedAt === undefined) return { axis, value: "unknown" };
	const today = spacesLocalDayStart(nowMs);
	if (facets.updatedAt >= today) return { axis, value: "today" };
	const yesterday = localDaysBefore(today, 1);
	if (facets.updatedAt >= yesterday) return { axis, value: "yesterday" };
	const sevenDayWindow = localDaysBefore(today, 6);
	return {
		axis,
		value: facets.updatedAt >= sevenDayWindow ? "lastSevenDays" : "older",
	};
}

export function spacesFacetGroupKey(bucket: SpacesFacetBucket): string {
	return JSON.stringify(["facet", bucket.axis, bucket.value]);
}

function facetRank(bucket: SpacesFacetBucket): number {
	if (bucket.axis === "location") {
		return bucket.value === UNKNOWN_VALUE ? 1 : 0;
	}
	if (bucket.axis === "environment") {
		return ENVIRONMENT_RANK[bucket.value];
	}
	return bucket.axis === "updated"
		? UPDATED_RANK[bucket.value]
		: STATUS_RANK[bucket.value];
}

/** Group rows through the same facet projection used by ordering. `nowMs` is
 * supplied once by the caller, so every row sees the same calendar boundary. */
export function groupSpacesRows<Row extends SpacesFacetSource>(
	rows: readonly Row[],
	axis: SpacesFacetGrouping,
	nowMs: number,
	isVisible: (row: Row) => boolean = () => true,
): readonly SpacesFacetGroup<Row>[] {
	const groups = new Map<
		string,
		{
			key: string;
			bucket: SpacesFacetBucket;
			spaces: Row[];
			attentionCount: number;
		}
	>();
	for (const row of rows) {
		const facets = spacesRowFacets(row);
		const bucket = spacesFacetBucket(facets, axis, nowMs);
		const key = spacesFacetGroupKey(bucket);
		const group = groups.get(key) ?? {
			key,
			bucket,
			spaces: [],
			attentionCount: 0,
		};
		if (isVisible(row)) group.spaces.push(row);
		if (facets.status && ATTENTION_DISPLAY_STATES.has(facets.status)) {
			group.attentionCount += 1;
		}
		groups.set(key, group);
	}
	return [...groups.values()]
		.filter((group) => group.spaces.length > 0)
		.sort((left, right) => facetRank(left.bucket) - facetRank(right.bucket));
}

/** Sort a copy only after the user chooses a dynamic order. Equal facets keep
 * their exact Dockview position; the stable option returns the input itself. */
export function orderSpacesRows<Row extends SpacesFacetSource>(
	rows: readonly Row[],
	orderBy: SpacesOrdering,
): readonly Row[] {
	if (orderBy === "stable") return rows;
	return rows
		.map((row, index) => ({ row, index, facets: spacesRowFacets(row) }))
		.sort(
			(a, b) =>
				compareSpacesRowFacets(a.facets, b.facets, orderBy) ||
				a.index - b.index,
		)
		.map(({ row }) => row);
}

function includesFacet<Value extends string>(
	selected: readonly Value[],
	value: Value,
): boolean {
	return selected.length === 0 || selected.includes(value);
}

function matchesSpacesFilters(
	row: SpacesFacetSource,
	filters: SpacesFilters,
): boolean {
	const facets = spacesRowFacets(row);
	return (
		includesFacet(filters.status, facets.status) &&
		includesFacet(filters.environment, facets.environment) &&
		includesFacet(filters.repository, facets.repository.value) &&
		includesFacet(filters.location, facets.location.value) &&
		includesFacet(filters.source, facets.source)
	);
}

/** Row projection order is deliberate: search narrows the textual universe,
 * facet filters narrow that result, then the chosen ordering arranges a copy.
 * Grouping happens in the hierarchy layer after this function. */
export function projectSpacesRows<Row extends SpacesFacetSource>(
	rows: readonly Row[],
	options: {
		readonly filters: SpacesFilters;
		readonly orderBy: SpacesOrdering;
		readonly matchesSearch?: (row: Row) => boolean;
	},
): readonly Row[] {
	const searched = options.matchesSearch
		? rows.filter(options.matchesSearch)
		: rows;
	const filtered = hasActiveSpacesFilters(options.filters)
		? searched.filter((row) => matchesSpacesFilters(row, options.filters))
		: searched;
	return orderSpacesRows(filtered, options.orderBy);
}

export interface SpacesFilterChoices {
	readonly status: readonly SpacesStatusFilter[];
	readonly environment: readonly SpacesEnvironment[];
	readonly repository: readonly SpacesFacetOption[];
	readonly location: readonly SpacesFacetOption[];
	readonly source: readonly SpacesSource[];
}

function facetOptions(
	rows: readonly SpacesFacetSource[],
	selected: readonly string[],
	read: (facets: SpacesRowFacets) => SpacesFacetOption,
): readonly SpacesFacetOption[] {
	const options = new Map<string, SpacesFacetOption>();
	for (const row of rows) {
		const option = read(spacesRowFacets(row));
		if (!options.has(option.value)) options.set(option.value, option);
	}
	for (const value of selected) {
		if (!options.has(value)) options.set(value, { value });
	}
	return [...options.values()];
}

/** Choices come from the unfiltered row universe, plus stale selected values
 * so a filter can always be unchecked even after its last matching row exits. */
export function spacesFilterChoices(
	rows: readonly SpacesFacetSource[],
	filters: SpacesFilters,
): SpacesFilterChoices {
	const rowFacets = rows.map(spacesRowFacets);
	const statuses = new Set(rowFacets.map((facets) => facets.status));
	for (const value of filters.status) statuses.add(value);
	const environments = new Set(rowFacets.map((facets) => facets.environment));
	for (const value of filters.environment) environments.add(value);
	const sources = new Set(rowFacets.map((facets) => facets.source));
	for (const value of filters.source) sources.add(value);
	return {
		status: SPACES_STATUS_FILTER_VALUES.filter((value) => statuses.has(value)),
		environment: SPACES_ENVIRONMENTS.filter((value) =>
			environments.has(value),
		),
		repository: facetOptions(
			rows,
			filters.repository,
			(facets) => facets.repository,
		),
		location: facetOptions(rows, filters.location, (facets) => facets.location),
		source: [...sources],
	};
}

export type SpacesRowMetadataValue =
	| {
			readonly field: "environment";
			readonly value: SpacesEnvironment;
	  }
	| {
			readonly field:
				| "space"
				| Exclude<SpacesVisibleField, "updated" | "environment">;
			readonly value: string;
	  };

/** What the headings over a row already state, so its info line leaves that
 * out. The flat pinned list (`groupBy` absent) states nothing. A grouped tree
 * states its group axis, and a space heading stands over its rows — except
 * the lone focused one a folded repository keeps showing — so the row prints
 * the space exactly where no heading does; the enclosing section says which.
 * With Show › Space off the space is hidden altogether, headings and rows. */
export interface SpacesRowHeadings {
	readonly groupBy?: SpacesGrouping;
	readonly spaceHeading: boolean;
	readonly showSpaces: boolean;
}

/** The Show fields at least one listed row can show. A field none of them
 * can — Branch in a list of terminals, Machine with nothing remote, Updated
 * with no activity yet — stays a preference, but the menu says it draws
 * nothing here, so a checked item with no visible effect is not a mystery
 * (owner report 2026-09-14). Environment prints "Local"/"SSH" on any row. */
export function spacesFieldsPresent(
	rows: readonly (SpacesFacetSource & { readonly detail?: string })[],
): ReadonlySet<SpacesVisibleField> {
	const present = new Set<SpacesVisibleField>();
	for (const row of rows) {
		const facets = spacesRowFacets(row);
		present.add("environment");
		if (facets.updatedAt !== undefined) present.add("updated");
		if (facets.branch) present.add("branch");
		if (facets.machine.label) present.add("machine");
		if (row.detail) present.add("details");
		if (row.kind === "agent") present.add("gitStatus");
	}
	return present;
}

/** Select optional row metadata, leaving out what the headings over the row
 * already state. Primary row detail retains its own typed source so the
 * renderer can apply the same rule to location-derived context. */
export function visibleSpacesRowMetadata(
	row: SpacesFacetSource,
	fields: readonly SpacesVisibleField[],
	{ groupBy, spaceHeading, showSpaces }: SpacesRowHeadings,
): readonly SpacesRowMetadataValue[] {
	const stated = new Set(groupBy ? spacesFieldsStatedBy(groupBy) : []);
	const selected = new Set(fields.filter((field) => !stated.has(field)));
	const facets = spacesRowFacets(row);
	return [
		...(selected.has("environment")
			? [{ field: "environment" as const, value: facets.environment }]
			: []),
		...(showSpaces && !spaceHeading && facets.space.label
			? [{ field: "space" as const, value: facets.space.label }]
			: []),
		...(selected.has("branch") && facets.branch
			? [{ field: "branch" as const, value: facets.branch }]
			: []),
		...(selected.has("machine") && facets.machine.label
			? [{ field: "machine" as const, value: facets.machine.label }]
			: []),
	];
}
