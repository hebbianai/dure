// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { keepPointerOpenFocusOnSurface } from "./pointerOpenFocus";

function surfaceWith(html: string) {
	const surface = document.createElement("div");
	surface.tabIndex = -1;
	surface.innerHTML = html;
	document.body.appendChild(surface);
	return surface;
}

// Radix dispatches a cancelable event on the surface and focuses the first
// tabbable control itself unless the event comes back default-prevented.
function openAutoFocus(surface: HTMLElement) {
	const event = new Event("focusScope.autoFocusOnMount", { cancelable: true });
	surface.addEventListener(event.type, keepPointerOpenFocusOnSurface);
	surface.dispatchEvent(event);
	return event;
}

function lastInput(kind: "pointer" | "keyboard") {
	document.body.dispatchEvent(
		kind === "pointer"
			? new Event("pointerdown", { bubbles: true })
			: new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
	);
}

describe("keepPointerOpenFocusOnSurface", () => {
	afterEach(() => {
		document.body.replaceChildren();
		lastInput("keyboard");
	});

	it("takes focus itself when a click opened it onto a button", () => {
		const surface = surfaceWith("<button>Refresh</button><input />");
		lastInput("pointer");

		expect(openAutoFocus(surface).defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(surface);
	});

	it.each([
		["a text input", "<input />"],
		["a typed input", '<input type="search" />'],
		["a textarea", "<textarea></textarea>"],
		["an editable region", '<div contenteditable="true" tabindex="0"></div>'],
	])("leaves %s to Radix, so typing can start at once", (_name, field) => {
		const surface = surfaceWith(`${field}<button>Save</button>`);
		lastInput("pointer");

		expect(openAutoFocus(surface).defaultPrevented).toBe(false);
		expect(document.activeElement).toBe(document.body);
	});

	it("looks past what Radix would not focus: disabled, hidden, links, untabbable", () => {
		const surface = surfaceWith(
			'<button disabled>Off</button><input type="hidden" /><a href="#x">Docs</a>' +
				'<button tabindex="-1">Skipped</button><button hidden>Gone</button>' +
				'<span style="display: none"><button>Collapsed</button></span><textarea></textarea>',
		);
		lastInput("pointer");

		expect(openAutoFocus(surface).defaultPrevented).toBe(false);
	});

	it("does not count a checkbox or a button-like input as a text field", () => {
		for (const type of ["checkbox", "radio", "button", "submit", "range", "file"]) {
			const surface = surfaceWith(`<input type="${type}" />`);
			lastInput("pointer");

			expect(openAutoFocus(surface).defaultPrevented).toBe(true);
			surface.remove();
		}
	});

	it("leaves a keyboard open to Radix — focus belongs on the first control", () => {
		const surface = surfaceWith("<button>Refresh</button>");
		lastInput("keyboard");

		expect(openAutoFocus(surface).defaultPrevented).toBe(false);
	});

	it("respects a caller that already decided", () => {
		const surface = surfaceWith("<button>Refresh</button>");
		lastInput("pointer");
		surface.addEventListener("focusScope.autoFocusOnMount", (event) =>
			event.preventDefault(),
		);

		openAutoFocus(surface);
		expect(document.activeElement).toBe(document.body);
	});
});
