import type { SpacesViewOptions } from "@/lib/spaces/spacesViewOptions";
import type { UnifiedRow } from "./allSessions";
import { element, fadeWhileScrollable, groupHeading } from "./dom";
import type { HomeGroup } from "./homeProjection";
import { renderHomeSessionRow } from "./homeSessionRow";
import { t } from "./i18n";

export type SessionSibling = HomeGroup;

/** The switcher uses Home's row projection and display preferences. */
export function renderSessionSwitcher(
	groups: readonly SessionSibling[],
	options: SpacesViewOptions,
	currentId: string,
	opening: string | undefined,
	now: number,
	openSession: (row: UnifiedRow) => void,
): HTMLElement {
	const panel = element("div", "tray__panel tray__panel--sessions");
	if (!groups.length) {
		panel.append(
			element("p", "empty__hint", t("열 수 있는 다른 세션이 없습니다")),
		);
		return panel;
	}
	let selected =
		groups.find((group) =>
			group.rows.some((view) => view.row.sessionId === currentId),
		) ?? groups[0];
	const tabs = element("div", "tabs session-switcher__tabs");
	tabs.setAttribute("role", "tablist");
	const list = element("ul", "list session-switcher__list tray__panel-scroll");
	const draw = () => {
		for (const tab of tabs.querySelectorAll<HTMLButtonElement>("button")) {
			const active = tab.dataset.group === selected?.key;
			tab.classList.toggle("tab--on", active);
			tab.setAttribute("aria-selected", String(active));
		}
		list.replaceChildren();
		const pins = selected.rows.filter(view => view.pinned === true);
		const rows = selected.rows.filter(view => view.pinned !== true);
		if (pins.length) {
			const heading = element("li", "list__heading");
			heading.append(groupHeading(t("spaces.pane.pinned"), pins.length));
			list.append(heading);
		}
		const drawRows = (rows: SessionSibling["rows"]) => list.append(
			...rows.map((view) => renderHomeSessionRow(
					view,
					options,
					view.row.sessionId === opening,
					now,
					{ open: () => openSession(view.row) },
					view.row.sessionId === currentId,
				),
			),
		);
		drawRows(pins);
		if (pins.length && rows.length) {
			const heading = element("li", "list__heading");
			heading.append(groupHeading(selected.label, rows.length));
			list.append(heading);
		}
		drawRows(rows);
		list.scrollTop = 0;
	};
	for (const group of groups) {
		const tab = element("button", "tab", group.label);
		tab.type = "button";
		tab.dataset.group = group.key;
		tab.setAttribute("role", "tab");
		tab.addEventListener("click", () => {
			selected = group;
			draw();
		});
		tabs.append(tab);
	}
	panel.append(tabs, list);
	fadeWhileScrollable(list, { start: "scroll-fade--start", end: "scroll-fade--end" }, "y");
	draw();
	return panel;
}
