/**
 * "새 에이전트" — 폰에서 노트북에게 하나 띄워 달라고 하는 화면.
 * Figma `dure-UI` 3172:81560, 폴더 목록 편 상태는 3177:82234.
 *
 * 그리기만 한다. 무엇을 고를 수 있는지, 왜 못 고르는지, 지금 누를 수 있는지는
 * 전부 [`launch`] 의 순수 함수가 정한다.
 *
 * # 왜 시트가 아니라 화면인가
 *
 * 시안이 뒤로 가기와 제목을 가진 한 장짜리 화면으로 그린다. 고를 것이 넷이고
 * (스페이스·폴더·에이전트·worktree) 그중 둘은 목록을 다시 펼치므로, 목록 위에
 * 뜬 시트 안에 또 목록을 겹치면 사람이 지금 어느 목록을 보고 있는지 잃는다.
 *
 * # 왜 결과가 이 화면에 남는가
 *
 * 띄우는 데는 노트북이 워크트리를 만들고 세션을 붙이는 시간이 든다. 누르자마자
 * 목록으로 돌아가면 아무것도 안 나타났을 때 그것이 실패인지 아직인지 알 수
 * 없다. 화면은 답이 올 때까지 서 있는다.
 */

import iconChevronDown from "./assets/icon-chevron-down.svg";
import iconChevronLeft from "./assets/icon-chevron-left.svg";
import iconClaudeCode from "./assets/icon-claude-code.svg";
import iconFolderPlus from "./assets/icon-folder-plus.svg";
import { element, glyph } from "./dom";
import { t } from "./i18n";
import type {
	LaunchOffer,
	LaunchOfferKind,
	LaunchOfferTarget,
	StartAgentOutcome,
} from "./ipc";
import {
	canStart,
	canSelectKind,
	emptyOfferMessage,
	foldersOf,
	kindGlyphKind,
	type LaunchForm,
	spacesOf,
	targetOf,
} from "./launch";

/** 화면이 지금 무엇을 들고 있는가. */
export type LaunchStage =
	| { readonly kind: "loading" }
	| { readonly kind: "failed"; readonly message: string }
	| { readonly kind: "ready"; readonly offer: LaunchOffer }
	/** 보냈고 답을 기다린다. 고른 것은 그대로 그려 둔다. */
	| { readonly kind: "starting"; readonly offer: LaunchOffer }
	| {
			readonly kind: "done";
			readonly offer: LaunchOffer;
			readonly outcome: StartAgentOutcome;
	  };

/** 지금 펼쳐 둔 목록. 한 번에 하나만 펼친다. */
export type LaunchMenu = "space" | "folder" | undefined;

export interface LaunchModel {
	readonly stage: LaunchStage;
	readonly form: LaunchForm;
	readonly menu: LaunchMenu;
	/** 짝지은 그 컴퓨터의 이름. 자리가 기계를 말하지 않을 때 여기 이름이 선다. */
	readonly boxLabel: string;
}

export interface LaunchActions {
	readonly close: () => void;
	/** 목록을 펼치거나 접는다. 같은 것을 다시 누르면 접힌다. */
	readonly openMenu: (menu: LaunchMenu) => void;
	readonly selectSpace: (spaceLabel: string) => void;
	readonly selectFolder: (targetId: string) => void;
	readonly selectKind: (kindId: string) => void;
	readonly toggleWorktree: (on: boolean) => void;
	readonly editBranch: (branch: string) => void;
	/** Open the folder browser for locations outside the published offer. */
	readonly addFolder: () => void;
	readonly start: () => void;
	/** 마지막 답을 지우고 다시 고르게 한다. */
	readonly again: () => void;
	/** 방금 뜬 에이전트를 연다. 세션 id 가 온 경우에만 그린다. */
	readonly open: (sessionId: string) => void;
}

/** 자리가 말하는 기계. 비어 있으면 짝지은 그 컴퓨터라는 뜻이다. */
function machineOf(target: LaunchOfferTarget, boxLabel: string): string {
	return target.box_label || boxLabel;
}

/** 폴더 한 줄의 둘째 줄 — 어느 기계의 어느 경로인가. */
function folderMeta(target: LaunchOfferTarget, boxLabel: string): string {
	return `${machineOf(target, boxLabel)} · ${target.path_hint}`;
}

