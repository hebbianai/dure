import {
	EMPTY_SPACES_FILTERS,
	hasActiveSpacesFilters,
	spacesFieldsStatedBy,
	toggleSpacesFilter,
	toggleSpacesVisibleField,
	type SpacesFilterFacet,
	type SpacesGrouping,
	type SpacesOrdering,
	type SpacesViewOptions,
	type SpacesShowItem,
} from "@/lib/spaces/spacesViewOptions";
import type { SpacesFilterChoices } from "@/lib/spaces/spacesViewProjection";
import { element, glyph, sheetShell } from "./dom";
import iconCheck from "./assets/icon-check.svg";
import iconChevronDown from "./assets/icon-chevron-down.svg";
import { environmentLabel, sourceLabel, statusLabel } from "./homeViewLabels";
import { t } from "./i18n";

/**
 * The sheet is the row list it always was — each axis a row with its value
 * summarised on the right — and a row opens a menu card under itself rather
 * than a second screen (2026-09-15 승연: "드롭다운 시안대로 바꿔"). The card is
 * the design system's menu (`menuSurface.ts`): glass/menu at 75% under a 15px
 * blur, the menu hairline, radius 10, 4px padding, shadow-menu, with the DS
 * item anatomy — 13px text, the check or dot at the right — on 44px rows for a
 * thumb. 그룹 and 정렬 close on a choice; 표시 and the filters stay open while
 * several are toggled and close on the scrim.
 *
 * The filters' reset is the sheet's last row, under its own hairline, not a
 * control beside the 필터 heading: there it read as the heading's value, as a
 * word and then as a glyph (2026-09-15 승연: "초기화 버튼 애매하니까 … 맨 아래에
 * 초기화 버튼을 두자").
 *
 * The section is the open card, or "root" for none: `app.ts` keeps it as
 * `homeMenu`, and the back gesture closes the card before the sheet.
 */
export type HomeMenuSection =
	| "root"
	| "grouping"
	| "ordering"
	| "show"
	| SpacesFilterFacet;
const GROUPS: readonly [SpacesGrouping, string][] = [
	["space", "common.space"],
	["repository", "spaces.pane.groupByRepository"],
	["location", "spaces.pane.location"],
	["environment", "spaces.pane.environment"],
	["updated", "spaces.pane.updated"],
	["status", "spaces.pane.status"],
];
const ORDERS: readonly [SpacesOrdering, string][] = [
	["stable", "spaces.pane.orderByPane"],
	["updated", "spaces.pane.updated"],
	["status", "spaces.pane.status"],
];
const FIELDS: readonly [SpacesShowItem, string][] = [
	["updated", "spaces.pane.updated"],
	["environment", "spaces.pane.environment"],
	["space", "common.space"],
	["branch", "spaces.pane.branch"],
	["machine", "spaces.pane.machine"],
	["details", "spaces.pane.details"],
	["gitStatus", "spaces.pane.gitStatus"],
];
const FILTERS: readonly [SpacesFilterFacet, string][] = [
	["status", "spaces.pane.status"],
	["environment", "spaces.pane.environment"],
	["repository", "spaces.pane.groupByRepository"],
	["location", "spaces.pane.location"],
	["source", "spaces.pane.source"],
];

/** One row of the card. */
interface Item {
	readonly label: string;
	readonly on: boolean;
	readonly run: () => void;
}

/** One row of the sheet, and the card it opens. */
interface Axis {
	readonly id: Exclude<HomeMenuSection, "root">;
	readonly label: string;
	/** What is on, for the row's right side; empty when nothing is. */
	readonly summary: string;
	/** One item is on at a time, and choosing one closes the card. */
	readonly radio: boolean;
	readonly items: readonly Item[];
}

/** The gap between a row and its card, and the card's margin to the panel. */
const CARD_GAP = 4;
const CARD_MARGIN = 8;

/**
 * Where a card stands for its row, in the panel's own coordinates.
 *
 * Under the row when that keeps the card inside the panel's visible window;
 * above it when only that does; and when neither side has room for the whole
 * card, on the roomier side, capped to that room so the card scrolls inside
 * itself — the desktop's own answer to a long menu. Judged against the window
 * the panel shows, not its scroll height: an overflowing card grows the scroll
 * height, so a card placed under its row on a first pass would always be found
 * to fit on the second (2026-09-15 승연: "하단으로 스크롤이 안돼").
 */
