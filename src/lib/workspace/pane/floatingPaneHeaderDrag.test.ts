// @vitest-environment jsdom

import type { DockviewApi } from "dockview-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installFloatingPaneHeaderDrag } from "@/lib/workspace/pane/floatingPaneHeaderDrag";

function pointerEvent(
	type: string,
	options: { shiftKey?: boolean } = {},
): PointerEvent {
	const event = new MouseEvent(type, {
		bubbles: true,
		cancelable: true,
		button: 0,
		buttons: type === "pointerup" ? 0 : 1,
		clientX: 240,
		clientY: 180,
		shiftKey: options.shiftKey,
	}) as PointerEvent;
	Object.defineProperties(event, {
		isPrimary: { value: true },
		pointerId: { value: 7 },
		pointerType: { value: "mouse" },
	});
	return event;
}

function setupFloatingPane() {
	const container = document.createElement("div");
	const overlay = document.createElement("div");
	overlay.className = "dv-resize-container";
	const titlebar = document.createElement("div");
	titlebar.className = "dv-floating-titlebar";
	titlebar.draggable = true;
	const group = document.createElement("div");
	group.className = "dv-groupview";
	const tab = document.createElement("div");
	tab.className = "dv-tab";
	tab.draggable = true;
	const chrome = document.createElement("div");
	chrome.className = "pane-chrome";
	const title = document.createElement("span");
	title.textContent = "README.md";
	const action = document.createElement("button");
	action.type = "button";
	action.textContent = "Close";
	chrome.append(title, action);
	tab.append(chrome);
	group.append(tab);
	overlay.append(titlebar, group);
	container.append(overlay);
	document.body.append(container);

	const setActive = vi.fn();
	const api = {
		groups: [{ element: group, api: { setActive } }],
	} as unknown as Pick<DockviewApi, "groups">;
	const dispose = installFloatingPaneHeaderDrag(container, api);
	return {
		action,
		chrome,
		dispose: () => {
			dispose();
			container.remove();
		},
		overlay,
		setActive,
		tab,
		title,
		titlebar,
	};
}

const disposers: Array<() => void> = [];

afterEach(() => {
	for (const dispose of disposers.splice(0)) dispose();
});

describe("floating pane first-drag ownership", () => {
	it("routes one plain visible-header drag to Dockview's floating move handle", () => {
		const fixture = setupFloatingPane();
		disposers.push(fixture.dispose);
		const titlebarPointerDown = vi.fn();
		const chromePointerDown = vi.fn();
		const overlayPointerDown = vi.fn();
		fixture.titlebar.addEventListener("pointerdown", titlebarPointerDown);
		fixture.chrome.addEventListener("pointerdown", chromePointerDown);
		fixture.overlay.addEventListener("pointerdown", overlayPointerDown);

		const down = pointerEvent("pointerdown");
		fixture.title.dispatchEvent(down);

		expect(down.defaultPrevented).toBe(true);
		expect(titlebarPointerDown).toHaveBeenCalledOnce();
		expect(chromePointerDown).not.toHaveBeenCalled();
		expect(overlayPointerDown).toHaveBeenCalledOnce();
		expect(fixture.setActive).toHaveBeenCalledOnce();
		expect(fixture.tab.draggable).toBe(false);
		window.dispatchEvent(pointerEvent("pointerup"));
		expect(fixture.tab.draggable).toBe(true);
	});

	it("suspends HTML5 titlebar drag before a plain floating move starts", () => {
		const fixture = setupFloatingPane();
		disposers.push(fixture.dispose);
		let draggableAtTarget = true;
		fixture.titlebar.addEventListener("pointerdown", () => {
			draggableAtTarget = fixture.titlebar.draggable;
		});

		fixture.titlebar.dispatchEvent(pointerEvent("pointerdown"));

		expect(draggableAtTarget).toBe(false);
		window.dispatchEvent(pointerEvent("pointerup"));
		expect(fixture.titlebar.draggable).toBe(true);
	});

	it("keeps pane actions click-only instead of turning them into move handles", () => {
		const fixture = setupFloatingPane();
		disposers.push(fixture.dispose);
		const titlebarPointerDown = vi.fn();
		fixture.titlebar.addEventListener("pointerdown", titlebarPointerDown);

		const down = pointerEvent("pointerdown");
		fixture.action.dispatchEvent(down);

		expect(down.defaultPrevented).toBe(false);
		expect(titlebarPointerDown).not.toHaveBeenCalled();
	});

	it("keeps Shift+drag as the explicit native redock gesture", () => {
		const fixture = setupFloatingPane();
		disposers.push(fixture.dispose);
		const titlebarPointerDown = vi.fn();
		const chromePointerDown = vi.fn();
		const overlayPointerDown = vi.fn();
		fixture.titlebar.addEventListener("pointerdown", titlebarPointerDown);
		fixture.chrome.addEventListener("pointerdown", chromePointerDown);
		fixture.overlay.addEventListener("pointerdown", overlayPointerDown);

		const down = pointerEvent("pointerdown", { shiftKey: true });
		fixture.title.dispatchEvent(down);

		expect(down.defaultPrevented).toBe(false);
		expect(titlebarPointerDown).not.toHaveBeenCalled();
		expect(chromePointerDown).toHaveBeenCalledOnce();
		expect(overlayPointerDown).not.toHaveBeenCalled();
		expect(fixture.tab.draggable).toBe(true);
		expect(fixture.setActive).toHaveBeenCalledOnce();
	});
});
