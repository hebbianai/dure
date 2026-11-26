import { compareWaitStart, hasResult } from "@/lib/agents/agentResult";
import { type AgentRowModel, agentRowModel } from "@/lib/agents/agentRowModel";
import {
	type PendingApproval,
	parseAgentApprovalRequest,
} from "@/lib/agents/approvalRequest";
import {
	currentEpochFailure,
	type NeedsPerson,
	type NeedsPersonFailure,
	needsPersonOf,
} from "@/lib/agents/needsPerson";
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
import type { NeedsPersonStatus } from "./agentRowText";
import type { CensusModel } from "./censusView";
import { queueKey } from "./chatQueue";
import { homeRelations } from "./homeRelations";
import { facetLabel } from "./homeViewLabels";
import { t } from "./i18n";
import type { HubProbeSession } from "./ipc";

export interface HomeRow extends SpacesFacetSource {
	readonly row: UnifiedRow;
	readonly pinned?: boolean;
	readonly detail?: string;
	readonly git?: SessionPresentation["git"];
	/** The computer's Agent this row shows, and its display manager. */
	readonly agentId?: string;
	readonly managerAgentId?: string;
	/** When the computer's backend continues the agent by itself after its
	 * usage limit resets, while it waits for that. */
	readonly continuesAtMs?: number;
	/**
	 * Why only a person can move it forward, from the shared needs-person
	 * authority; `needsPerson` is its reason, for the list's facets.
	 */
	readonly need?: NeedsPerson;
	/**
	 * The shared agent row: its needs-person status, the agents above it and
	 * what it manages. Every row `homeRows` returns has one.
	 */
	readonly agent?: AgentRowModel;
}

export interface HomeGroup {
	readonly key: string;
	readonly label: string;
	readonly rows: readonly HomeRow[];
}

/** One agent only a person can move forward, in home's Needs you section. */
export interface NeedsYouCard {
	readonly view: HomeRow;
	/** Why, as the shared needs-person authority and row model name it. */
	readonly status: NeedsPersonStatus;
	/**
	 * The approval the card answers in place: the computer carried what it
	 * asks and answers it from the phone (`approval_answer`). Without it the
	 * card opens the agent, where the person answers.
	 */
	readonly approval?: PendingApproval;
}

/** One agent with a result from the last day, in home's Has a result section. */
export interface FinishedCard {
	readonly view: HomeRow;
	/** The computer that serves the agent's conversation: its answer is read there. */
	readonly source: Extract<UnifiedSource, { kind: "hub" }>;
	/** That conversation, as the chat names it: its answer is kept under this. */
	readonly key: string;
}

/** The most finished agents home shows. More would push the list away. */
export const RECENTLY_FINISHED_LIMIT = 3;

/**
 * The phone's has-a-result window: a result from the last 24 hours, measured
 * from the agent's last activity. The desktop's Next up uses "not looked at
 * yet" instead; the phone has no record of what was looked at.
 */
export const RECENTLY_FINISHED_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Newest first, by when each card's wait or result began. The desktop lists
 * them oldest first; the phone is glanced at for what just changed, so it reads
 * the same comparator the other way round. Equal starts fall back to title and
 * id, so every redraw keeps one order.
 */
function newestFirst<Card extends { readonly view: HomeRow }>(
	sinceOf: (card: Card) => number | undefined,
): (left: Card, right: Card) => number {
	return (left, right) =>
		compareWaitStart({ sinceMs: sinceOf(right) }, { sinceMs: sinceOf(left) }) ||
		left.view.row.title.localeCompare(right.view.row.title) ||
		left.view.row.sessionId.localeCompare(right.view.row.sessionId);
}

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
 * Every agent only a person can move forward — an approval, an answer, an
 * error or an unexpected exit — newest wait first.
 *
 * Membership is the shared needs-person authority's (`homeRows` puts its
 * verdict on each row), read across every group and filter: a wait in another
 * Space still waits. A row whose computer does not answer now is left out,
 * since its facts may be gone. One whose session cannot be opened is left out
 * too, except an unexpected exit: the exit is why it cannot be opened, and its
 * card leads to the session's details instead.
 */
export function needsYou(rows: readonly HomeRow[]): NeedsYouCard[] {
	const cards: NeedsYouCard[] = [];
	for (const view of rows) {
		const need = view.need;
		const status = view.agent?.status;
		if (!need || !status || status === "result" || !view.row.source.reachable)
			continue;
		if (need.reason !== "unexpected_exit" && !view.row.source.session.ready)
			continue;
		const approval = need.reason === "approval" ? answerableApproval(view) : undefined;
		cards.push({ view, status, ...(approval ? { approval } : {}) });
	}
	return cards.sort(newestFirst((card) => card.view.need?.sinceMs));
}

