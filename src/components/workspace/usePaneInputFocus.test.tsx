// @vitest-environment jsdom

import { act, fireEvent, renderHook } from "@testing-library/react";
import { createDockview } from "dockview-react";
import { afterEach, expect, it, vi } from "vitest";
import { CurrentWindowFocusAuthority } from "@/lib/workspace/window/currentWindowFocus";
import { usePaneInputFocus } from "./usePaneInputFocus";

const cleanups: (() => void)[] = [];

afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	vi.unstubAllGlobals();
});

function fixture(windowReady = false, inputReady = true) {
	let nativeFocus!: (focused: boolean) => void;
	const authority = new CurrentWindowFocusAuthority(false, {
		listen: (listener) => {
			nativeFocus = listener;
			return new Promise(() => {});
		},
		read: () => new Promise(() => {}),
	});
	cleanups.push(authority.subscribe(() => {}));
	nativeFocus(false);
	vi.stubGlobal("__dureCurrentWindowFocusAuthorityV1", authority);
	if (windowReady) {
		authority.updateFallback(true);
		nativeFocus(true);
	}
	const container = document.createElement("div");
	const search = document.createElement("input");
	document.body.append(container, search);
	const api = createDockview(container, {
		createComponent: () => ({
			element: document.createElement("textarea"),
			init() {},
		}),
	});
	const pane = api.addPanel({ id: "input", component: "test" });
	const neighbor = api.addPanel({
		id: "neighbor",
		component: "test",
		position: { referencePanel: pane.id, direction: "right" },
	});
	api.layout(800, 600);
	pane.api.setActive();
	const input = pane.group.element.querySelector("textarea")!;
	const hook = renderHook(
		({ ready }) => {
			input.disabled = !ready;
			return usePaneInputFocus({
				paneApi: pane.api,
				inputRef: { current: input },
				inputReady: ready,
			});
		},
		{ initialProps: { ready: inputReady } },
	);
	search.focus();
	cleanups.push(() => {
		hook.unmount();
		api.dispose();
		container.remove();
		search.remove();
	});
	return { authority, nativeFocus, api, pane, neighbor, input, search, hook };
}

it.each([
	["native-first", false],
	["native-first", true],
	["dom-first", false],
	["dom-first", true],
] as const)(
	"fulfills one explicit pane focus when window activation settles (%s, first edge before request=%s)",
	(order, firstEdgeBeforeRequest) => {
		const f = fixture();
		const firstEdge = () => {
			if (order === "native-first") f.nativeFocus(true);
			else f.authority.updateFallback(true);
		};
		if (firstEdgeBeforeRequest) act(firstEdge);
		act(() => f.api.focus());
		expect(document.activeElement).not.toBe(f.input);
		if (!firstEdgeBeforeRequest) act(firstEdge);
		expect(document.activeElement).not.toBe(f.input);
		act(() => {
			if (order === "native-first") f.authority.updateFallback(true);
			else f.nativeFocus(true);
		});
		// No second click, React render, animation frame or polling timer.
		expect(document.activeElement).toBe(f.input);
	},
);

it("observes window loss even if another native listener requests focus first", () => {
	const f = fixture(true);
	const focus = vi.spyOn(f.input, "focus");
	cleanups.push(
		f.authority.subscribe((focused) => {
			if (!focused) f.hook.result.current();
		}),
	);
	act(() => f.nativeFocus(false));
	expect(focus).not.toHaveBeenCalled();
});

it("focuses synchronously when the input and window are already ready", () => {
	const f = fixture(true);
	act(() => f.api.focus());
	expect(document.activeElement).toBe(f.input);
});

it("does not create a focus request merely because a window activates", () => {
	const f = fixture();
	act(() => {
		f.authority.updateFallback(true);
		f.nativeFocus(true);
	});
	expect(document.activeElement).toBe(f.search);
});

it.each(["pointer", "focus", "other-pane", "hidden", "unmount"] as const)(
	"does not replay a superseded window-activation request (%s)",
	(interruption) => {
		const f = fixture();
		act(() => {
			f.hook.result.current();
			if (interruption === "pointer") fireEvent.pointerDown(f.search);
			if (interruption === "focus") {
				f.search.blur();
				f.search.focus();
			}
			if (interruption === "other-pane") f.neighbor.api.setActive();
			if (interruption === "hidden") f.pane.group.api.setVisible(false);
			if (interruption === "unmount") f.hook.unmount();
			f.authority.updateFallback(true);
			f.nativeFocus(true);
		});
		expect(document.activeElement).not.toBe(f.input);
	},
);

it("retains explicit body focus until both the window and input are ready", () => {
	const f = fixture(false, false);
	act(() => f.hook.result.current());
	act(() => {
		f.authority.updateFallback(true);
		f.nativeFocus(true);
	});
	expect(document.activeElement).not.toBe(f.input);
	f.hook.rerender({ ready: true });
	expect(document.activeElement).toBe(f.input);
});

it.each(["native", "dom"] as const)(
	"cancels a pending input request on actual window focus loss (%s)",
	(source) => {
		const f = fixture(true, false);
		act(() => f.api.focus());
		act(() => {
			if (source === "native") f.nativeFocus(false);
			else f.authority.updateFallback(false);
		});
		act(() => {
			f.authority.updateFallback(true);
			f.nativeFocus(true);
		});
		f.hook.rerender({ ready: true });
		expect(document.activeElement).not.toBe(f.input);
	},
);