export function placeMenuCard(geometry: {
	readonly rowTop: number;
	readonly rowHeight: number;
	readonly cardHeight: number;
	readonly viewTop: number;
	readonly viewHeight: number;
}): { readonly top: number; readonly above: boolean; readonly maxHeight?: number } {
	const under = geometry.rowTop + geometry.rowHeight + CARD_GAP;
	const roomUnder = geometry.viewTop + geometry.viewHeight - CARD_MARGIN - under;
	const roomOver = geometry.rowTop - CARD_GAP - CARD_MARGIN - geometry.viewTop;
	if (geometry.cardHeight <= roomUnder) return { top: under, above: false };
	if (geometry.cardHeight <= roomOver)
		return { top: geometry.rowTop - CARD_GAP - geometry.cardHeight, above: true };
	if (roomUnder >= roomOver) return { top: under, above: false, maxHeight: Math.max(roomUnder, 0) };
	return { top: geometry.rowTop - CARD_GAP - roomOver, above: true, maxHeight: roomOver };
}

export function renderHomeViewMenu(
	value: SpacesViewOptions,
	section: HomeMenuSection,
	choices: SpacesFilterChoices,
	actions: {
		change(value: SpacesViewOptions): void;
		navigate(section: HomeMenuSection | undefined): void;
	},
): HTMLElement {
	const { host, panel } = sheetShell(
		t("spaces.pane.viewOptions"),
		() => actions.navigate(undefined),
		"sheet--tray home-menu",
	);
	host.setAttribute("role", "dialog");
	host.setAttribute("aria-modal", "true");
	host.setAttribute("aria-label", t("spaces.pane.viewOptions"));

	const axes = axesOf(value, choices, actions);
	const open = axes.find((axis) => axis.id === section);

	const list = element("div", "home-menu__list");
	const row = (axis: Axis): void => {
		const button = element("button", "home-menu__row");
		button.type = "button";
		button.dataset.row = axis.id;
		button.setAttribute("aria-haspopup", "menu");
		button.setAttribute("aria-expanded", String(axis === open));
		if (axis === open) button.classList.add("home-menu__row--open");
		button.append(element("span", "home-menu__label", axis.label));
		button.append(element("span", "home-menu__value", axis.summary));
		button.append(glyph(iconChevronDown, 16, "home-menu__chevron"));
		button.addEventListener("click", () =>
			actions.navigate(axis === open ? "root" : axis.id),
		);
		list.append(button);
	};
	for (const axis of axes.slice(0, 3)) row(axis);
	list.append(
		element("div", "home-menu__hairline"),
		element("div", "home-menu__filters", t("spaces.pane.filters")),
	);
	for (const axis of axes.slice(3)) row(axis);
	const reset = element(
		"button",
		"home-menu__row home-menu__reset",
		t("spaces.pane.resetFilters"),
	);
	reset.type = "button";
	reset.disabled = !hasActiveSpacesFilters(value.filters);
	reset.addEventListener("click", () =>
		actions.change({ ...value, filters: EMPTY_SPACES_FILTERS }),
	);
	list.append(element("div", "home-menu__hairline"), reset);
	panel.append(list);

	if (open) {
		const card = element("div", "home-menu__card");
		card.dataset.facet = open.id;
		card.setAttribute("role", "menu");
		card.setAttribute("aria-label", open.label);
		card.append(element("div", "home-menu__card-label", open.label));
		for (const item of open.items) {
			const button = element("button", "home-menu__item");
			button.type = "button";
			button.setAttribute("role", open.radio ? "menuitemradio" : "menuitemcheckbox");
			button.setAttribute("aria-checked", String(item.on));
			if (item.on) button.classList.add("home-menu__item--on");
			const indicator = element("span", "home-menu__indicator");
			if (item.on)
				indicator.append(
					open.radio ? element("span", "home-menu__radio-dot") : glyph(iconCheck, 12),
				);
			button.append(element("span", "home-menu__item-label", item.label), indicator);
			button.addEventListener("click", () => {
				item.run();
				// A choice from a radio card is the end of the errand; a toggle in a
				// checkbox card is one of several.
				if (open.radio) actions.navigate("root");
			});
			card.append(button);
		}
		// The card first and the scrim after it, so a stylesheet can fade the
		// scrim in with the card; the scrim still lies under it (z-index).
		const scrim = element("div", "home-menu__scrim");
		scrim.addEventListener("click", () => actions.navigate("root"));
		panel.append(card, scrim);

		/**
		 * Under its row, or above it when the panel's bottom is too near — the
		 * rule the long-press menu follows on the screen, here in the panel's own
		 * coordinates. Twice, because a detached card measures zero: once now,
		 * once a microtask later when the caller has put the sheet in the
		 * document and the card has a height.
		 */
		const anchor = list.querySelector<HTMLElement>(`[data-row="${open.id}"]`);
		const place = (): void => {
			if (!anchor) return;
			const placement = placeMenuCard({
				rowTop: anchor.offsetTop,
				rowHeight: anchor.offsetHeight,
				cardHeight: card.offsetHeight,
				viewTop: panel.scrollTop,
				viewHeight: panel.clientHeight,
			});
			card.style.top = `${placement.top}px`;
			card.classList.toggle("home-menu__card--above", placement.above);
			// Only a laid-out card knows its height; a detached one measures zero
			// and must not be capped to nothing.
			if (placement.maxHeight !== undefined && card.offsetHeight > 0)
				card.style.maxHeight = `${placement.maxHeight}px`;
			else card.style.removeProperty("max-height");
		};
		place();
		queueMicrotask(place);
	}

	host.addEventListener("keydown", (event) => {
		if (event.key === "Escape") {
			event.preventDefault();
			actions.navigate(open ? "root" : undefined);
			return;
		}
		// Arrows walk the open card, or the rows when none is open.
		if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
			const scope = open ? host.querySelector(".home-menu__card") : list;
			const items = [
				...(scope?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []),
			];
			if (!items.length) return;
			const current = items.indexOf(document.activeElement as HTMLButtonElement);
			const index =
				event.key === "Home"
					? 0
					: event.key === "End"
						? items.length - 1
						: (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) %
							items.length;
			event.preventDefault();
			items[index]?.focus();
			return;
		}
		if (event.key !== "Tab") return;
		const buttons = [
			...host.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
		];
		const target = event.shiftKey ? buttons[buttons.length - 1] : buttons[0];
		if (
			!host.contains(document.activeElement) ||
			document.activeElement ===
				(event.shiftKey ? buttons[0] : buttons[buttons.length - 1])
		) {
			event.preventDefault();
			target?.focus();
		}
	});
	return host;
}

