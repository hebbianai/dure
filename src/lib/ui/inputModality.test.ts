// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { lastInputMovedFocus, lastInputWasKeyboard } from "./inputModality";

function freshDocument() {
	const frame = document.createElement("iframe");
	document.body.appendChild(frame);
	return frame.contentDocument as Document;
}

function press(doc: Document, key: string) {
	doc.body.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
}

function pointerDown(doc: Document) {
	doc.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
}

describe("lastInputWasKeyboard", () => {
	it("assumes the keyboard until the user has touched the document", () => {
		expect(lastInputWasKeyboard(freshDocument())).toBe(true);
	});

	it("follows the most recent press or key", () => {
		const doc = freshDocument();
		lastInputWasKeyboard(doc);

		pointerDown(doc);
		expect(lastInputWasKeyboard(doc)).toBe(false);
		press(doc, "Tab");
		expect(lastInputWasKeyboard(doc)).toBe(true);
		pointerDown(doc);
		expect(lastInputWasKeyboard(doc)).toBe(false);
	});

	it("does not take a held modifier for keyboard use — ⌘-click is a click", () => {
		const doc = freshDocument();
		lastInputWasKeyboard(doc);

		pointerDown(doc);
		for (const key of ["Meta", "Control", "Alt", "Shift"]) press(doc, key);
		expect(lastInputWasKeyboard(doc)).toBe(false);
	});

	it("hears input that a handler stops from bubbling", () => {
		const doc = freshDocument();
		lastInputWasKeyboard(doc);
		doc.body.addEventListener("pointerdown", (event) => event.stopPropagation());

		pointerDown(doc);
		expect(lastInputWasKeyboard(doc)).toBe(false);
	});

	it("keeps each document's answer apart", () => {
		const first = freshDocument();
		const second = freshDocument();
		lastInputWasKeyboard(first);
		lastInputWasKeyboard(second);

		pointerDown(first);
		expect(lastInputWasKeyboard(first)).toBe(false);
		expect(lastInputWasKeyboard(second)).toBe(true);
	});

	it("tracks the app's own document from the start", () => {
		pointerDown(document);
		expect(lastInputWasKeyboard(document)).toBe(false);
		press(document, "Tab");
	});
});

describe("lastInputMovedFocus", () => {
	it("is true only after a key that walks focus", () => {
		const doc = freshDocument();
		expect(lastInputMovedFocus(doc)).toBe(false);

		for (const key of ["Tab", "ArrowDown", "ArrowLeft", "Home", "End"]) {
			press(doc, key);
			expect(lastInputMovedFocus(doc)).toBe(true);
		}
	});

	it("is false after the keys that open and close a surface, and after a press", () => {
		const doc = freshDocument();
		lastInputMovedFocus(doc);

		for (const key of ["Enter", " ", "Escape", "k"]) {
			press(doc, "Tab");
			press(doc, key);
			expect(lastInputMovedFocus(doc)).toBe(false);
			expect(lastInputWasKeyboard(doc)).toBe(true);
		}
		press(doc, "Tab");
		pointerDown(doc);
		expect(lastInputMovedFocus(doc)).toBe(false);
	});
});
