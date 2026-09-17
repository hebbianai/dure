// @vitest-environment jsdom

import { act, fireEvent, renderHook } from "@testing-library/react";
import { createDockview } from "dockview-react";
import { expect, it, vi } from "vitest";
import { useStructuredTerminalPaneFocus } from "./useStructuredTerminalPaneFocus";

vi.mock("@/lib/workspace/window/currentWindowFocus", () => ({
	currentWindowIsFocused: () => true,
	currentWindowIsInputReady: () => true,
	subscribeCurrentWindowInputReady: (listener: (ready: boolean) => void) => {
		listener(true);
		return () => {};
	},
}));

it("keeps keyboard focus wired to the pane's current group after a move", () => {
	const container = document.createElement("div");
	document.body.append(container);
	const api = createDockview(container, {
		createComponent: () => ({
			element: document.createElement("textarea"),
			init() {},
		}),
	});
	const pane = api.addPanel({ id: "terminal", component: "test" });
	const neighbor = api.addPanel({
		id: "neighbor",
		component: "test",
		position: { referencePanel: "terminal", direction: "right" },
	});
	api.layout(800, 600);
	const input = pane.group.element.querySelector("textarea")!;
	const hook = renderHook(() =>
		useStructuredTerminalPaneFocus({
			paneApi: pane.api,
			inputRef: { current: input },
			surfaceId: "test-terminal",
			inputReady: true,
		}),
	);
	try {
		act(() => {
			pane.api.setActive();
			api.focus();
		});
		expect(document.activeElement).toBe(input);
		const originalGroup = pane.group;
		act(() => {
			pane.api.moveTo({ group: neighbor.group, position: "center" });
			neighbor.api.setActive();
			api.focus();
		});
		expect(pane.group).not.toBe(originalGroup);
		expect(document.activeElement).not.toBe(input);
		act(() => {
			pane.api.setActive();
			api.focus();
		});
		expect(document.activeElement).toBe(input);
	} finally {
		hook.unmount();
		api.dispose();
		container.remove();
	}
});

it.each([false, true])(
	"honors the latest focus intent while input becomes ready (refocus=%s)",
	(refocus) => {
		const container = document.createElement("div");
		const search = document.createElement("input");
		document.body.append(container, search);
		const api = createDockview(container, {
			createComponent: () => ({
				element: document.createElement("textarea"),
				init() {},
			}),
		});
		const pane = api.addPanel({ id: "terminal", component: "test" });
		api.layout(800, 600);
		const input = pane.group.element.querySelector("textarea")!;
		const hook = renderHook(
			({ ready }) => {
				input.disabled = !ready;
				return useStructuredTerminalPaneFocus({
					paneApi: pane.api,
					inputRef: { current: input },
					surfaceId: "test-terminal",
					inputReady: ready,
				});
			},
			{ initialProps: { ready: false } },
		);
		try {
			act(() => api.focus());
			expect(document.activeElement).not.toBe(input);
			act(() => {
				search.focus();
				if (refocus) {
					fireEvent.pointerDown(pane.group.element);
					// Focus can arrive before React commits the next complete frame.
					api.focus();
				}
			});
			hook.rerender({ ready: true });
			expect(document.activeElement).toBe(refocus ? input : search);
		} finally {
			hook.unmount();
			api.dispose();
			container.remove();
			search.remove();
		}
	},
);

it.each(["none", "pointer", "focus", "other-pane", "hidden"] as const)(
	"retains a body click across input readiness unless superseded (%s)",
	(interruption) => {
		const container = document.createElement("div");
		const search = document.createElement("input");
		document.body.append(container, search);
		const api = createDockview(container, {
			createComponent: () => ({
				element: document.createElement("textarea"),
				init() {},
			}),
		});
		const pane = api.addPanel({ id: "terminal", component: "test" });
		const neighbor = api.addPanel({
			id: "neighbor",
			component: "test",
			position: { referencePanel: "terminal", direction: "right" },
		});
		api.layout(800, 600);
		pane.api.setActive();
		const input = pane.group.element.querySelector("textarea")!;
		input.value = "draft";
		input.setSelectionRange(0, 0);
		const hook = renderHook(
			({ ready }) => {
				input.disabled = !ready;
				return useStructuredTerminalPaneFocus({
					paneApi: pane.api,
					inputRef: { current: input },
					surfaceId: "test-terminal",
					inputReady: ready,
				});
			},
			{ initialProps: { ready: false } },
		);
		try {
			search.focus();
			act(() => {
				fireEvent.pointerDown(pane.group.element);
				// Body selection completion calls this helper without api.focus().
				hook.result.current.focusPaneInput();
			});
			expect(document.activeElement).toBe(search);
			act(() => {
				if (interruption === "pointer") fireEvent.pointerDown(search);
				if (interruption === "focus") {
					search.blur();
					search.focus();
				}
				if (interruption === "other-pane") neighbor.api.setActive();
				if (interruption === "hidden") pane.group.api.setVisible(false);
			});
			hook.rerender({ ready: true });
			if (interruption === "none") {
				expect(document.activeElement).toBe(input);
				expect(input.selectionStart).toBe(input.value.length);
				expect(input.selectionEnd).toBe(input.value.length);
			} else {
				expect(document.activeElement).not.toBe(input);
			}
		} finally {
			hook.unmount();
			api.dispose();
			container.remove();
			search.remove();
		}
	},
);
