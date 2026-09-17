// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { chromeDragIntent } from "./windowChromeDrag";

function press(target: EventTarget | null, detail = 1, button = 0) {
	return { button, detail, target };
}

describe("chromeDragIntent", () => {
	it("starts an OS drag on a plain primary press", () => {
		const strip = document.createElement("header");
		expect(chromeDragIntent(press(strip))).toBe("start-dragging");
	});

	it("maximizes on a primary double-click", () => {
		const strip = document.createElement("header");
		expect(chromeDragIntent(press(strip, 2))).toBe("toggle-maximize");
	});

	it("ignores non-primary buttons", () => {
		const strip = document.createElement("header");
		expect(chromeDragIntent(press(strip, 1, 2))).toBeUndefined();
		expect(chromeDragIntent(press(strip, 2, 1))).toBeUndefined();
	});

	it("leaves presses inside interactive descendants alone", () => {
		const strip = document.createElement("header");
		for (const tag of ["button", "input", "textarea"]) {
			const child = document.createElement(tag);
			strip.appendChild(child);
			expect(chromeDragIntent(press(child))).toBeUndefined();
			expect(chromeDragIntent(press(child, 2))).toBeUndefined();
		}
	});

	it("respects data-nodrag on an ancestor of the press target", () => {
		const strip = document.createElement("header");
		const island = document.createElement("div");
		island.setAttribute("data-nodrag", "");
		const label = document.createElement("span");
		island.appendChild(label);
		strip.appendChild(island);
		expect(chromeDragIntent(press(label))).toBeUndefined();
	});

	it("tolerates targets without an element API", () => {
		expect(chromeDragIntent(press(null))).toBe("start-dragging");
	});
});
