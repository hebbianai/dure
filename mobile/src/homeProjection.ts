import type { SessionPresentation } from "@/lib/hub/sessionPresentation";
import type {
	SpacesFacetSource,
	SpacesFacetBucket,
} from "@/lib/spaces/spacesViewProjection";
import {
	groupSpacesRows,
	projectSpacesRows,
	spacesFilterChoices,
	spacesRowFacets,
} from "@/lib/spaces/spacesViewProjection";
import {
	hasActiveSpacesFilters,
	type SpacesViewOptions,
} from "@/lib/spaces/spacesViewOptions";
import {
	buildUnifiedListing,
	flattenRows,
	type UnifiedRow,
} from "./allSessions";
import type { CensusModel } from "./censusView";
import { facetLabel } from "./homeViewLabels";
import { t } from "./i18n";

export interface HomeRow extends SpacesFacetSource {
	readonly row: UnifiedRow;
	readonly detail?: string;
	readonly git?: SessionPresentation["git"];
}

export function homeRows(
	model: Pick<CensusModel, "census" | "hubs" | "layout">,
): { rows: HomeRow[]; hidden: number } {
	const listing = buildUnifiedListing(model);
	const placed = model.layout.desktop_order.length > 0;
	const rows = placed
		? listing.groups.flatMap((group) => group.rows)
		: flattenRows(model);
	const presentations = new Map<string, SessionPresentation>();
	for (const hub of model.hubs) {
		if (!hub.reachable) continue;
		for (const session of hub.sessions) {
			if (session.presentation && !presentations.has(session.session_id))
				presentations.set(session.session_id, session.presentation);
		}
	}
	return {
		hidden: placed ? listing.hidden : 0,
		rows: rows.map((row) => {
			const source = row.source;
			const seat = model.layout.placements[row.sessionId];
			const presentation = presentations.get(row.sessionId);
			const remote =
				source.kind === "ssh" || source.session.box_id !== "this-laptop";
			return {
				kind: remote ? "ssh" : "term",
				hostId:
					source.kind === "ssh"
						? source.serverId
						: remote
							? source.session.box_id
							: undefined,
				hostLabel:
					source.kind === "ssh"
						? source.serverLabel
						: source.session.box_label || source.hubLabel,
				projectId: row.project || undefined,
				projectName: row.project || undefined,
				provider:
					row.agent !== "other"
						? row.agent
						: source.session.provider_id === "local-shell"
							? undefined
							: source.session.provider_id,
				...presentation,
				desktopId: seat?.desktop,
				desktopName: seat?.desktop,
				branch: row.branch,
				row,
			};
		}),
	};
}

export function projectHome(
	model: Pick<CensusModel, "census" | "hubs" | "layout">,
	options: SpacesViewOptions,
	now: number,
) {
	const universe = homeRows(model);
	const rows = projectSpacesRows(universe.rows, options);
	const groups: { key: string; label: string; rows: readonly HomeRow[] }[] = [];
	if (options.groupBy === "space" || options.groupBy === "repository") {
		const axis = options.groupBy;
		const grouped = new Map<
			string,
			{ key: string; label: string; rows: HomeRow[] }
		>();
		if (axis === "space") {
			for (const label of model.layout.desktop_order)
				grouped.set(label, { key: label, label: t(label), rows: [] });
		}
		for (const row of rows) {
			const facet = spacesRowFacets(row)[axis];
			const group = grouped.get(facet.value) ?? {
				key: facet.value,
				label: facet.label ?? t("common.unknown"),
				rows: [],
			};
			group.rows.push(row);
			grouped.set(facet.value, group);
		}
		groups.push(...grouped.values());
	} else {
		groups.push(
			...groupSpacesRows(rows, options.groupBy, now).map((group) => ({
				key: group.key,
				label: facetLabel(group.bucket as SpacesFacetBucket),
				rows: group.spaces,
			})),
		);
	}
	return {
		groups: hasActiveSpacesFilters(options.filters)
			? groups.filter((group) => group.rows.length > 0)
			: groups,
		choices: spacesFilterChoices(universe.rows, options.filters),
		hidden: universe.hidden,
	};
}