/**
 * The agents with a result from the last day, newest first.
 *
 * Read across every group and filter, as Needs you is: a result in another
 * Space is still the result the person came for. "Has a result" is the shared
 * predicate (`agentResult.ts`) over the desktop's display state: an idle agent
 * with nothing raised (`waiting`) finished the turn it ran, and an agent a
 * person is needed for is in Needs you instead. An agent with no answer yet
 * shows no card. Only agents whose conversation the computer serves
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
			view.need ||
			source.kind !== "hub" ||
			!source.reachable ||
			!source.session.ready ||
			source.session.conversation !== true ||
			!hasResult(
				{
					state: view.displayState,
					turnFinished: view.displayState === "waiting",
					...(view.activityAt === undefined ? {} : { resultAtMs: view.activityAt }),
				},
				{ sinceMs: now - RECENTLY_FINISHED_WINDOW_MS },
			)
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
		.sort(newestFirst((card) => card.view.activityAt))
		.slice(0, RECENTLY_FINISHED_LIMIT);
}

/**
 * The Host's record of this session's unexpected exit, if it describes the
 * process running now. The shared authority makes that call
 * (`currentEpochFailure`); the session and workspace are the row's own, since
 * the computer copied the record from the same session.
 */
function currentFailure(session: HubProbeSession): NeedsPersonFailure | undefined {
	const failure = session.failure;
	if (!failure) return undefined;
	return currentEpochFailure({
		sessionId: session.session_id,
		workspaceId: session.workspace_id,
		terminalEpoch: session.terminal_epoch,
		failure: {
			sessionId: session.session_id,
			workspaceId: session.workspace_id,
			terminalEpoch: failure.terminal_epoch,
			code: failure.code,
			occurredUnixMs: failure.occurred_unix_ms,
		},
	});
}

export function homeRows(
	model: Pick<CensusModel, "census" | "hubs" | "layout">,
): { rows: HomeRow[]; hidden: number } {
	const listing = buildUnifiedListing(model);
	const placed = model.layout.desktop_order.length > 0;
	const rows = placed
		? listing.groups.flatMap((group) => group.rows)
		: flattenRows(model);
	// What the answering computers say about each session, the first that
	// says it winning: a row that came by SSH still has the laptop's words.
	const presentations = new Map<string, SessionPresentation>();
	const failures = new Map<string, NeedsPersonFailure>();
	for (const hub of model.hubs) {
		if (!hub.reachable) continue;
		for (const session of hub.sessions) {
			if (session.presentation && !presentations.has(session.session_id))
				presentations.set(session.session_id, session.presentation);
			const failure = failures.has(session.session_id)
				? undefined
				: currentFailure(session);
			if (failure) failures.set(session.session_id, failure);
		}
	}
	const views = rows.map((row): HomeRow => {
		const source = row.source;
		const seat = model.layout.placements[row.sessionId];
		const presentation = presentations.get(row.sessionId);
		const remote =
			source.kind === "ssh" || source.session.box_id !== "this-laptop";
		// The phone sees no wait begin, so a wait is dated by the agent's
		// last activity: the moment it stopped to wait. An exit is dated by
		// the Host. An error the computer's backend continues by itself after
		// the limit resets needs no one, as on the desktop.
		const need = needsPersonOf({
			displayState: presentation?.displayState,
			failure: failures.get(row.sessionId),
			waitingSinceMs: presentation?.activityAt,
			continuesAtMs: presentation?.continuesAtMs,
		});
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
			...(need ? { need, needsPerson: need.reason } : {}),
			row,
		};
	});
	// Over every row, before any filter: a filter changes what is shown, not
	// who manages whom.
	const relations = homeRelations(views);
	return {
		hidden: placed ? listing.hidden : 0,
		rows: views.map((view) => ({
			...view,
			agent: agentRowModel({
				agentId: view.agentId ?? view.row.sessionId,
				title: view.row.title,
				state: view.displayState,
				needsPerson: view.need,
				projectName: view.projectName,
				spaceName: view.desktopName,
				path: relations.path(view),
				managed: relations.managed(view),
				continuesAtMs: view.continuesAtMs,
			}),
		})),
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
