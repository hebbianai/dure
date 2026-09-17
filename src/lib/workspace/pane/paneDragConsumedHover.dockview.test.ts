// @vitest-environment jsdom
import { createDockview } from "dockview-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DURE_NEW_PANE_DRAG_TYPE } from "@/lib/platform/productDragPayload";

afterEach(() => vi.restoreAllMocks());

describe("consumed Dockview hover geometry", () => {
	it.each([
		{ type: "dragenter", mounting: "relative" },
		{ type: "dragover", mounting: "relative" },
		{ type: "dragenter", mounting: "absolute" },
		{ type: "dragover", mounting: "absolute" },
	] as const)(
		"does not remeasure a child after accepting a $mounting root-edge $type",
		({ type, mounting }) => {
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
			api.onUnhandledDragOver((e) => e.accept());
			const accepted = vi.fn();
			api.onWillShowOverlay(accepted);
			const readsAfterAcceptance: string[] = [];
			vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(
				function (this: HTMLElement) {
					if (accepted.mock.calls.length) {
						readsAfterAcceptance.push(`width: ${this.className}`);
					}
					return 1000;
				},
			);
			vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
				function (this: HTMLElement) {
					if (accepted.mock.calls.length) {
						readsAfterAcceptance.push(`height: ${this.className}`);
					}
					return 600;
				},
			);
			vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
				new DOMRect(0, 0, 1000, 600),
			);
			const content = panel.group.element.querySelector<HTMLElement>(
				".dv-content-container",
			)!;
			const transfer = { types: [DURE_NEW_PANE_DRAG_TYPE], dropEffect: "none" };
			const event = (name: string, y = 599) => {
				const result = new MouseEvent(name, {
					bubbles: true,
					cancelable: true,
					clientX: 500,
					clientY: y,
				});
				Object.defineProperty(result, "dataTransfer", { value: transfer });
				return result;
			};
			try {
				content.dispatchEvent(event(type, 560));
				expect(accepted.mock.calls[0][0].group).toBe(panel.group);
				accepted.mockClear();
				readsAfterAcceptance.length = 0;
				content.dispatchEvent(event(type));
				expect(accepted).toHaveBeenCalledOnce();
				expect(accepted.mock.calls[0][0].position).toBe("bottom");
				expect(accepted.mock.calls[0][0].kind).toBe("edge");
				expect(accepted.mock.calls[0][0].group).toBeUndefined();
				const overlay = container.querySelector<HTMLElement>(
					mounting === "relative"
						? ".dv-drop-target-selection"
						: ".dv-drop-target-anchor",
				);
				expect(overlay?.style.visibility).toBe("visible");
				if (mounting === "relative") {
					expect(content.querySelector(".dv-drop-target-selection")).toBeNull();
				}
				const redundantReads = [...readsAfterAcceptance];
				const dropped = vi.fn();
				api.onDidDrop(dropped);
				content.dispatchEvent(event("drop"));
				expect(dropped).toHaveBeenCalledOnce();
				expect(dropped.mock.calls[0][0].position).toBe("bottom");
				expect(dropped.mock.calls[0][0].group).toBeUndefined();
				// Root capture has already accepted this hover and written its preview.
				// A child must not flush that write before rejecting the consumed event.
				expect(redundantReads).toEqual([]);
			} finally {
				window.dispatchEvent(new MouseEvent("dragend", { bubbles: true }));
				api.dispose();
				container.remove();
			}
		},
	);
});
