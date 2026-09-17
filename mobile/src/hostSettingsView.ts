import iconChevronLeft from "./assets/icon-chevron-left.svg";
import iconChevronRight from "./assets/icon-chevron-right.svg";
import iconKey from "./assets/icon-key.svg";
import iconPlus from "./assets/icon-plus.svg";
import iconRefresh from "./assets/icon-refresh-cw.svg";
import iconTrash from "./assets/icon-trash.svg";
import { element, fadeWhileScrollable, glyph } from "./dom";
import { t } from "./i18n";
import type { ServerDraft } from "./servers";
import "./hostSettingsView.css";

export interface HostSettingsItem {
	readonly id: string;
	readonly label: string;
	readonly endpoint: string;
	readonly disconnected: boolean;
}

export interface HostSettingsListModel {
	readonly hosts: readonly HostSettingsItem[];
}

export interface HostSettingsListActions {
	readonly back: () => void;
	readonly open: (id: string) => void;
	readonly add: () => void;
}

/**
 * `unpinned`: the row carries no host key fingerprint, so the relay refuses to
 * dial it at all. Only a hand-edited store produces one — the phone always
 * learns the pin when it adds a host — and the fix is 제거 → 추가, which
 * learns it again. No retry button: nothing about waiting changes it.
 */
export type HostConnectionStatus =
	| "connected"
	| "retrying"
	| "checking"
	| "unpinned";

export interface HostSettingsDetailModel {
	readonly draft: ServerDraft;
	readonly status: HostConnectionStatus;
	readonly checkedAt?: number;
	/** 세션 생성이 도는 중. 버튼이 두 번 눌리면 상자에 유령 세션이 하나 더 뜬다. */
	readonly starting?: boolean;
}

export interface HostSettingsDetailActions {
	readonly back: () => void;
	readonly save: (draft: ServerDraft) => void;
	readonly remove: () => void;
	readonly retry: () => void;
	/**
	 * 이 상자에서 세션 하나를 시작한다 — 노트북 없이.
	 *
	 * 등록된 상자에만 있다: 아직 저장되지 않은 폼에는 시작할 서버가 없다.
	 */
	readonly startSession: () => void;
	/**
	 * This host's keys — the public half the host must trust, and the private
	 * slots this phone holds for it.
	 */
	readonly openKeys: () => void;
}

export interface ComputerListItem {
	readonly id: string;
	readonly label: string;
	readonly endpoint: string;
	/** Korean source sentence from `hubReach`; the view translates. */
	readonly reach: string;
}

export interface ComputerListModel {
	readonly computers: readonly ComputerListItem[];
}

export interface ComputerListActions {
	readonly back: () => void;
	readonly forget: (id: string) => void;
	/** 컴퓨터 연결 — the scanner. */
	readonly pair: () => void;
}

const STATUS_TEXT: Record<
	Exclude<HostConnectionStatus, "connected">,
	string
> = {
	retrying: "연결할 수 없음 · 자동 재시도 중",
	checking: "확인 중",
	unpinned: "호스트 키 지문이 없어 연결할 수 없습니다",
};

function connectedStatus(checkedAt: number | undefined): string {
	if (checkedAt === undefined) return t("연결됨");
	const minutes = Math.floor((Date.now() - checkedAt) / 60_000);
	return minutes < 1
		? t("연결됨 · 방금 확인")
		: t("연결됨 · {minutes}분 전 확인", { minutes });
}

/**
 * The bar every screen under 설정 › 연결 shares: back, a title, and at most
 * one trailing control. `title` is the Korean source; the bar translates.
 */
export function renderHostSettingsHeader(
	backAction: () => void,
	trailing?: Node,
	title = "호스트",
): HTMLElement {
	const bar = element("header", "pair-bar settings__bar host-settings__bar");
	const back = element("button", "icon-tap");
	back.type = "button";
	back.setAttribute("aria-label", t("뒤로"));
	back.append(glyph(iconChevronLeft, 20));
	back.addEventListener("click", backAction);
	bar.append(
		back,
		element("h1", "pair-bar__title host-settings__title", t(title)),
	);
	if (trailing) bar.append(trailing);
	return bar;
}

const header = renderHostSettingsHeader;