/** 라벨 + 누르면 목록이 펼쳐지는 줄. 시안의 `field-row-nested`. */
function field(
	label: string,
	body: HTMLElement,
	onOpen: () => void,
	enabled: boolean,
): HTMLElement {
	const wrap = element("div", "launch-field");
	wrap.append(element("span", "launch-field__label", label));
	const row = element("button", "launch-field__row");
	row.type = "button";
	row.disabled = !enabled;
	row.append(body);
	row.append(glyph(iconChevronDown, 16, "launch-field__chevron"));
	row.addEventListener("click", onOpen);
	wrap.append(row);
	return wrap;
}

function spaceMenu(
	offer: LaunchOffer,
	model: LaunchModel,
	actions: LaunchActions,
): HTMLElement {
	const menu = element("div", "launch-menu");
	const list = element("div", "launch-menu__list");
	for (const space of spacesOf(offer)) {
		const item = element("button", "launch-menu__item");
		item.type = "button";
		item.setAttribute("aria-pressed", String(space === model.form.spaceLabel));
		item.append(element("span", "launch-menu__name", space));
		item.addEventListener("click", () => actions.selectSpace(space));
		list.append(item);
	}
	menu.append(list);
	return menu;
}

function folderMenu(
	offer: LaunchOffer,
	model: LaunchModel,
	actions: LaunchActions,
): HTMLElement {
	const menu = element("div", "launch-menu");
	const list = element("div", "launch-menu__list");
	for (const target of foldersOf(offer, model.form.spaceLabel)) {
		const item = element("button", "launch-menu__item");
		item.type = "button";
		// Keep unavailable targets visible so absence and refusal stay distinct.
		item.disabled = !target.startable;
		if (!target.startable) item.classList.add("launch-menu__item--off");
		item.setAttribute(
			"aria-pressed",
			String(target.id === model.form.targetId),
		);
		item.append(element("span", "launch-menu__name", target.folder_label));
		item.append(
			element("span", "launch-menu__meta", folderMeta(target, model.boxLabel)),
		);
		item.addEventListener("click", () => actions.selectFolder(target.id));
		list.append(item);
	}
	menu.append(list);
	menu.append(element("div", "launch-menu__hairline"));
	const add = element("button", "launch-menu__add");
	add.type = "button";
	add.append(glyph(iconFolderPlus, 16));
	add.append(element("span", undefined, t("다른 폴더 열기...")));
	add.addEventListener("click", actions.addFolder);
	menu.append(add);
	return menu;
}

function kindChip(
	kind: LaunchOfferKind,
	model: LaunchModel,
	actions: LaunchActions,
	enabled: boolean,
	target: LaunchOfferTarget | undefined,
): HTMLElement {
	const chip = element("button", "launch-chip");
	chip.type = "button";
	const selectable = canSelectKind(kind, target);
	chip.disabled = !selectable || !enabled;
	const on = kind.id === model.form.kindId;
	if (on) chip.classList.add("launch-chip--on");
	if (!selectable) {
		chip.classList.add("launch-chip--off");
		chip.setAttribute("aria-disabled", "true");
	}
	chip.setAttribute("aria-pressed", String(on));
	// 시안은 칩마다 아이콘을 그린다. 이 앱이 진짜로 가진 표식은 Claude 것뿐이라,
	// 나머지는 세션 줄과 같은 규칙으로 제공자 색 점을 쓴다 — 없는 로고를 지어
	// 그리면 칩이 다른 에이전트의 이름을 말하게 된다.
	if (kindGlyphKind(kind) === "claude") {
		chip.append(glyph(iconClaudeCode, 16, "launch-chip__glyph"));
	} else {
		const dot = element(
			"span",
			`launch-chip__dot launch-chip__dot--${kind.id}`,
		);
		dot.setAttribute("aria-hidden", "true");
		chip.append(dot);
	}
	chip.append(element("span", "launch-chip__label", kind.label));
	chip.addEventListener("click", () => actions.selectKind(kind.id));
	return chip;
}

