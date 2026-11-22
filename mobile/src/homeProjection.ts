import {
	type PendingApproval,
	parseAgentApprovalRequest,
} from "@/lib/agents/approvalRequest";
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
	type UnifiedSource,
} from "./allSessions";
import type { CensusModel } from "./censusView";
import { queueKey } from "./chatQueue";
import { facetLabel } from "./homeViewLabels";
import { t } from "./i18n";

export interface HomeRow extends SpacesFacetSource {
	readonly row: UnifiedRow;
	readonly pinned?: boolean;
	readonly detail?: string;
	readonly git?: SessionPresentation["git"];
}

export interface HomeGroup {
	readonly key: string;
	readonly label: string;
	readonly rows: readonly HomeRow[];
}

/** One agent waiting for the person, in home's Needs you section. */
export interface NeedsYouCard {
	readonly view: HomeRow;
	/** What it waits for, as the desktop's display state says. */
	readonly wait: "approval" | "input";
	/**
	 * The approval the card answers in place: the computer carried what it
	 * asks and answers it from the phone (`approval_answer`). Without it the
	 * card opens the agent, where the person answers.
	 */
	readonly approval?: PendingApproval;
}

/** One agent that finished a turn recently, in home's Recently finished section. */
export interface FinishedCard {
	readonly view: HomeRow;
	/** The computer that serves the agent's conversation: its answer is read there. */
	readonly source: Extract<UnifiedSource, { kind: "hub" }>;
	/** That conversation, as the chat names it: its answer is kept under this. */
	readonly key: string;
}

/** The most finished agents home shows. More would push the list away. */
export const RECENTLY_FINISHED_LIMIT = 3;

/** How long after its last activity a finished agent still counts as recent. */
export const RECENTLY_FINISHED_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Newest activity first, then by title and id so equal times keep one order. */
function newestFirst(left: HomeRow, right: HomeRow): number {
	return (
		(right.activityAt ?? 0) - (left.activityAt ?? 0) ||
		left.row.title.localeCompare(right.row.title) ||
		left.row.sessionId.localeCompare(right.row.sessionId)
	);
}

/** The display states that wait for a person, and for what. */
const WAITS: Readonly<Record<string, NeedsYouCard["wait"]>> = {
	blocked: "approval",
	input: "input",
};

/**
 * The approval a row's computer carried, read with the same validator as the
 * Host's own record: anything malformed is absent and the agent is answered
 * where it runs, as before.
 */
function answerableApproval(view: HomeRow): PendingApproval | undefined {
	const source = view.row.source;
	if (source.kind !== "hub" || source.session.approval_answer !== true)
		return undefined;
	const carried: unknown = source.session.presentation?.approval;
	if (typeof carried !== "object" || carried === null) return undefined;
	const { attentionId, request } = carried as Record<string, unknown>;
	const parsed = parseAgentApprovalRequest(request);
	return typeof attentionId === "string" && attentionId && parsed
		? { attentionId, request: parsed }
		: undefined;
}

/**
 * Every agent waiting for an approval or an answer, newest wait first.
 *
 * Read from home's own rows and their desktop display state — the attention
 * the list's rows already show, not a second model of it — and across every
 * group and filter: a wait in another Space still waits. Rows that cannot be
 * opened right now are left out, since the card could only fail.
 */
export function needsYou(rows: readonly HomeRow[]): NeedsYouCard[] {
	const cards: NeedsYouCard[] = [];
	for (const view of rows) {
		const wait = view.displayState ? WAITS[view.displayState] : undefined;
		if (!wait || !view.row.source.reachable || !view.row.source.session.ready)
			continue;
		const approval = wait === "approval" ? answerableApproval(view) : undefined;
		cards.push({ view, wait, ...(approval ? { approval } : {}) });
	}
	return cards.sort((left, right) => newestFirst(left.view, right.view));
}

/**
 * The agents that finished a turn recently and now wait idle, newest first.
 *
 * Read across every group and filter, as Needs you is: a result in another
 * Space is still the result the person came for. "Finished" is the desktop's
 * own display state for an idle agent with nothing raised (`waiting`); whether
 * a turn actually ended is the computer's to say, and an agent with no answer
 * yet shows no card. Only agents whose conversation the computer serves
 * (`conversation`) are listed: the answer is read from there.
 */
export function recentlyFinished(
	rows: readonly HomeRow[],
	now: number,
): FinishedCard[] {
	const cards: FinishedCard[] = [];
	for (const view of rows) {
		const source = view.row.source;
		if (
			view.displayState !== "waiting" ||
			source.kind !== "hub" ||
			!source.reachable ||
			!source.session.ready ||
			source.session.conversation !== true ||
			view.activityAt === undefined ||
			now - view.activityAt > RECENTLY_FINISHED_WINDOW_MS
		)
			continue;
		const session = source.session;
		cards.push({
			view,
			source,
			key: queueKey(source.hubId, session.box_id, session.workspace_id, session.session_id),
		});
	}
	return cards
		.sort((left, right) => newestFirst(left.view, right.view))
		.slice(0, RECENTLY_FINISHED_LIMIT);
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
	const groups: HomeGroup[] = [];
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
		groups: (hasActiveSpacesFilters(options.filters)
			? groups.filter((group) => group.rows.length > 0)
			: groups).map(group => ({
			...group,
			rows: [
				...group.rows.filter(row => row.pinned === true),
				...group.rows.filter(row => row.pinned !== true),
			],
		})),
		choices: spacesFilterChoices(universe.rows, options.filters),
		hidden: universe.hidden,
		needsYou: needsYou(universe.rows),
		finished: recentlyFinished(universe.rows, now),
	};
}