/**
 * The paired computers, each with its own 잊기.
 *
 * No detail screen behind a row: a computer is one fact (its address and
 * whether the relay reaches it) and one action, so the row is plain text with
 * the forget button as a sibling — a button inside a button is invalid, and a
 * row that is itself a button would promise a screen that does not exist.
 */
export function renderComputerListScreen(
	model: ComputerListModel,
	actions: ComputerListActions,
): HTMLElement {
	const screen = element("section", "pair-screen settings host-settings");
	screen.append(header(actions.back, undefined, "컴퓨터"));

	const body = element("div", "host-settings__body host-settings__body--list");
	fadeWhileScrollable(body, { start: "scroll-fade--start", end: "scroll-fade--end" }, "y");
	if (model.computers.length > 0) {
		const list = element("ul", "host-settings__list");
		for (const computer of model.computers) {
			const item = element("li", "host-settings__item host-settings__item--computer");
			const text = element("div", "host-settings__row-text");
			const title = element("span", "host-settings__row-title");
			title.append(element("span", "host-settings__row-name", computer.label));
			text.append(
				title,
				element(
					"span",
					"host-settings__endpoint",
					`${computer.endpoint} · ${t(computer.reach)}`,
				),
			);
			const forget = element("button", "host-settings__forget");
			forget.type = "button";
			// Named by computer, so a cancelled dialog can hand focus back to
			// the very button that opened it.
			forget.dataset.id = computer.id;
			forget.setAttribute("aria-label", `${computer.label}, ${t("잊기")}`);
			forget.append(glyph(iconTrash, 16), element("span", undefined, t("잊기")));
			forget.addEventListener("click", () => actions.forget(computer.id));
			item.append(text, forget);
			list.append(item);
		}
		body.append(list);
	} else {
		body.append(
			element("p", "host-settings__empty", t("짝지은 컴퓨터가 없습니다")),
		);
	}
	body.append(
		element(
			"p",
			"host-settings__hint",
			t("잊어도 노트북의 기기 목록에는 남습니다 — 해지는 노트북에서 합니다."),
		),
	);

	const add = element("button", "host-settings__add");
	add.type = "button";
	add.append(glyph(iconPlus, 16), element("span", undefined, t("컴퓨터 연결")));
	add.addEventListener("click", actions.pair);
	body.append(add);
	screen.append(body);
	return screen;
}

export function renderHostListScreen(
	model: HostSettingsListModel,
	actions: HostSettingsListActions,
): HTMLElement {
	const screen = element("section", "pair-screen settings host-settings");
	screen.append(header(actions.back));

	const body = element("div", "host-settings__body host-settings__body--list");
	fadeWhileScrollable(body, { start: "scroll-fade--start", end: "scroll-fade--end" }, "y");
	if (model.hosts.length > 0) {
		const list = element("ul", "host-settings__list");
		for (const host of model.hosts) {
			const item = element("li", "host-settings__item");
			const open = element("button", "host-settings__list-row");
			open.type = "button";
			open.setAttribute(
				"aria-label",
				host.disconnected
					? `${host.label}, ${host.endpoint}, ${t("연결 안 됨")}`
					: `${host.label}, ${host.endpoint}`,
			);

			const text = element("span", "host-settings__row-text");
			const title = element("span", "host-settings__row-title");
			title.append(element("span", "host-settings__row-name", host.label));
			if (host.disconnected) {
				title.append(
					element("span", "host-settings__offline", t("연결 안 됨")),
				);
			}
			text.append(
				title,
				element("span", "host-settings__endpoint", host.endpoint),
			);
			open.append(text, glyph(iconChevronRight, 16, "host-settings__chevron"));
			open.addEventListener("click", () => actions.open(host.id));
			item.append(open);
			list.append(item);
		}
		body.append(list);
	}

	const add = element("button", "host-settings__add");
	add.type = "button";
	add.append(
		glyph(iconPlus, 16),
		element("span", undefined, t("SSH 호스트 추가")),
	);
	add.addEventListener("click", actions.add);
	body.append(add);
	screen.append(body);
	return screen;
}

function inputField(
	labelText: string,
	input: HTMLInputElement,
): HTMLLabelElement {
	const field = element("label", "host-settings__field");
	field.append(
		element("span", "host-settings__field-label", t(labelText)),
		input,
	);
	return field;
}

