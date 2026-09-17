// @vitest-environment jsdom
import { createDockview } from "dockview-react";
import { afterEach, expect, it, vi } from "vitest";
import { DURE_NEW_PANE_DRAG_TYPE } from "@/lib/platform/productDragPayload";
import { installPaneDragBehaviors } from "@/lib/workspace/pane/paneDragBehaviors";

afterEach(() => vi.restoreAllMocks());

it.each(["relative", "absolute"] as const)(
	"projects accepted %s renders without rediscovering them across streamed content",
	async (mounting) => {
		const root = document.createElement("div");
		document.body.append(root);
		const terminal = document.createElement("section");
		const run = document.createElement("span");
		terminal.append(run);
		const api = createDockview(root, {
			theme: {
				name: "test",
				className: "dockview-theme-abyss",
				dndOverlayMounting: mounting,
			},
			createComponent: () => ({ element: terminal, init() {} }),
		});
		api.layout(1000, 600);
		const panel = api.addPanel({ id: "target", component: "terminal" });
		panel.group.api.locked = true;
		const stop = installPaneDragBehaviors(api, () => root);
		const acceptance = api.onUnhandledDragOver((event) => event.accept());
		vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(1000);
		vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
			new DOMRect(0, 0, 1000, 600),
		);
		const scans = vi.spyOn(root, "querySelectorAll");
		const hover = (y: number) => {
			const event = new MouseEvent("dragover", {
				bubbles: true,
				cancelable: true,
				clientX: 500,
				clientY: y,
			});
			Object.defineProperty(event, "dataTransfer", {
				value: { types: [DURE_NEW_PANE_DRAG_TYPE], dropEffect: "none" },
			});
			terminal.dispatchEvent(event);
			expect(event.defaultPrevented).toBe(true);
		};
		try {
			for (const [y, intent] of [
				[560, "split-bottom"],
				[40, "split-top"],
				[560, "split-bottom"],
			] as const) {
				hover(y);
				await Promise.resolve();
				const overlay = root.querySelector<HTMLElement>(
					mounting === "relative"
						? ".dv-drop-target-selection"
						: ".dv-drop-target-anchor",
				);
				expect(overlay?.dataset.paneDropIntent).toBe(intent);
				expect(
					overlay?.querySelector(".pane-drop-recommendation-label")
						?.textContent,
				).toBeTruthy();
				run.className = intent;
				run.textContent = intent;
				await Promise.resolve();
			}
			expect(scans).not.toHaveBeenCalled();
		} finally {
			window.dispatchEvent(new MouseEvent("dragend"));
			stop();
			acceptance.dispose();
			api.dispose();
			root.remove();
			await Promise.resolve();
		}
	},
);

it.each(["relative", "absolute"] as const)(
	"does not publish a %s label if disposed by a later will-show listener",
	async (mounting) => {
		const root = document.createElement("div");
		document.body.append(root);
		const terminal = document.createElement("section");
		const api = createDockview(root, {
			theme: {
				name: "test",
				className: "dockview-theme-abyss",
				dndOverlayMounting: mounting,
			},
			createComponent: () => ({ element: terminal, init() {} }),
		});
		api.layout(1000, 600);
		const panel = api.addPanel({ id: "target", component: "terminal" });
		panel.group.api.locked = true;
		const stop = installPaneDragBehaviors(api, () => root);
		api.onUnhandledDragOver((event) => event.accept());
		api.onWillShowOverlay(() => stop());
		vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(1000);
		vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
			new DOMRect(0, 0, 1000, 600),
		);
		try {
			const event = new MouseEvent("dragover", {
				bubbles: true,
				cancelable: true,
				clientX: 500,
				clientY: 560,
			});
			Object.defineProperty(event, "dataTransfer", {
				value: { types: [DURE_NEW_PANE_DRAG_TYPE], dropEffect: "none" },
			});
			terminal.dispatchEvent(event);
			await Promise.resolve();
			expect(event.defaultPrevented).toBe(true);
			expect(
				root.querySelector(".dv-drop-target-selection, .dv-drop-target-anchor"),
			).not.toBeNull();
			expect(root.querySelector(".pane-drop-recommendation-label")).toBeNull();
			expect(root.hasAttribute("data-pane-drag-active")).toBe(false);
		} finally {
			window.dispatchEvent(new MouseEvent("dragend"));
			api.dispose();
			root.remove();
			await Promise.resolve();
		}
	},
);
