// @vitest-environment jsdom
import { createDockview } from "dockview-react";
import { afterEach, expect, it, vi } from "vitest";
import { installPaneDragBehaviors } from "./paneDragBehaviors";
import {
	detectGridInsertionSurface,
	installInteriorBoundaryDrop,
} from "./paneInsertionDrop";

afterEach(() => vi.restoreAllMocks());

it.each([
	"collapsed branch",
	"resized container",
	"pointer left boundary",
	"source changed",
])(
	"preserves panes when the hovered insertion is stale: %s",
	async (change) => {
		const container = document.createElement("div");
		document.body.append(container);
		const disposed = vi.fn();
		const api = createDockview(container, {
			createComponent: () => ({
				element: document.createElement("div"),
				init() {},
				dispose: disposed,
			}),
		});
		api.layout(1000, 600);
		const a = api.addPanel({ id: "a", component: "test" });
		const source = api.addPanel({
			id: "source",
			component: "test",
			position: { referencePanel: a, direction: "right" },
		});
		const b = api.addPanel({
			id: "b",
			component: "test",
			position: { referencePanel: a, direction: "below" },
		});
		const box = vi
			.spyOn(container, "getBoundingClientRect")
			.mockReturnValue(new DOMRect(0, 0, 1000, 600));
		let draggedId = source.id;
		const stop = installInteriorBoundaryDrop({
			api,
			container,
			draggedPanelId: () => draggedId,
		});
		const stopBehaviors = installPaneDragBehaviors(api, () => container);
		const tab = source.group.element.querySelector<HTMLElement>(".dv-tab")!;
		const dataTransfer = {
			types: ["application/x-dure-pane"],
			items: [],
			setData() {},
			setDragImage() {},
			dropEffect: "none",
		};
		const event = (type: string, x = 100, y = a.group.api.height) => {
			const e = new MouseEvent(type, {
				bubbles: true,
				cancelable: true,
				clientX: x,
				clientY: y,
			});
			Object.defineProperty(e, "dataTransfer", { value: dataTransfer });
			return e;
		};
		const errors: string[] = [];
		const onError = (e: ErrorEvent) => {
			errors.push(e.message);
			e.preventDefault();
		};
		window.addEventListener("error", onError);
		try {
			tab.dispatchEvent(event("dragstart"));
			const hover = event("dragover");
			container.dispatchEvent(hover);
			expect(
				container.querySelector<HTMLElement>(".pane-boundary-drop-overlay")
					?.style.display,
			).toBe("block");
			if (change === "collapsed branch") api.removePanel(b);
			if (change === "resized container")
				box.mockReturnValue(new DOMRect(0, 0, 2000, 1200));
			if (change === "source changed") draggedId = a.id;
			const before = api.toJSON();
			const drop = event(
				"drop",
				change === "pointer left boundary" ? 700 : hover.clientX,
				hover.clientY,
			);
			container.dispatchEvent(drop);
			tab.dispatchEvent(event("dragend", drop.clientX, drop.clientY));
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(errors).toEqual([]);
			expect(api.toJSON()).toEqual(before);
			expect(api.getPanel(source.id)).toBe(source);
			expect(api.getPanel(a.id)).toBe(a);
			expect(disposed).toHaveBeenCalledTimes(
				change === "collapsed branch" ? 1 : 0,
			);
		} finally {
			window.removeEventListener("error", onError);
			stop();
			stopBehaviors();
			api.dispose();
			container.remove();
		}
	},
);

it("retains a moved pane when the insertion surface fails after relocating it", () => {
	const container = document.createElement("div");
	document.body.append(container);
	const api = createDockview(container, {
		createComponent: () => ({
			element: document.createElement("div"),
			init() {},
		}),
	});
	api.layout(1000, 600);
	const a = api.addPanel({ id: "a", component: "test" });
	const b = api.addPanel({
		id: "b",
		component: "test",
		position: { referencePanel: a, direction: "right" },
	});
	const source = api.addPanel({
		id: "source",
		component: "test",
		position: { referencePanel: b, direction: "right" },
	});
	vi.spyOn(container, "getBoundingClientRect").mockReturnValue(
		new DOMRect(0, 0, 1000, 600),
	);
	const stop = installInteriorBoundaryDrop({
		api,
		container,
		draggedPanelId: () => source.id,
	});
	const surface = detectGridInsertionSurface(api)!;
	const move = surface.moveGroupOrPanel.bind(surface);
	vi.spyOn(surface, "moveGroupOrPanel").mockImplementation((options) => {
		move(options);
		throw new Error("late insertion failure");
	});
	const event = (type: string) => {
		const e = new MouseEvent(type, {
			bubbles: true,
			cancelable: true,
			clientX: a.group.api.width,
			clientY: 300,
		});
		Object.defineProperty(e, "dataTransfer", {
			value: { types: ["application/x-dure-pane"] },
		});
		return e;
	};
	const errors: string[] = [];
	const onError = (e: ErrorEvent) => {
		errors.push(e.message);
		e.preventDefault();
	};
	window.addEventListener("error", onError);
	try {
		container.dispatchEvent(event("dragover"));
		container.dispatchEvent(event("drop"));
		expect(errors).toEqual(["late insertion failure"]);
		expect(api.getPanel(source.id)).toBe(source);
		expect(api.groups.every((group) => group.panels.length === 1)).toBe(true);
	} finally {
		window.removeEventListener("error", onError);
		stop();
		api.dispose();
		container.remove();
	}
});
