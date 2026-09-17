import iconCheck from "./assets/icon-check.svg";
import iconChevronLeft from "./assets/icon-chevron-left.svg";
import { element, glyph } from "./dom";
import { t } from "./i18n";
import "./settingsChoiceView.css";

export interface SettingsChoiceOption<T> {
	readonly value: T;
	readonly label: string;
	readonly detail?: string;
	readonly selected: boolean;
}

export interface SettingsChoiceScreen<T> {
	readonly title: string;
	readonly options: readonly SettingsChoiceOption<T>[];
	readonly note?: string;
	readonly back: () => void;
	/**
	 * `viaKeyboard` is true when an arrow key chose the row. An owner that
	 * redraws its tree on select loses the row this view focused, so the owner
	 * receiving `viaKeyboard === true` is the one that lands focus on the newly
	 * checked row of the new tree — this view never focuses on its own.
	 */
	readonly select: (value: T, viaKeyboard: boolean) => void;
}

export function renderSettingsChoiceScreen<T>(
	model: SettingsChoiceScreen<T>,
): HTMLElement {
	const screen = element("section", "pair-screen settings-choice");
	const bar = element("header", "pair-bar settings-choice__bar");
	const back = element("button", "icon-tap");
	back.type = "button";
	back.setAttribute("aria-label", t("뒤로"));
	back.append(glyph(iconChevronLeft, 20));
	back.addEventListener("click", model.back);
	bar.append(back, element("h1", "pair-bar__title", t(model.title)));
	screen.append(bar);

	const body = element("div", "settings-choice__body");
	const group = element("div", "settings-choice__card");
	group.setAttribute("role", "radiogroup");
	group.setAttribute("aria-label", t(model.title));

	const selectedIndex = model.options.findIndex((option) => option.selected);
	const rows = model.options.map((option, index) => {
		const row = element(
			"button",
			option.detail
				? "settings-choice__row settings-choice__row--detailed"
				: "settings-choice__row",
		);
		row.type = "button";
		row.setAttribute("role", "radio");
		row.setAttribute("aria-checked", String(option.selected));
		row.tabIndex =
			option.selected || (selectedIndex < 0 && index === 0) ? 0 : -1;

		const copy = element("span", "settings-choice__copy");
		copy.append(element("span", "settings-choice__label", t(option.label)));
		if (option.detail)
			copy.append(element("span", "settings-choice__detail", t(option.detail)));
		row.append(copy, glyph(iconCheck, 12, "settings-choice__check"));
		group.append(row);
		return row;
	});

	const choose = (index: number, focus: boolean): void => {
		rows.forEach((row, rowIndex) => {
			const selected = rowIndex === index;
			row.setAttribute("aria-checked", String(selected));
			row.tabIndex = selected ? 0 : -1;
		});
		const option = model.options[index];
		if (option) model.select(option.value, focus);
	};

	rows.forEach((row, index) => {
		row.addEventListener("click", () => choose(index, false));
		row.addEventListener("keydown", (event) => {
			let next: number | undefined;
			if (event.key === "ArrowDown" || event.key === "ArrowRight")
				next = (index + 1) % rows.length;
			if (event.key === "ArrowUp" || event.key === "ArrowLeft")
				next = (index - 1 + rows.length) % rows.length;
			if (event.key === "Home") next = 0;
			if (event.key === "End") next = rows.length - 1;
			if (next === undefined) return;
			event.preventDefault();
			choose(next, true);
		});
	});

	body.append(group);
	if (model.note)
		body.append(element("p", "settings-choice__note", t(model.note)));
	screen.append(body);
	return screen;
}
