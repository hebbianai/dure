// @vitest-environment jsdom

import type { DockviewApi } from "dockview-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLang } from "@/lib/i18n";
import {
	installPaneDragBehaviors,
	undoPaneMove,
} from "@/lib/workspace/pane/paneDragBehaviors";
import { installInteriorBoundaryDrop } from "@/lib/workspace/pane/paneInsertionDrop";
import { recordPaneMoveSnapshot } from "@/lib/workspace/pane/paneMoveUndo";
import { paneDragPerformance } from "@/lib/workspace/performance/paneDragPerformance";

type Handler = (event: never) => void;

function rect(
	left: number,
	top: number,
	width: number,
	height: number,
): DOMRect {
	return {
		left,
		top,
		right: left + width,
		bottom: top + height,
		width,
		height,
		x: left,
		y: top,
		toJSON: () => ({}),
	} as DOMRect;
}

function dragEvent(type: string, clientX: number, clientY: number): DragEvent {
	const event = new Event(type, { cancelable: true }) as DragEvent;
	Object.defineProperties(event, {
		clientX: { value: clientX },
		clientY: { value: clientY },
	});
	return event;
}

const disposers: Array<() => void> = [];

afterEach(() => {
	vi.restoreAllMocks();
	setLang("ko");
	for (const dispose of disposers.splice(0)) dispose();
	document.querySelectorAll(".pane-float-preview").forEach((node) => {
		node.remove();
	});
});

function setup() {
	const handlers: Record<string, Handler> = {};
	const sourceElement = document.createElement("div");
	sourceElement.getBoundingClientRect = () => rect(100, 100, 300, 240);
	const group = {
		id: "group-source",
		panels: [] as unknown[],
		element: sourceElement,
		api: { location: { type: "grid" } },
	};
	const panel = { id: "agent:codex", group };
	group.panels = [panel];
	const addFloatingGroup = vi.fn();
	const api = {
		groups: [group],
		toJSON: () => ({ grid: {} }),
		fromJSON: vi.fn(),
		getPanel: (id: string) => (id === panel.id ? panel : undefined),
		addFloatingGroup,
		onWillDragPanel: (handler: Handler) => {
			handlers.willDragPanel = handler;
			return { dispose: vi.fn() };
		},
		onWillDragGroup: (handler: Handler) => {
			handlers.willDragGroup = handler;
			return { dispose: vi.fn() };
		},
		onDidMovePanel: (handler: Handler) => {
			handlers.didMovePanel = handler;
			return { dispose: vi.fn() };
		},
		onWillShowOverlay: (handler: Handler) => {
			handlers.willShowOverlay = handler;
			return { dispose: vi.fn() };
		},
	} as unknown as DockviewApi;
	const container = document.createElement("div");
	container.getBoundingClientRect = () => rect(0, 0, 1000, 700);
	document.body.appendChild(container);
	const dispose = installPaneDragBehaviors(api, () => container);
	disposers.push(() => {
		dispose();
		container.remove();
	});
	const start = () => handlers.willDragPanel({ panel } as never);
	const prepareDockviewOverlay = (
		position: "left" | "right" | "top" | "bottom",
		nativeEvent = dragEvent("dragover", 700, 500),
		external = false,
	) => {
		const listeners = new Set<(surface: HTMLElement) => void>();
		const event = {
			defaultPrevented: false,
			position,
			nativeEvent,
			options: {
				getData: () => (external ? null : { groupId: group.id }),
				group: { id: "group-target", panels: [] },
			},
			onDidRenderOverlay(listener: (surface: HTMLElement) => void) {
				listeners.add(listener);
				return { dispose: () => listeners.delete(listener) };
			},
			preventDefault() {
				this.defaultPrevented = true;
			},
		};
		handlers.willShowOverlay(event as never);
		return (surface: HTMLElement, veto = false) => {
			if (veto) event.preventDefault();
			if (!event.defaultPrevented)
				for (const listener of listeners) listener(surface);
			listeners.clear();
		};
	};
	const showDockviewOverlay = (
		position: "left" | "right" | "top" | "bottom",
		surface: HTMLElement,
		veto = false,
	) => prepareDockviewOverlay(position)(surface, veto);
	return {
		addFloatingGroup,
		api,
		container,
		dispose,
		handlers,
		prepareDockviewOverlay,
		showDockviewOverlay,
		start,
	};
}

