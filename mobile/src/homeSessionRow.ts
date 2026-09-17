import { visibleSpacesRowMetadata } from "@/lib/spaces/spacesViewProjection";
import type { SpacesViewOptions } from "@/lib/spaces/spacesViewOptions";
import { element, loader } from "./dom";
import type { CensusActions } from "./censusView";
import type { HomeRow } from "./homeProjection";
import { environmentLabel } from "./homeViewLabels";
import { relativeTime } from "./relativeTime";
import { bindPressHold } from "./pressHold";
import { t } from "./i18n";
import { providerGlyph } from "./providerGlyph";

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
	const lead = element(
		"span",
		`session-row__lead session-row__lead--${row.state}`,
	);
	const working = row.source.reachable && view.displayState === "working";
	if (opening || working) {
		// 12 in the 16px slot: the loader's orbit fills its box where a glyph keeps
		// an inset, so at 16 it read larger than the marks beside it (2026-09-15
		// 승연: "스피너 아이콘이 … 크기감이 커보여").
		const spinner = loader(12);
		if (!opening) spinner.setAttribute("aria-label", t("common.working"));
		lead.append(spinner);
	} else
		lead.append(providerGlyph(view.provider ?? row.source.session.provider_id));
	open.append(lead);
	const body = element("span", "session-row__body");
	body.append(element("span", "session-row__title", row.title));
	const metadata = element("span", "session-row__meta");
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
	else item.classList.add("session-row--single");
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
	// The desktop hides the age while the agent is working — the loader in
	// the lead says "now" — and shows it once the session is waiting.
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
