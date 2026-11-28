import type { AgentDisplayState } from "@/lib/agents/agentStateModel";
import { AGENT_STATUS_MARK } from "@/lib/agents/agentStatusMark";
import { visibleSpacesRowMetadata } from "@/lib/spaces/spacesViewProjection";
import type { SpacesViewOptions } from "@/lib/spaces/spacesViewOptions";
import { agentPathText, continuesText, managedText } from "./agentRowText";
import { agentDot, element, loader } from "./dom";
import type { CensusActions } from "./censusView";
import type { HomeRow } from "./homeProjection";
import { environmentLabel, statusLabel } from "./homeViewLabels";
import { relativeTime } from "./relativeTime";
import { bindPressHold } from "./pressHold";
import { providerGlyph } from "./providerGlyph";
import { RUN_STATE_DISPLAY } from "./sessionRows";

/** The state a row's mark shows: the desktop's own word for the agent while
 * the row's computer answers, otherwise what its lifecycle alone can say. A
 * computer that went quiet no longer vouches for cached work. */
function rowDisplayState(view: HomeRow): AgentDisplayState {
	const reported = view.row.source.reachable ? view.displayState : undefined;
	return reported ?? RUN_STATE_DISPLAY[view.row.state];
}

/** Reachable computer, session that cannot be attached: the rows the list gathers under "연결할 수 없음". */
export function isUnattachable(view: HomeRow): boolean {
	const row = view.row;
	return row.source.reachable && !row.source.session.ready;
}

export function renderHomeSessionRow(
	view: HomeRow,
	options: SpacesViewOptions,
	opening: boolean,
	now: number,
	actions: Pick<CensusActions, "open"> & Partial<Pick<CensusActions, "hold">>,
	current = false,
): HTMLElement {
	const row = view.row;
	const item = element("li", "list__item session-row");
	const open = element("button", "list__open session-row__open");
	open.type = "button";
	open.dataset.sessionId = row.sessionId;
	const state = rowDisplayState(view);
	const working = state === "working";
	const lead = element("span", "session-row__lead");
	// While this phone attaches, the loader answers the tap in the mark's
	// place. 12 in the 16px slot: the loader's orbit fills its box where a
	// glyph keeps an inset, so at 16 it read larger than the marks beside it
	// (2026-09-15 승연: "스피너 아이콘이 … 크기감이 커보여").
	lead.append(
		opening
			? loader(12)
			: providerGlyph(view.provider ?? row.source.session.provider_id),
	);
	// The state rides on the mark's corner, as on the desktop's glyph
	// (AgentActivityGlyph): the same table says which states do.
	if (AGENT_STATUS_MARK[state].onGlyph) {
		const badge = agentDot(state, statusLabel(state));
		badge.classList.add("session-row__badge");
		lead.append(badge);
	}
	open.append(lead);
	const body = element("span", "session-row__body");
	// The shared agent row's lines: the agents above this one over its title,
	// and what it manages under its details. A row with no relation has none.
	const path = view.agent?.path;
	if (path)
		body.append(element("span", "session-row__path", agentPathText(path)));
	body.append(element("span", "session-row__title", row.title));
	const metadata = element("span", "session-row__meta");
	// What the agent does next on its own leads the line whatever the visible
	// fields, as on the desktop's row.
	const continuesAtMs = view.agent?.continuesAtMs;
	if (continuesAtMs !== undefined)
		metadata.append(
			element("span", "session-row__field", continuesText(continuesAtMs, now)),
		);
	for (const field of visibleSpacesRowMetadata(
		view,
		options.visibleFields,
		{ groupBy: options.groupBy, spaceHeading: options.groupBy === "space", showSpaces: options.showSpaces },
	)) {
		// The desktop's info line (SpacesRows.tsx) is words joined by a middle
		// dot, no glyph before the branch; this row reads the same way
		// (2026-09-15 승연: "웹에서는 이런 구조라 모바일에서도 비슷하게").
		const part = element("span", "session-row__field");
		part.append(
			element(
				"span",
				"session-row__mono",
				field.field === "environment"
					? environmentLabel(field.value)
					: field.value,
			),
		);
		metadata.append(part);
	}
	if (options.visibleFields.includes("details") && view.detail)
		metadata.append(
			element("span", "session-row__field session-row__mono", view.detail),
		);
	// A session that cannot be attached carries its lifecycle word on the
	// metadata line, as the desktop's row carries its state on the glyph — not
	// a sentence. The list gathers such rows under one heading that says why
	// (2026-09-15 승연, 안 3).
	if (!current && isUnattachable(view))
		metadata.append(
			element("span", "session-row__field session-row__mono", row.source.session.lifecycle),
		);
	if (metadata.childElementCount) body.append(metadata);
	const managed = view.agent?.managed;
	if (managed)
		body.append(element("span", "session-row__managed", managedText(managed)));
	if (body.childElementCount === 1) item.classList.add("session-row--single");
	if (current) {
		open.disabled = true;
		open.setAttribute("aria-current", "true");
		// The row itself says it is the one open, the way the selected tab does;
		// a word in the stats column pushed the numbers about (2026-09-15 승연).
		item.classList.add("session-row--current");
	} else if (!row.source.reachable) open.disabled = true;
	else if (!row.source.session.ready) {
		open.disabled = true;
		item.classList.add("session-row--unattachable");
	} else open.addEventListener("click", () => actions.open(row.source));
	open.append(body);
	const stats = element("span", "session-row__stats");
	const git = element("span", "session-row__git");
	if (options.visibleFields.includes("gitStatus") && view.git) {
		const dirty = view.git.worktree;
		if (view.git.committed)
			git.append(
				element("span", "session-row__committed", `C${view.git.committed}`),
			);
		if (dirty) git.append(element("span", "session-row__dirty", `W${dirty}`));
		if (view.git.ahead)
			git.append(element("span", undefined, `↑${view.git.ahead}`));
		if (view.git.behind)
			git.append(element("span", undefined, `↓${view.git.behind}`));
	}
	if (git.childElementCount) stats.append(git);
	// The desktop hides the age while the agent is working — the breathing
	// mark in the lead says "now" — and shows it once the session is waiting.
	if (
		options.visibleFields.includes("updated") &&
		view.activityAt !== undefined &&
		!working
	)
		stats.append(
			element(
				"span",
				"session-row__updated",
				relativeTime(view.activityAt, now),
			),
		);
	if (stats.childElementCount) open.append(stats);
	const hold = actions.hold;
	if (row.source.reachable && hold)
		bindPressHold(open, { hold: (rect) => hold(row, rect) });
	item.append(open);
	return item;
}