const flushRecommendation = () => Promise.resolve();

describe("pane floating drag recommendation", () => {
	it("reuses the floating preview during repeated pointer movement", async () => {
		const { start } = setup();
		start();
		window.dispatchEvent(dragEvent("dragover", 700, 500));
		await flushRecommendation();
		const preview = document.querySelector<HTMLElement>(".pane-float-preview");
		expect(preview).not.toBeNull();
		for (let index = 0; index < 20; index++) {
			window.dispatchEvent(dragEvent("dragover", 700 + index, 500));
			await flushRecommendation();
			expect(document.querySelector(".pane-float-preview")).toBe(preview);
		}
		expect(preview?.style.left).toBe("679px");
		window.dispatchEvent(dragEvent("dragend", 719, 500));
		expect(document.querySelector(".pane-float-preview")).toBeNull();
	});

	it("does not float a pane after a drop target consumes a rejected move", async () => {
		const { start, addFloatingGroup } = setup();
		start();
		window.dispatchEvent(dragEvent("dragover", 700, 500));
		await flushRecommendation();
		const drop = dragEvent("drop", 700, 500);
		window.dispatchEvent(drop);
		// The target runs after the window capture listener, even when it
		// consumes the gesture without emitting a successful Dockview move.
		drop.preventDefault();
		window.dispatchEvent(dragEvent("dragend", 700, 500));
		expect(addFloatingGroup).not.toHaveBeenCalled();
	});

	it.each(["dragenter", "dragover"])(
		"waits for the %s owner across native listener microtask checkpoints",
		async (type) => {
			const registered = vi.spyOn(window, "addEventListener");
			const { container, start, showDockviewOverlay } = setup();
			const capture = registered.mock.calls.find(
				([name, , options]) => name === type && options === true,
			)?.[1] as EventListener;
			const bubble = registered.mock.calls.find(
				([name, , options]) => name === type && options !== true,
			)?.[1] as EventListener | undefined;
			const query = vi.spyOn(container, "querySelectorAll");
			start();
			const event = dragEvent(type, 700, 500);
			capture(event);
			// Native dispatch can perform a checkpoint between listeners, unlike
			// a JavaScript dispatchEvent call with its enclosing script still on stack.
			await flushRecommendation();
			expect(query).not.toHaveBeenCalled();
			expect(document.querySelector(".pane-float-preview")).toBeNull();

			const split = document.createElement("div");
			split.className = "dv-drop-target-selection";
			container.append(split);
			showDockviewOverlay("bottom", split);
			await flushRecommendation();
			bubble?.(event);
			await flushRecommendation();
			expect(query).not.toHaveBeenCalled();
			expect(split.dataset.paneDropIntent).toBe("split-bottom");
			expect(document.querySelector(".pane-float-preview")).toBeNull();
		},
	);

	it.each(["panel", "group"])(
		"restores terminal targeting at every %s drag retirement boundary",
		(kind) => {
			const { container, dispose, handlers, start } = setup();
			const inactive = setup().container;
			const active = () => container.hasAttribute("data-pane-drag-active");
			const begin = () =>
				kind === "panel" ? start() : handlers.willDragGroup({} as never);
			const end = [
				() => window.dispatchEvent(dragEvent("dragend", 700, 500)),
				() => window.dispatchEvent(dragEvent("drop", 700, 500)),
				() =>
					window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })),
				() => handlers.didMovePanel({} as never),
				dispose,
			];
			expect(active()).toBe(false);
			for (const retire of end) {
				begin();
				expect(active()).toBe(true);
				expect(inactive.hasAttribute("data-pane-drag-active")).toBe(false);
				retire();
				expect(active()).toBe(false);
			}
		},
	);

	it("limits terminal targeting exclusion to the new-pane hover lifetime, not external files", () => {
		const { container } = setup();
		const hover = (type: string, x = 700) => {
			const event = dragEvent("dragover", x, 500);
			Object.defineProperty(event, "dataTransfer", {
				value: { types: [type] },
			});
			window.dispatchEvent(event);
		};
		const active = () => container.hasAttribute("data-pane-drag-active");
		hover("Files");
		expect(active()).toBe(false);
		hover("application/x-dure-new-pane", 1200);
		expect(active()).toBe(false);
		hover("application/x-dure-new-pane");
		expect(active()).toBe(true);
		hover("application/x-dure-new-pane", 1200);
		expect(active()).toBe(false);
		hover("application/x-dure-new-pane");
		expect(active()).toBe(true);
		window.dispatchEvent(dragEvent("dragend", 700, 500));
		expect(active()).toBe(false);
		hover("Files");
		expect(active()).toBe(false);
	});

	it.each(["dragenter", "dragover"])(
		"shares %s geometry with insertion while refreshing the next hover",
		async (type) => {
			const { api, container, start, addFloatingGroup } = setup();
			const createGroupAtLocation = vi.fn(() => ({ id: "inserted" }));
			const moveGroupOrPanel = vi.fn();
			Object.assign(api, {
				component: { createGroupAtLocation, moveGroupOrPanel },
			});
			vi.spyOn(api, "toJSON").mockReturnValue({
				grid: {
					orientation: "HORIZONTAL",
					width: 1000,
					height: 700,
					root: {
						type: "branch",
						size: 700,
						data: [
							{ type: "leaf", size: 300, data: { id: "a", views: ["a"] } },
							{ type: "leaf", size: 300, data: { id: "b", views: ["b"] } },
							{
								type: "leaf",
								size: 400,
								data: { id: "group-source", views: ["agent:codex"] },
							},
						],
					},
				},
			} as ReturnType<DockviewApi["toJSON"]>);
			disposers.push(
				installInteriorBoundaryDrop({
					api,
					container,
					draggedPanelId: () => "agent:codex",
				}),
			);
			start();
			const geometry = vi.spyOn(container, "getBoundingClientRect");
			for (const [left, x, insertion] of [
				[0, 300, true],
				[200, 300, false],
				[200, 500, true],
			] as const) {
				geometry.mockReturnValue(rect(left, 0, 1000, 700));
				const event = new MouseEvent(type, {
					bubbles: true,
					cancelable: true,
					clientX: x,
					clientY: 500,
				});
				Object.defineProperty(event, "dataTransfer", {
					value: { types: ["application/x-dure-pane"] },
				});
				container.dispatchEvent(event);
				await flushRecommendation();
				const overlay = container.querySelector<HTMLElement>(
					".pane-boundary-drop-overlay",
				);
				expect(overlay?.style.display === "block").toBe(insertion);
				if (insertion) {
					expect(event.defaultPrevented).toBe(true);
					expect(overlay?.dataset.paneDropIntent).toBe("insert-column");
					expect(overlay?.style.left).toBe("286px");
					expect(document.querySelector(".pane-float-preview")).toBeNull();
				}
			}
			window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
			expect(
				container.querySelector<HTMLElement>(".pane-boundary-drop-overlay")
					?.style.display,
			).toBe("none");
			expect(addFloatingGroup).not.toHaveBeenCalled();
			expect(createGroupAtLocation).not.toHaveBeenCalled();
			expect(moveGroupOrPanel).not.toHaveBeenCalled();
			expect(geometry).toHaveBeenCalledTimes(3);
		},
	);
	it.each([
		["dragenter", false],
		["dragover", false],
		["dragenter", true],
		["dragover", true],
	])(
		"reads workspace geometry once per %s (new pane: %s) and refreshes it on the next event",
		async (type, newPane) => {
			const { container, start, addFloatingGroup } = setup();
			if (!newPane) start();
			const geometry = vi.spyOn(container, "getBoundingClientRect");
			for (const [left, top, visible] of [
				[0, 0, true],
				[900, 750, false],
				[680, 490, true],
			] as const) {
				geometry.mockReturnValue(rect(left, top, 1000, 700));
				const event = dragEvent(type, 700, 500);
				if (newPane) {
					Object.defineProperty(event, "dataTransfer", {
						value: { types: ["application/x-dure-new-pane"] },
					});
				}
				window.dispatchEvent(event);
				await flushRecommendation();
				const preview = document.querySelector<HTMLElement>(
					".pane-float-preview",
				);
				expect(event.defaultPrevented).toBe(visible);
				expect(preview !== null).toBe(visible);
				if (visible) {
					expect(preview?.style.left).toBe(`${Math.max(left, 660)}px`);
					expect(preview?.style.top).toBe(`${Math.max(top, 484)}px`);
				}
			}
			window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
			expect(document.querySelector(".pane-float-preview")).toBeNull();
			expect(addFloatingGroup).not.toHaveBeenCalled();
			expect(geometry).toHaveBeenCalledTimes(3);
		},
	);

	it("records pane entry and dragover, then cancels timing without moving the pane", () => {
		const { start, addFloatingGroup } = setup();
		paneDragPerformance.begin();
		window.dispatchEvent(dragEvent("dragover", 700, 500));
		expect(paneDragPerformance.snapshot().recent).toHaveLength(0);
		start();
		window.dispatchEvent(dragEvent("dragenter", 700, 500));
		window.dispatchEvent(dragEvent("dragover", 700, 500));
		expect(paneDragPerformance.snapshot().recent).toHaveLength(2);
		expect(
			paneDragPerformance.snapshot().recent.map((sample) => sample.eventType),
		).toEqual(["dragenter", "dragover"]);
		window.dispatchEvent(dragEvent("dragend", 700, 500));
		expect(paneDragPerformance.snapshot().recent[0]).toMatchObject({
			trusted: false,
			eventAgeMs: null,
			frameProbe: "cancelled",
		});
		expect(addFloatingGroup).not.toHaveBeenCalled();
	});

	it.each([
		["bottom", "Split Down"],
		["top", "Split Up"],
		["left", "Split Left"],
		["right", "Split Right"],
	] as const)(
		"labels external new-pane %s previews and clears them after drop",
		async (position, label) => {
			setLang("en");
			const { container, prepareDockviewOverlay, addFloatingGroup } = setup();
			const nativeEvent = dragEvent("dragover", 700, 500);
			Object.defineProperty(nativeEvent, "dataTransfer", {
				value: { types: ["text/plain", "application/x-dure-new-pane"] },
			});
			window.dispatchEvent(nativeEvent);
			const rendered = prepareDockviewOverlay(position, nativeEvent, true);
			const split = document.createElement("div");
			split.className = "dv-drop-target-selection";
			container.appendChild(split);
			rendered(split);
			await flushRecommendation();
			expect(split.dataset.paneDropIntent).toBe(`split-${position}`);
			expect(split.textContent).toBe(label);
			window.dispatchEvent(dragEvent("drop", 700, 500));
			window.dispatchEvent(dragEvent("dragend", 700, 500));
			expect(split.textContent).toBe("");
			expect(addFloatingGroup).not.toHaveBeenCalled();
		},
	);
	it("does not keep observing inactive workspaces or a cancelled new-pane drag", async () => {
		const { container } = setup();
		const over = (x: number) => {
			const event = dragEvent("dragover", x, 500);
			Object.defineProperty(event, "dataTransfer", {
				value: { types: ["application/x-dure-new-pane"] },
			});
			window.dispatchEvent(event);
		};
		over(700);
		await flushRecommendation();
		expect(document.querySelector(".pane-float-preview")).not.toBeNull();
		over(1200);
		await flushRecommendation();
		expect(document.querySelector(".pane-float-preview")).toBeNull();
		const query = vi.spyOn(container, "querySelectorAll");
		container.appendChild(document.createElement("span"));
		await flushRecommendation();
		expect(query).not.toHaveBeenCalled();
		over(700);
		await flushRecommendation();
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
		expect(document.querySelector(".pane-float-preview")).toBeNull();
		query.mockClear();
		container.appendChild(document.createElement("span"));
		await flushRecommendation();
		expect(query).not.toHaveBeenCalled();
	});

	it("does not discover unaccepted surfaces through workspace mutations", async () => {
		const { container, handlers, start } = setup();
		const querySelectorAll = vi.spyOn(container, "querySelectorAll");

		container.appendChild(document.createElement("span"));
		await flushRecommendation();
		expect(querySelectorAll).not.toHaveBeenCalled();

		start();
		const overlay = document.createElement("div");
		overlay.className = "dv-drop-target-selection";
		container.appendChild(overlay);
		await flushRecommendation();
		expect(querySelectorAll).not.toHaveBeenCalled();
		expect(overlay.dataset.paneDropIntent).toBeUndefined();

		handlers.didMovePanel({} as never);
		querySelectorAll.mockClear();
		container.appendChild(document.createElement("span"));
		await flushRecommendation();
		expect(querySelectorAll).not.toHaveBeenCalled();
	});

	it("does not rescan the workspace for streaming pane content during a drag", async () => {
		const { container, start, showDockviewOverlay } = setup();
		const output = document.createElement("div");
		const split = document.createElement("div");
		split.className = "dv-drop-target-selection";
		container.append(output, split);
		start();
		showDockviewOverlay("bottom", split);
		await flushRecommendation();
		await flushRecommendation();
		const query = vi.spyOn(container, "querySelectorAll");
		const style = vi.spyOn(window, "getComputedStyle");
		for (let frame = 0; frame < 20; frame++) {
			output.textContent = `Working ${frame}`;
			output.className = `terminal-row-${frame % 2}`;
			output.style.opacity = frame % 2 ? "0.9" : "1";
			await flushRecommendation();
		}
		expect(query).not.toHaveBeenCalled();
		expect(style).not.toHaveBeenCalled();
		expect(split.dataset.paneDropIntent).toBe("split-bottom");
	});

	it("labels an accepted anchor during its CSS fade without forcing computed style", async () => {
		const { container, start, showDockviewOverlay } = setup();
		const sheet = document.createElement("style");
		sheet.textContent =
			".dv-drop-target-anchor-container-changed { opacity: 0; }";
		container.append(sheet);
		const anchor = document.createElement("div");
		anchor.className =
			"dv-drop-target-anchor dv-drop-target-anchor-container-changed";
		// Dockview publishes visibility after it has placed the accepted target.
		// Its container-change fade must not delay the label or invent a float.
		anchor.style.visibility = "visible";
		container.append(anchor);
		start();
		const style = vi.spyOn(window, "getComputedStyle");
		window.dispatchEvent(dragEvent("dragover", 700, 500));
		showDockviewOverlay("bottom", anchor);
		await flushRecommendation();
		expect(anchor.dataset.paneDropIntent).toBe("split-bottom");
		expect(
			anchor.querySelector(".pane-drop-recommendation-label"),
		).not.toBeNull();
		expect(document.querySelector(".pane-float-preview")).toBeNull();
		expect(style).not.toHaveBeenCalled();
		anchor.classList.remove("dv-drop-target-anchor-container-changed");
		await flushRecommendation();
		expect(anchor.dataset.paneDropIntent).toBe("split-bottom");
		expect(style).not.toHaveBeenCalled();
	});

	it("labels a nested late render through its owner, without observing mutations", async () => {
		const { container, start, prepareDockviewOverlay } = setup();
		start();
		const rendered = prepareDockviewOverlay("top");
		await flushRecommendation();
		const wrapper = document.createElement("div");
		const split = document.createElement("div");
		split.className = "dv-drop-target-selection";
		split.style.visibility = "hidden";
		wrapper.append(split);
		container.append(wrapper);
		await flushRecommendation();
		expect(split.dataset.paneDropIntent).toBeUndefined();
		split.style.visibility = "visible";
		rendered(split);
		await flushRecommendation();
		expect(split.dataset.paneDropIntent).toBe("split-top");
		const query = vi.spyOn(container, "querySelectorAll");
		await flushRecommendation();
		expect(query).not.toHaveBeenCalled();
		split.classList.add("dv-drop-target-top");
		await flushRecommendation();
		expect(query).not.toHaveBeenCalled();
		query.mockClear();
		wrapper.remove();
		await flushRecommendation();
		expect(query).not.toHaveBeenCalled();
	});

	it("puts a Spaces-initiated move on the same undo stack", () => {
		const { api } = setup();
		const snapshot = { grid: { root: { type: "leaf" } } };
		recordPaneMoveSnapshot(api, snapshot as never);

		expect(undoPaneMove(api)).toBe(true);
		expect(api.fromJSON).toHaveBeenCalledWith(snapshot);
	});

	it("does not recommend floating while the pointer is over its own source pane", async () => {
		const { addFloatingGroup, start } = setup();
		start();
		window.dispatchEvent(dragEvent("dragover", 200, 180));
		await flushRecommendation();

		expect(document.querySelector(".pane-float-preview")).toBeNull();
		window.dispatchEvent(dragEvent("dragend", 200, 180));
		expect(addFloatingGroup).not.toHaveBeenCalled();
	});

	it("previews and creates floating outside the source pane but inside workspace", async () => {
		const { addFloatingGroup, start } = setup();
		start();
		window.dispatchEvent(dragEvent("dragover", 700, 500));
		await flushRecommendation();

		expect(document.querySelector(".pane-float-preview")).not.toBeNull();
		window.dispatchEvent(dragEvent("drop", 700, 500));
		window.dispatchEvent(dragEvent("dragend", 700, 500));
		expect(addFloatingGroup).toHaveBeenCalledWith(
			expect.objectContaining({ id: "agent:codex" }),
			{ x: 660, y: 484, width: 560, height: 420 },
		);
	});

	it("does not recommend or create floating outside the workspace", async () => {
		const { addFloatingGroup, start } = setup();
		start();
		window.dispatchEvent(dragEvent("dragover", 1_200, 800));
		await flushRecommendation();

		expect(document.querySelector(".pane-float-preview")).toBeNull();
		window.dispatchEvent(dragEvent("dragend", 1_200, 800));
		expect(addFloatingGroup).not.toHaveBeenCalled();
	});

	it("does not overlap a Dockview split recommendation with floating", async () => {
		const { container, showDockviewOverlay, start } = setup();
		const split = document.createElement("div");
		split.className = "dv-drop-target-selection";
		container.appendChild(split);
		start();
		window.dispatchEvent(dragEvent("dragover", 700, 500));
		showDockviewOverlay("right", split);
		await flushRecommendation();

		expect(document.querySelector(".pane-float-preview")).toBeNull();
		expect(split.dataset.paneDropIntent).toBe("split-right");
		expect(
			split.querySelector(".pane-drop-recommendation-label")?.textContent,
		).toBe("오른쪽으로 분할");
	});

	it("does not overlap an inner-sash insertion recommendation with floating", async () => {
		const { container, start } = setup();
		const insertion = document.createElement("div");
		insertion.className = "pane-boundary-drop-overlay";
		insertion.dataset.paneDropIntent = "insert-column";
		insertion.style.display = "block";
		container.appendChild(insertion);
		start();
		window.dispatchEvent(dragEvent("dragover", 700, 500));
		await flushRecommendation();

		expect(document.querySelector(".pane-float-preview")).toBeNull();
	});

	it.each(["insert-column", "insert-row"])(
		"skips lower-priority queries during repeated %s hovers and rechecks when hidden",
		async (intent) => {
			const { container, start, showDockviewOverlay } = setup();
			const insertion = document.createElement("div");
			insertion.className = "pane-boundary-drop-overlay";
			insertion.dataset.paneDropIntent = intent;
			const split = document.createElement("div");
			split.className = "dv-drop-target-selection";
			container.append(insertion, split);
			start();
			await flushRecommendation();
			const queryAll = vi.spyOn(container, "querySelectorAll");
			const query = vi.spyOn(container, "querySelector");
			const style = vi.spyOn(window, "getComputedStyle");

			for (let index = 0; index < 20; index++) {
				window.dispatchEvent(dragEvent("dragover", 700, 500 + (index % 2)));
				await flushRecommendation();
			}
			expect(queryAll).toHaveBeenCalledTimes(20);
			expect(
				queryAll.mock.calls.every(
					([selector]) => selector === ".pane-boundary-drop-overlay",
				),
			).toBe(true);
			expect(query).not.toHaveBeenCalled();
			expect(style).not.toHaveBeenCalled();
			expect(document.querySelector(".pane-float-preview")).toBeNull();

			queryAll.mockClear();
			style.mockClear();
			// The insertion owner vetoes the split before its render completes.
			showDockviewOverlay("bottom", split, true);
			await flushRecommendation();
			expect(queryAll).not.toHaveBeenCalled();
			expect(style).not.toHaveBeenCalled();
			expect(split.dataset.paneDropIntent).toBeUndefined();

			insertion.style.display = "none";
			await flushRecommendation();
			expect(split.dataset.paneDropIntent).toBeUndefined();
			window.dispatchEvent(dragEvent("dragover", 700, 500));
			showDockviewOverlay("bottom", split);
			await flushRecommendation();
			expect(split.dataset.paneDropIntent).toBe("split-bottom");
			expect(document.querySelector(".pane-float-preview")).toBeNull();

			split.remove();
			window.dispatchEvent(dragEvent("dragover", 700, 500));
			await flushRecommendation();
			expect(document.querySelector(".pane-float-preview")).not.toBeNull();
			insertion.style.display = "block";
			// Production insertion writes occur during the next captured hover.
			window.dispatchEvent(dragEvent("dragover", 700, 500));
			await flushRecommendation();
			expect(document.querySelector(".pane-float-preview")).toBeNull();
		},
	);

	it("clears the floating recommendation immediately on Escape", async () => {
		const { start } = setup();
		start();
		window.dispatchEvent(dragEvent("dragover", 700, 500));
		await flushRecommendation();
		expect(document.querySelector(".pane-float-preview")).not.toBeNull();

		window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

		expect(document.querySelector(".pane-float-preview")).toBeNull();
	});

	it("treats dragend without a drop as native Escape cancellation", async () => {
		const { addFloatingGroup, container, start } = setup();
		start();
		window.dispatchEvent(dragEvent("dragover", 700, 500));
		await flushRecommendation();

		window.dispatchEvent(dragEvent("dragend", 700, 500));

		expect(document.querySelector(".pane-float-preview")).toBeNull();
		expect(addFloatingGroup).not.toHaveBeenCalled();
		const querySelectorAll = vi.spyOn(container, "querySelectorAll");
		container.appendChild(document.createElement("span"));
		await flushRecommendation();
		expect(querySelectorAll).not.toHaveBeenCalled();
	});
});

