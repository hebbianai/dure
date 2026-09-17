// @vitest-environment jsdom
import { createDockview, getPanelData } from "dockview-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	DURE_NEW_PANE_DRAG_TYPE,
	readDragTypes,
} from "@/lib/platform/productDragPayload";
import { installPaneDragBehaviors } from "./paneDragBehaviors";
import { installInteriorBoundaryDrop } from "./paneInsertionDrop";

afterEach(() => vi.restoreAllMocks());

describe("installed Dockview drag entry", () => {
	it.each([
		{ type: "dragenter", recommendations: false },
		{ type: "dragover", recommendations: false },
		{ type: "dragenter", recommendations: true },
		{ type: "dragover", recommendations: true },
	])(
		"uses the active local transfer for $type without native type reads (recommendations=$recommendations)",
		async ({ type, recommendations }) => {
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
			let draggedPanelId: string | null = null;
			api.onWillDragPanel((e) => {
				draggedPanelId = e.panel.id;
			});
			const stop = installInteriorBoundaryDrop({
				api,
				container,
				draggedPanelId: () => draggedPanelId,
				dropNewPane: vi.fn(),
			});
			const stopBehaviors = recommendations
				? installPaneDragBehaviors(api, () => container)
				: () => {};
			vi.spyOn(container, "getBoundingClientRect").mockReturnValue(
				new DOMRect(0, 0, 1000, 600),
			);
			const readTypes = vi.fn(() => ["application/x-dure-pane"]);
			const dataTransfer = {
				get types() {
					return readTypes();
				},
				items: [],
				setData: vi.fn(),
				setDragImage: vi.fn(),
				dropEffect: "none",
			};
			const event = (name: string) => {
				const e = new MouseEvent(name, {
					bubbles: true,
					cancelable: true,
					clientX: a.group.api.width,
					clientY: 300,
				});
				Object.defineProperty(e, "dataTransfer", { value: dataTransfer });
				return e;
			};
			const tab = source.group.element.querySelector<HTMLElement>(".dv-tab")!;
			try {
				tab.dispatchEvent(event("dragstart"));
				expect(getPanelData()).toMatchObject({
					viewId: api.id,
					panelId: source.id,
					groupId: source.group.id,
				});
				if (!recommendations) {
					readTypes.mockReturnValue(["Files"]);
					for (const id of [null, "a", "missing"]) {
						draggedPanelId = id;
						readTypes.mockClear();
						const unrelated = event(type);
						container.dispatchEvent(unrelated);
						expect(unrelated.defaultPrevented).toBe(false);
						expect(readTypes).toHaveBeenCalledOnce();
					}
					draggedPanelId = source.id;
					const foreignView = vi
						.spyOn(api, "id", "get")
						.mockReturnValue("other-workspace");
					readTypes.mockClear();
					const foreign = event(type);
					container.dispatchEvent(foreign);
					expect(foreign.defaultPrevented).toBe(false);
					expect(readTypes).toHaveBeenCalledOnce();
					foreignView.mockRestore();
				}
				readTypes.mockReturnValue(["application/x-dure-pane"]);
				readTypes.mockClear();
				const hover = event(type);
				container.dispatchEvent(hover);
				expect(hover.defaultPrevented).toBe(true);
				expect(
					container.querySelector<HTMLElement>(".pane-boundary-drop-overlay")
						?.dataset.paneDropIntent,
				).toBe("insert-column");
				expect(dataTransfer.dropEffect).toBe("move");
				expect(readTypes).not.toHaveBeenCalled();
				container.dispatchEvent(event("drop"));
				expect(getPanelData()).toBeUndefined();
				expect(api.toJSON().grid).toMatchObject({
					root: {
						data: [
							{ data: { views: ["a"] } },
							{ data: { views: ["source"] } },
							{ data: { views: ["b"] } },
						],
					},
				});
				tab.dispatchEvent(event("dragend"));
				await new Promise((resolve) => setTimeout(resolve, 0));
				expect(getPanelData()).toBeUndefined();
				// Keep the callback stale on purpose: file hover still needs native
				// validation after Dockview retires its own transfer.
				expect(draggedPanelId).toBe(source.id);
				readTypes.mockReturnValue(["Files"]).mockClear();
				const files = event(type);
				container.dispatchEvent(files);
				expect(files.defaultPrevented).toBe(false);
				expect(readTypes).toHaveBeenCalledOnce();
			} finally {
				tab.dispatchEvent(event("dragend"));
				await new Promise((resolve) => setTimeout(resolve, 0));
				stop();
				stopBehaviors();
				api.dispose();
				container.remove();
			}
			expect(getPanelData()).toBeUndefined();
		},
	);

	it.each([
		{ type: "dragenter", mounting: "relative" },
		{ type: "dragover", mounting: "relative" },
		{ type: "dragenter", mounting: "absolute" },
		{ type: "dragover", mounting: "absolute" },
	] as const)(
		"accepts and labels a $mounting split on the first $type without another pointer event",
		async ({ type, mounting }) => {
			const container = document.createElement("div");
			document.body.append(container);
			const api = createDockview(container, {
				theme: {
					name: "test",
					className: "dockview-theme-abyss",
					dndOverlayMounting: mounting,
				},
				createComponent: () => ({
					element: document.createElement("div"),
					init() {},
				}),
			});
			api.layout(1000, 600);
			const panel = api.addPanel({ id: "target", component: "test" });
			panel.group.api.locked = true;
			const stop = installPaneDragBehaviors(api, () => container);
			const stopInsertion = installInteriorBoundaryDrop({
				api,
				container,
				draggedPanelId: () => null,
				dropNewPane: vi.fn(),
			});
			api.onUnhandledDragOver((e) => {
				if (
					"dataTransfer" in e.nativeEvent &&
					readDragTypes(e.nativeEvent).includes("Files")
				)
					return;
				e.accept();
			});
			vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(
				1000,
			);
			vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(
				600,
			);
			vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
				new DOMRect(0, 0, 1000, 600),
			);
			try {
				const style = vi.spyOn(window, "getComputedStyle");
				const content = panel.group.element.querySelector(
					".dv-content-container",
				)!;
				const event = new MouseEvent(type, {
					bubbles: true,
					cancelable: true,
					clientX: 500,
					clientY: 560,
				});
				const readTypes = vi.fn(() => [DURE_NEW_PANE_DRAG_TYPE]);
				const transfer = {
					get types() {
						return readTypes();
					},
					dropEffect: "none",
				};
				Object.defineProperty(event, "dataTransfer", { value: transfer });
				content.dispatchEvent(event);
				await Promise.resolve();
				expect(event.defaultPrevented).toBe(true);
				expect(transfer.dropEffect).toBe("copy");
				const overlay = container.querySelector<HTMLElement>(
					mounting === "relative"
						? ".dv-drop-target-selection"
						: ".dv-drop-target-anchor",
				);
				expect(overlay?.style.visibility).toBe("visible");
				expect(overlay?.dataset.paneDropIntent).toBe("split-bottom");
				expect(
					style.mock.calls.filter(([element]) => element === overlay),
				).toHaveLength(0);
				// Recommendation and insertion see the same native hover event.
				expect(readTypes).toHaveBeenCalledTimes(1);
				const dropped = vi.fn();
				api.onDidDrop(dropped);
				// Native cancellation ends at the source, not at this hovered target.
				window.dispatchEvent(new MouseEvent("dragend", { bubbles: true }));
				expect(
					container.querySelector(
						".dv-drop-target-selection, .dv-drop-target-anchor",
					),
				).toBeNull();
				expect(dropped).not.toHaveBeenCalled();
				// The next gesture still accepts the target and commits its own drop.
				const next = new MouseEvent(type, {
					bubbles: true,
					cancelable: true,
					clientX: 500,
					clientY: 560,
				});
				Object.defineProperty(next, "dataTransfer", { value: transfer });
				content.dispatchEvent(next);
				await Promise.resolve();
				const drop = new MouseEvent("drop", {
					bubbles: true,
					cancelable: true,
					clientX: 500,
					clientY: 560,
				});
				Object.defineProperty(drop, "dataTransfer", { value: transfer });
				content.dispatchEvent(drop);
				expect(dropped).toHaveBeenCalledOnce();
				expect(
					container.querySelector(".pane-drop-recommendation-label"),
				).toBeNull();
			} finally {
				stopInsertion();
				stop();
				api.dispose();
				container.remove();
			}
		},
	);
});