export function renderHostDetailScreen(
	model: HostSettingsDetailModel,
	actions: HostSettingsDetailActions,
): HTMLElement {
	const screen = element("section", "pair-screen settings host-settings");
	const form = element("form", "host-settings__form");
	form.id = "host-settings-form";
	const save = element("button", "host-settings__save", t("저장"));
	save.type = "submit";
	save.setAttribute("form", form.id);
	save.disabled = true;
	screen.append(header(actions.back, save));

	const body = element(
		"div",
		"host-settings__body host-settings__body--detail",
	);
	const status = element(
		"div",
		`host-settings__status host-settings__status--${model.status}`,
	);
	status.setAttribute("role", "status");
	status.setAttribute("aria-live", "polite");
	status.append(
		element(
			"span",
			undefined,
			model.status === "connected"
				? connectedStatus(model.checkedAt)
				: t(STATUS_TEXT[model.status]),
		),
	);
	if (model.status === "retrying") {
		const retry = element("button", "host-settings__retry");
		retry.type = "button";
		retry.setAttribute("aria-label", t("다시 확인"));
		retry.append(glyph(iconRefresh, 16));
		retry.addEventListener("click", actions.retry);
		status.append(retry);
	}
	body.append(status);

	const host = element("input", "host-settings__input");
	host.type = "text";
	host.name = "host";
	host.value = model.draft.host;
	host.autocapitalize = "off";
	host.spellcheck = false;

	const port = element("input", "host-settings__input");
	port.type = "text";
	port.name = "port";
	port.inputMode = "numeric";
	port.pattern = "[0-9]*";
	port.value = model.draft.port.trim() || "22";

	const username = element("input", "host-settings__input");
	username.type = "text";
	username.name = "username";
	username.value = model.draft.username;
	username.autocapitalize = "off";
	username.autocomplete = "username";
	username.spellcheck = false;

	const label = element("input", "host-settings__input");
	label.type = "text";
	label.name = "label";
	label.value = model.draft.label;

	const endpoint = element("div", "host-settings__endpoint-fields");
	endpoint.append(inputField("호스트", host), inputField("포트", port));
	form.append(
		endpoint,
		inputField("사용자", username),
		inputField("라벨 (선택)", label),
	);

	const initialValues = [host.value, port.value, username.value, label.value];
	const inputs = [host, port, username, label];
	const updateSave = (): void => {
		const portNumber = Number(port.value);
		const valid =
			host.value.trim().length > 0 &&
			username.value.trim().length > 0 &&
			/^\d+$/.test(port.value.trim()) &&
			Number.isInteger(portNumber) &&
			portNumber > 0 &&
			portNumber <= 65535;
		const dirty = inputs.some(
			(input, index) => input.value !== initialValues[index],
		);
		save.disabled = !dirty || !valid;
	};
	for (const input of inputs) input.addEventListener("input", updateSave);

	const remove = element("button", "host-settings__remove");
	remove.type = "button";
	remove.append(
		glyph(iconTrash, 16),
		element("span", undefined, t("호스트 제거")),
	);
	remove.addEventListener("click", actions.remove);

	// 저장된 상자에만 붙는다. 시작은 이 화면이 가진 유일한 "지금 무언가를
	// 하는" 버튼이라 제거 위, 폼 밖에 둔다 — 폼 안이면 Enter 가 시작으로 샌다.
	const start = element("button", "host-settings__start");
	start.type = "button";
	start.disabled = model.starting === true;
	start.append(
		glyph(iconPlus, 16),
		element(
			"span",
			undefined,
			model.starting === true ? t("시작하는 중…") : t("이 서버에서 세션 시작"),
		),
	);
	start.addEventListener("click", actions.startSession);

	// The keys behind this host. A row, not a button like 시작: it opens a
	// screen rather than doing something, and the chevron says so.
	const keys = element("button", "host-settings__keys");
	keys.type = "button";
	keys.append(
		glyph(iconKey, 16),
		element("span", "host-settings__keys-label", t("SSH 키")),
		glyph(iconChevronRight, 16, "host-settings__chevron"),
	);
	keys.addEventListener("click", actions.openKeys);
	if (model.draft.id) body.append(start, keys);
	if (model.draft.id) form.append(remove);

	form.addEventListener("submit", (event) => {
		event.preventDefault();
		if (save.disabled) return;
		actions.save({
			...model.draft,
			host: host.value,
			port: port.value,
			username: username.value,
			label: label.value,
		});
	});

	body.append(form);
	screen.append(body);
	return screen;
}