describe("float 추천과 dockview 추천의 공존 금지 (사용자 제보 2026-08-02)", () => {
	it("dockview 드롭 추천이 떠 있는 동안엔 float 고스트를 숨긴다", async () => {
		const { container, start } = setup();
		start();
		// 워크스페이스 안·소스 밖 — 평소라면 고스트가 뜨는 지점.
		window.dispatchEvent(dragEvent("dragover", 700, 500));
		await flushRecommendation();
		expect(document.querySelector(".pane-float-preview")).not.toBeNull();
		// dockview가 드롭 추천 표시(dv-drop-target 클래스 부착)를 시작하면
		// 놓았을 때 도킹이 일어나므로 float 고스트는 거짓 약속 — 숨겨야 한다.
		const target = document.createElement("div");
		target.className = "dv-drop-target";
		container.appendChild(target);
		window.dispatchEvent(dragEvent("dragover", 720, 520));
		await flushRecommendation();
		expect(document.querySelector(".pane-float-preview")).toBeNull();
		// 추천이 걷히면 고스트가 되살아난다.
		target.remove();
		window.dispatchEvent(dragEvent("dragover", 700, 500));
		await flushRecommendation();
		expect(document.querySelector(".pane-float-preview")).not.toBeNull();
	});

	it("dockview가 이동을 확정하면(dragend 유실 대비) 고스트를 정리한다", async () => {
		const { start, handlers } = setup();
		start();
		window.dispatchEvent(dragEvent("dragover", 700, 500));
		await flushRecommendation();
		expect(document.querySelector(".pane-float-preview")).not.toBeNull();
		// WebKit은 드롭으로 소스가 재부모화되면 dragend를 안 쏘기도 한다 —
		// didMovePanel 신호만으로도 고스트가 사라져야 한다.
		handlers.didMovePanel({} as never);
		expect(document.querySelector(".pane-float-preview")).toBeNull();
	});

	it("drop 이벤트만으로도 고스트를 정리한다", async () => {
		const { start } = setup();
		start();
		window.dispatchEvent(dragEvent("dragover", 700, 500));
		await flushRecommendation();
		expect(document.querySelector(".pane-float-preview")).not.toBeNull();
		window.dispatchEvent(dragEvent("drop", 700, 500));
		expect(document.querySelector(".pane-float-preview")).toBeNull();
	});
});
