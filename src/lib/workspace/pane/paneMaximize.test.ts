// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { escapeRestoresMaximizedPane } from "@/lib/workspace/pane/paneMaximize";

afterEach(() => {
	document.body.replaceChildren();
});

type EscapeInit = Partial<{
	key: string;
	defaultPrevented: boolean;
	isComposing: boolean;
	shiftKey: boolean;
}>;

function escapeKey(target: EventTarget | null, init: EscapeInit = {}) {
	return {
		key: "Escape",
		target,
		defaultPrevented: false,
		isComposing: false,
		metaKey: false,
		ctrlKey: false,
		altKey: false,
		shiftKey: false,
		...init,
	};
}

function mount(html: string, selector: string): Element {
	document.body.innerHTML = html;
	return document.body.querySelector(selector)!;
}

describe("Esc restores a maximized pane", () => {
	it.each([
		["the document", () => document.body],
		[
			"a pane header button",
			() =>
				mount(
					"<div class='pane-chrome'><button>Restore</button></div>",
					"button",
				),
		],
		[
			"a pane's non-text content",
			() => mount("<div tabindex='0'>image</div>", "div"),
		],
	])("from %s", (_, target) => {
		expect(escapeRestoresMaximizedPane(escapeKey(target()))).toBe(true);
	});

	it.each([
		["a text input", "<input>", "input"],
		[
			"a terminal or agent TUI input",
			"<div data-terminal-surface-id='s'><textarea></textarea></div>",
			"textarea",
		],
		["an agent chat composer", "<textarea></textarea>", "textarea"],
		["a select", "<select></select>", "select"],
		[
			"an editor",
			"<div class='cm-editor'><div contenteditable='true'><span>x</span></div></div>",
			"span",
		],
		[
			"a contenteditable surface",
			"<div contenteditable='true'><b>x</b></div>",
			"b",
		],
		[
			"a legacy xterm",
			"<div class='xterm'><div tabindex='0'></div></div>",
			"[tabindex]",
		],
		[
			"a terminal surface",
			"<div data-terminal-surface-id='s'><div tabindex='0'></div></div>",
			"[tabindex]",
		],
		["a dialog", "<div role='dialog'><button>OK</button></div>", "button"],
		[
			"a menu",
			"<div role='menu'><div role='menuitem' tabindex='0'></div></div>",
			"[role='menuitem']",
		],
	])("but leaves Esc to %s", (_, html, selector) => {
		expect(escapeRestoresMaximizedPane(escapeKey(mount(html, selector)))).toBe(
			false,
		);
	});

	it.each([
		["another handler already took it", { defaultPrevented: true }],
		["an IME composition is open", { isComposing: true }],
		["a modifier is held", { shiftKey: true }],
		["a different key", { key: "Enter" }],
	] as const)("but not when %s", (_, init: EscapeInit) => {
		expect(escapeRestoresMaximizedPane(escapeKey(document.body, init))).toBe(
			false,
		);
	});
});
