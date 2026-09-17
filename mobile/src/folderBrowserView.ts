/** Figma `dure-UI` 3369:35182, 3372:85638, 3372:85748. */

import iconCheck from "./assets/icon-check.svg";
import iconChevronDown from "./assets/icon-chevron-down.svg";
import iconChevronLeft from "./assets/icon-chevron-left.svg";
import iconChevronRight from "./assets/icon-chevron-right.svg";
import iconFolder from "./assets/icon-folder.svg";
import iconFolderPlus from "./assets/icon-folder-plus.svg";
import { element, glyph } from "./dom";
import {
	displayPath,
	folderName,
	pathRows,
	type FolderBrowserModel,
} from "./folderBrowser";
import { t } from "./i18n";

export interface FolderBrowserActions {
	readonly close: () => void;
	readonly toggleHost: () => void;
	readonly selectHost: (hubId: string) => void;
	readonly browse: (path?: string) => void;
	readonly choose: (path: string) => void;
	readonly openCreate: () => void;
	readonly editCreateName: (name: string) => void;
	readonly cancelCreate: () => void;
	readonly createFolder: () => void;
}

function treeRow(
	label: string,
	path: string,
	depth: number,
	selected: boolean,
	opened: boolean,
	actions: FolderBrowserActions,
): HTMLElement {
	const row = element("button", "folder-tree__row");
	row.type = "button";
	row.style.setProperty("--folder-indent", `${depth * 20}px`);
	row.setAttribute("aria-pressed", String(selected));
	row.append(
		glyph(
			opened ? iconChevronDown : iconChevronRight,
			16,
			"folder-tree__chevron",
		),
	);
	row.append(glyph(iconFolder, 16, "folder-tree__folder"));
	row.append(element("span", "folder-tree__name", label));
	if (selected) row.append(glyph(iconCheck, 16, "folder-tree__check"));
	row.addEventListener("click", () => actions.browse(path));
	return row;
}

function createDialog(
	model: FolderBrowserModel,
	actions: FolderBrowserActions,
): HTMLElement {
	const draft = model.create;
	const scrim = element("div", "folder-create__scrim");
	const dialog = element("div", "folder-create");
	dialog.setAttribute("role", "dialog");
	dialog.setAttribute("aria-modal", "true");
	dialog.setAttribute("aria-labelledby", "folder-create-title");
	dialog.setAttribute("aria-busy", String(draft?.busy ?? false));
	const title = element("h2", "folder-create__title", t("새 폴더"));
	title.id = "folder-create-title";
	dialog.append(title);
	const input = element("input", "folder-create__input") as HTMLInputElement;
	input.type = "text";
	input.value = draft?.name ?? "";
	input.placeholder = t("폴더 이름");
	input.disabled = draft?.busy ?? false;
	input.addEventListener("input", () => {
		actions.editCreateName(input.value);
		const button = dialog.querySelector<HTMLButtonElement>(
			".folder-create__button--primary",
		);
		if (button) button.disabled = !input.value.trim();
	});
	input.addEventListener("keydown", (event) => {
		if (event.key === "Enter" && input.value.trim() && !draft?.busy)
			actions.createFolder();
	});
	dialog.append(input);
	if (model.stage.kind === "ready") {
		const preview = element(
			"p",
			"folder-create__preview",
			t("{host} · {path} 안에 만들어짐", {
				host: model.boxLabel,
				path: displayPath(model.stage.rootPath, model.stage.path),
			}),
		);
		preview.id = "folder-create-preview";
		dialog.setAttribute("aria-describedby", preview.id);
		dialog.append(preview);
	}
	if (draft?.error) {
		const error = element("p", "folder-create__error", draft.error);
		error.setAttribute("role", "alert");
		dialog.append(error);
	}
	const actionsRow = element("div", "folder-create__actions");
	const cancel = element("button", "folder-create__button", t("취소"));
	cancel.type = "button";
	cancel.disabled = draft?.busy ?? false;
	cancel.addEventListener("click", actions.cancelCreate);
	const create = element(
		"button",
		"folder-create__button folder-create__button--primary",
		draft?.busy ? t("만드는 중…") : t("만들기"),
	);
	create.type = "button";
	create.disabled = !draft?.name.trim() || draft.busy;
	create.addEventListener("click", actions.createFolder);
	dialog.addEventListener("keydown", (event) => {
		if (draft?.busy) return;
		if (event.key === "Escape") {
			event.preventDefault();
			actions.cancelCreate();
			return;
		}
		if (event.key !== "Tab") return;
		if (event.shiftKey && document.activeElement === input) {
			event.preventDefault();
			(create.disabled ? cancel : create).focus();
		} else if (!event.shiftKey && document.activeElement === create) {
			event.preventDefault();
			input.focus();
		} else if (!event.shiftKey && document.activeElement === cancel && create.disabled) {
			event.preventDefault();
			input.focus();
		}
	});
	actionsRow.append(cancel, create);
	dialog.append(actionsRow);
	scrim.append(dialog);
	queueMicrotask(() => input.focus());
	return scrim;
}