/** The sheet's axes in row order: 그룹, 정렬, 표시, then the filters. */
function axesOf(
	value: SpacesViewOptions,
	choices: SpacesFilterChoices,
	actions: { change(value: SpacesViewOptions): void },
): Axis[] {
	const joined = (labels: readonly string[]): string => labels.join(" · ");
	const groups: Axis = {
		id: "grouping",
		label: t("spaces.pane.grouping"),
		summary: t(GROUPS.find(([key]) => key === value.groupBy)?.[1] ?? "common.space"),
		radio: true,
		items: GROUPS.map(([groupBy, key]) => ({
			label: t(key),
			on: value.groupBy === groupBy,
			run: () => actions.change({ ...value, groupBy }),
		})),
	};
	const orders: Axis = {
		id: "ordering",
		label: t("spaces.pane.ordering"),
		summary: t(
			ORDERS.find(([key]) => key === value.orderBy)?.[1] ?? "spaces.pane.orderByPane",
		),
		radio: true,
		items: ORDERS.map(([orderBy, key]) => ({
			label: t(key),
			on: value.orderBy === orderBy,
			run: () => actions.change({ ...value, orderBy }),
		})),
	};
	const stated = spacesFieldsStatedBy(value.groupBy);
	const fields = FIELDS.filter(([field]) => !stated.includes(field)).map(([field, key]) => ({
		label: t(key),
		on: field === "space" ? value.showSpaces : value.visibleFields.includes(field),
		run: () =>
			actions.change({
				...value,
				...(field === "space"
					? { showSpaces: !value.showSpaces }
					: {
							visibleFields: toggleSpacesVisibleField(
								value.visibleFields,
								field,
								!value.visibleFields.includes(field),
							),
						}),
			}),
	}));
	const show: Axis = {
		id: "show",
		label: t("spaces.pane.show"),
		summary: joined(fields.filter((item) => item.on).map((item) => item.label)),
		radio: false,
		items: fields,
	};
	const filters = FILTERS.map(([facet, key]): Axis => {
		const chosen = value.filters[facet] as readonly string[];
		const options =
			facet === "repository" || facet === "location"
				? choices[facet].map((choice) => ({
						value: choice.value,
						label:
							choice.label ??
							(choice.value === "unknown" ? t("common.unknown") : choice.value),
					}))
				: facet === "status"
					? choices.status.map((value) => ({ value, label: statusLabel(value) }))
					: facet === "environment"
						? choices.environment.map((value) => ({
								value,
								label: environmentLabel(value),
							}))
						: choices.source.map((value) => ({ value, label: sourceLabel(value) }));
		const items = options.map((option) => ({
			label: option.label,
			on: chosen.includes(option.value),
			run: () =>
				actions.change({
					...value,
					filters: toggleSpacesFilter(
						value.filters,
						facet,
						option.value,
						!chosen.includes(option.value),
					),
				}),
		}));
		return {
			id: facet,
			label: t(key),
			// A chosen value the census no longer offers still counts; it is shown
			// as itself so the filter that hides everything can be seen and undone.
			summary: joined(
				chosen.map((choice) => options.find((option) => option.value === choice)?.label ?? choice),
			),
			radio: false,
			items,
		};
	});
	return [groups, orders, show, ...filters];
}
