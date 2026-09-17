// @vitest-environment jsdom
import { createDockview, getPanelData } from "dockview-react";
import { describe, expect, it, vi } from "vitest";

describe.each(["panel", "group"] as const)(
	"installed Dockview %s drag retirement",
	(kind) => {
		it.each([
			...["none", "move", "copy", "link", "all", null].map((dropEffect) => ({
				dropEffect,
				propagation: "window",
			})),
			...["stopped", "detached", "successor"].map((propagation) => ({
				dropEffect: "all",
				propagation,
			})),
		])(
			"retires $dropEffect through $propagation without invalidating drop consumers",
			async ({ dropEffect, propagation }) => {
				const container = document.createElement("div");
				document.body.append(container);
				const api = createDockview(container, {
					createComponent: () => ({
						element: document.createElement("div"),
						init() {},
					}),
				});
				api.layout(1000, 600);
				const source = api.addPanel({ id: "source", component: "test" });
				const tab = source.group.element.querySelector<HTMLElement>(
					kind === "panel" ? ".dv-tab" : ".dv-void-container",
				)!;
				const transfer = {
					items: [],
					setData: vi.fn(),
					setDragImage: vi.fn(),
					dropEffect,
				};
				const event = (type: string) => {
					const e = new MouseEvent(type, { bubbles: true, cancelable: true });
					Object.defineProperty(e, "dataTransfer", {
						value: type === "dragend" && dropEffect === null ? null : transfer,
					});
					return e;
				};
				const completed = vi.fn(() => getPanelData());
				window.addEventListener("dragend", completed);
				const stop = (event: Event) => event.stopPropagation();
				if (propagation === "stopped" || propagation === "successor")
					document.addEventListener("dragend", stop);
				if (propagation === "detached") container.remove();
				try {
					tab.dispatchEvent(event("dragstart"));
					const active = getPanelData();
					expect(active).toMatchObject({
						viewId: api.id,
						panelId: kind === "panel" ? source.id : null,
					});
					tab.dispatchEvent(event("dragend"));
					// Native dropEffect is not cancellation authority: WebKit can
					// report "all" even when Escape cancels a trusted drag.
					if (propagation === "window") {
						expect(completed).toHaveReturnedWith(active);
						expect(getPanelData()).toBeUndefined();
					} else {
						expect(completed).not.toHaveBeenCalled();
						expect(getPanelData()).toBe(active);
						if (propagation !== "successor") {
							await new Promise((resolve) => setTimeout(resolve, 0));
							expect(getPanelData()).toBeUndefined();
						}
					}
					// No deferred cancellation may erase the next transfer.
					tab.dispatchEvent(event("dragstart"));
					const successor = getPanelData();
					expect(successor).toBeDefined();
					expect(successor).not.toBe(active);
					await new Promise((resolve) => setTimeout(resolve, 0));
					expect(getPanelData()).toBe(successor);
				} finally {
					document.removeEventListener("dragend", stop);
					tab.dispatchEvent(event("dragend"));
					await new Promise((resolve) => setTimeout(resolve, 0));
					window.removeEventListener("dragend", completed);
					api.dispose();
					container.remove();
				}
			},
		);
	},
);