export function renderFolderBrowserScreen(
	model: FolderBrowserModel,
	actions: FolderBrowserActions,
): HTMLElement {
	// No `screen` class — see `launchView`: its 16px padding doubled every
	// gutter on this screen against the app's own 16.
	const screen = element("div", "folder-browser");
	const bar = element("header", "folder-browser__bar");
	const back = element("button", "icon-tap");
	back.type = "button";
	back.setAttribute("aria-label", t("뒤로"));
	back.append(glyph(iconChevronLeft, 20));
	back.addEventListener("click", actions.close);
	bar.append(back, element("h1", "folder-browser__title", t("다른 폴더 열기")));
	screen.append(bar);

	const body = element("div", "folder-browser__body");
	const host = element("section", "folder-browser__field");
	host.append(element("span", "folder-browser__label", t("호스트")));
	const hostButton = element("button", "folder-browser__host");
	hostButton.type = "button";
	hostButton.setAttribute("aria-haspopup", "listbox");
	hostButton.setAttribute("aria-expanded", String(model.hostOpen));
	hostButton.append(element("span", undefined, model.boxLabel));
	hostButton.append(glyph(iconChevronDown, 16));
	hostButton.addEventListener("click", actions.toggleHost);
	host.append(hostButton);
	if (model.hostOpen) {
		const menu = element("div", "folder-browser__host-menu");
		menu.setAttribute("role", "listbox");
		for (const host of model.hosts) {
			const option = element("button", "folder-browser__host-option");
			option.type = "button";
			option.setAttribute("role", "option");
			option.setAttribute("aria-selected", String(host.id === model.hubId));
			option.append(element("span", undefined, host.label));
			if (host.id === model.hubId) option.append(glyph(iconCheck, 16));
			option.addEventListener("click", () => actions.selectHost(host.id));
			menu.append(option);
		}
		host.append(menu);
	}
	body.append(host);

	const folders = element("section", "folder-browser__folders");
	const heading = element("div", "folder-browser__heading");
	heading.append(element("span", "folder-browser__label", t("폴더")));
	const add = element("button", "folder-browser__add");
	add.type = "button";
	add.setAttribute("aria-label", t("새 폴더"));
	add.disabled = model.stage.kind !== "ready";
	add.append(glyph(iconFolderPlus, 18));
	add.addEventListener("click", actions.openCreate);
	heading.append(add);
	folders.append(heading);

	if (model.stage.kind === "loading") {
		folders.append(
			element("p", "folder-browser__status", t("폴더를 읽는 중…")),
		);
	} else if (model.stage.kind === "failed") {
		const error = element("p", "folder-browser__status", model.stage.message);
		error.setAttribute("role", "alert");
		folders.append(error);
	} else {
		const tree = element("div", "folder-tree");
		const ancestors = pathRows(model.stage.rootPath, model.stage.path);
		for (const row of ancestors) {
			tree.append(
				treeRow(row.label, row.path, row.depth, row.selected, true, actions),
			);
		}
		const depth = ancestors.length;
		for (const entry of model.stage.entries) {
			tree.append(
				treeRow(entry.name, entry.path, depth, false, false, actions),
			);
		}
		folders.append(tree);
	}
	body.append(folders);
	screen.append(body);

	const footer = element("footer", "folder-browser__footer");
	const choose = element("button", "folder-browser__choose");
	choose.type = "button";
	choose.disabled = model.stage.kind !== "ready" || Boolean(model.create);
	choose.textContent =
		model.stage.kind === "ready"
			? t("{folder} 폴더에서 시작", { folder: folderName(model.stage.path) })
			: t("폴더에서 시작");
	if (model.stage.kind === "ready") {
		const path = model.stage.path;
		choose.addEventListener("click", () => actions.choose(path));
	}
	footer.append(choose);
	screen.append(footer);
	if (model.create) screen.append(createDialog(model, actions));
	return screen;
}