function worktreeSection(
	model: LaunchModel,
	actions: LaunchActions,
	enabled: boolean,
	supported: boolean,
	/**
	 * 한 글자 칠 때마다 시작 버튼을 다시 판정하게 한다.
	 *
	 * 브랜치 이름은 시작 가능 여부를 정하는데(`canStart`), 그 판정은 화면을
	 * 다시 그릴 때 내려진다. 이 칸은 다시 그리지 않으므로 — 다시 그리면 폰의
	 * 키보드가 닫힌다 — 판정만 따로 갱신한다.
	 */
	syncStart: (branch: string) => void,
): HTMLElement {
	const section = element("div", "launch-worktree");
	const row = element("div", "launch-worktree__row");
	const text = element("div", "launch-worktree__text");
	text.append(
		element("span", "launch-worktree__title", t("새 worktree에서 시작")),
	);
	text.append(
		element(
			"span",
			"launch-worktree__hint",
			supported
				? t("메인 브랜치를 건드리지 않습니다")
				: t(model.form.useWorktree
					? "launch.worktree.unsupported"
					: "launch.worktree.originalFolder"),
		),
	);
	row.append(text);

	const toggle = element("button", "launch-switch");
	toggle.type = "button";
	toggle.role = "switch";
	toggle.disabled = !enabled || (!supported && !model.form.useWorktree);
	toggle.setAttribute("aria-checked", String(model.form.useWorktree));
	toggle.setAttribute("aria-label", t("새 worktree에서 시작"));
	if (model.form.useWorktree) toggle.classList.add("launch-switch--on");
	toggle.append(element("span", "launch-switch__knob"));
	toggle.addEventListener("click", () =>
		actions.toggleWorktree(!model.form.useWorktree),
	);
	row.append(toggle);
	section.append(row);

	// 끈 상태에서 브랜치 칸을 남겨 두면, 쓰지 않을 값을 고치게 된다.
	if (model.form.useWorktree && supported) {
		const input = element("input", "launch-branch") as HTMLInputElement;
		input.type = "text";
		input.value = model.form.branch;
		input.disabled = !enabled;
		input.spellcheck = false;
		input.autocapitalize = "none";
		input.setAttribute("aria-label", t("브랜치 이름"));
		input.addEventListener("input", () => {
			actions.editBranch(input.value);
			syncStart(input.value);
		});
		section.append(input);
	}
	return section;
}

/**
 * 답 하나.
 *
 * 성공에도 세션 id 가 없을 수 있다 — 제공자에 따라 나중에 생긴다. 그때는 열기를
 * 그리지 않고 목록에 나타난다고만 말한다. 아무 데도 안 가는 열기 버튼보다 낫다.
 */
function outcomeBlock(
	outcome: StartAgentOutcome,
	actions: LaunchActions,
): HTMLElement {
	const block = element(
		"div",
		`launch-outcome launch-outcome--${outcome.started ? "ok" : "no"}`,
	);
	block.setAttribute("role", "status");
	if (!outcome.started) {
		block.append(
			element(
				"p",
				"launch-outcome__text",
				outcome.detail ?? t("띄우지 못했습니다"),
			),
		);
		const retry = element("button", "pair-button", t("다시 고르기"));
		retry.type = "button";
		retry.addEventListener("click", actions.again);
		block.append(retry);
		return block;
	}
	block.append(
		element("p", "launch-outcome__text", t("에이전트를 띄웠습니다")),
	);
	if (outcome.session_id) {
		const open = element("button", "pair-button pair-button--solid", t("열기"));
		open.type = "button";
		const sessionId = outcome.session_id;
		open.addEventListener("click", () => actions.open(sessionId));
		block.append(open);
		return block;
	}
	block.append(element("p", "launch-outcome__hint", t("곧 목록에 나타납니다")));
	return block;
}

export function renderLaunchScreen(
	model: LaunchModel,
	actions: LaunchActions,
): HTMLElement {
	// No `screen` class: its blanket 16px padding stacked on top of
	// `.launch__bar`'s and `.launch__body`'s own 16, so every gutter on this
	// screen was 32 while the rest of the app ran at 16.
	const screen = element("div", "launch");

	const bar = element("header", "launch__bar");
	const back = element("button", "icon-tap");
	back.type = "button";
	back.setAttribute("aria-label", t("뒤로"));
	back.append(glyph(iconChevronLeft, 20));
	back.addEventListener("click", actions.close);
	bar.append(back);
	bar.append(element("h1", "launch__title", t("새 에이전트")));
	screen.append(bar);

	const body = element("div", "launch__body");
	screen.append(body);

	if (model.stage.kind === "loading") {
		body.append(element("p", "launch__empty", t("고를 수 있는 것을 읽는 중…")));
		return screen;
	}
	if (model.stage.kind === "failed") {
		body.append(element("p", "launch__empty", model.stage.message));
		return screen;
	}

	const offer = model.stage.offer;
	const settled = model.stage.kind === "done";
	const enabled = model.stage.kind === "ready";

	const empty = emptyOfferMessage(offer);
	if (empty) {
		body.append(element("p", "launch__empty", t(empty)));
		return screen;
	}

	const spaceField = field(
		t("스페이스"),
		element(
			"span",
			"launch-field__value",
			model.form.spaceLabel ?? t("고르세요"),
		),
		() => actions.openMenu(model.menu === "space" ? undefined : "space"),
		enabled,
	);
	if (model.menu === "space") spaceField.append(spaceMenu(offer, model, actions));
	body.append(spaceField);

	const chosen = targetOf(offer, model.form);
	const folderBody = element("span", "launch-field__folder");
	folderBody.append(
		element(
			"span",
			"launch-field__value",
			model.form.folderLabel ?? chosen?.folder_label ?? t("고르세요"),
		),
	);
	if (model.form.folderPath) {
		folderBody.append(
			element(
				"span",
				"launch-field__meta",
				`${model.boxLabel} · ${model.form.folderHint ?? model.form.folderPath}`,
			),
		);
	} else if (chosen) {
		folderBody.append(
			element("span", "launch-field__meta", folderMeta(chosen, model.boxLabel)),
		);
	}
	const folderField = field(
		t("폴더"),
		folderBody,
		() => actions.openMenu(model.menu === "folder" ? undefined : "folder"),
		enabled,
	);
	if (model.menu === "folder") folderField.append(folderMenu(offer, model, actions));
	body.append(folderField);

	const kinds = element("div", "launch-field");
	kinds.append(element("span", "launch-field__label", t("에이전트")));
	const chips = element("div", "launch-chips");
	for (const kind of offer.kinds)
		chips.append(kindChip(kind, model, actions, enabled, chosen));
	kinds.append(chips);
	const missing = offer.kinds.filter((kind) => !kind.installed);
	if (chosen?.provider_installation === "check_on_start") {
		kinds.append(
			element("p", "launch__why", t("launch.provider.checkOnStart", {
				host: machineOf(chosen, model.boxLabel),
			})),
		);
	} else if (missing.length > 0) {
		// 폰에는 hover 가 없다. 이유를 title 에만 적으면 어떤 손짓으로도 읽히지
		// 않고, 흐린 칩만 남아 사람은 앱이 멈춘 줄 안다.
		kinds.append(
			element(
				"p",
				"launch__why",
				missing.length === offer.kinds.length
					? t("이 컴퓨터에는 띄울 수 있는 에이전트가 없습니다")
					: t("흐린 것은 이 컴퓨터에 설치되어 있지 않습니다"),
			),
		);
	}
	body.append(kinds);

	// 시작 버튼은 아래에서 만들어지므로, 브랜치 칸은 이 홀더를 통해 그것에
	// 닿는다. 순서를 뒤집어 버튼을 먼저 만들면 DOM 순서가 시안과 어긋난다.
	let syncStart: (branch: string) => void = () => {};
	body.append(
		worktreeSection(
			model, actions, enabled, chosen?.worktree_supported !== false,
			(branch) => syncStart(branch),
		),
	);

	const footer = element("div", "launch__footer");
	if (settled && model.stage.kind === "done") {
		footer.append(outcomeBlock(model.stage.outcome, actions));
	} else {
		const busy = model.stage.kind === "starting";
		const start = element(
			"button",
			"launch__start",
			busy ? t("띄우는 중…") : t("에이전트 시작"),
		);
		start.type = "button";
		start.disabled = busy || !canStart(offer, model.form);
		syncStart = (branch) => {
			start.disabled = busy || !canStart(offer, { ...model.form, branch });
		};
		start.addEventListener("click", actions.start);
		footer.append(start);
	}
	screen.append(footer);
	return screen;
}
