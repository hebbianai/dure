// @vitest-environment jsdom

import { createDockview } from "dockview-react";
import { describe, expect, it, vi } from "vitest";
import { installDockviewSinglePaneActivation } from "@/lib/workspace/dock/dockviewSinglePaneActivation";

function setHeaderActivePanel(
	group: { model: { header: unknown } },
	panel: { id: string },
): void {
	const header = group.model.header as {
		setActivePanel(next: { id: string }): void;
	};
	header.setActivePanel(panel);
}

describe("Dockview single-pane activation", () => {
	it("does not synchronously read tab geometry for a single-pane header", () => {
		const container = document.createElement("div");
		document.body.append(container);
		const api = createDockview(container, {
			createComponent: () => {
				const element = document.createElement("div");
				return {
					element,
					init() {},
					dispose() {
						element.remove();
					},
				};
			},
		});
		const dispose = installDockviewSinglePaneActivation(api);

		api.layout(600, 400);
		const left = api.addPanel({ id: "left", component: "test" });
		const right = api.addPanel({
			id: "right",
			component: "test",
			position: { referencePanel: "left", direction: "right" },
		});
		right.api.setActive();
		expect(api.activePanel?.id).toBe("right");

		const tab = left.group.element.querySelector<HTMLElement>(".dv-tab");
		if (!tab) throw new Error("Dockview did not create the pane tab");
		const strip = tab.parentElement;
		if (!strip) throw new Error("Dockview did not attach the pane tab");
		const tabWidthRead = vi.fn(() => {
			throw new Error("single-pane activation forced a tab width read");
		});
		const stripWidthRead = vi.fn(() => {
			throw new Error("single-pane activation forced a strip width read");
		});
		Object.defineProperty(tab, "clientWidth", {
			configurable: true,
			get: tabWidthRead,
		});
		Object.defineProperty(strip, "clientWidth", {
			configurable: true,
			get: stripWidthRead,
		});

		expect(() => setHeaderActivePanel(left.group, left)).not.toThrow();
		expect(tabWidthRead).not.toHaveBeenCalled();
		expect(stripWidthRead).not.toHaveBeenCalled();

		dispose();
		api.dispose();
		container.remove();
	});

	it("keeps Dockview's overflow geometry path for multi-tab groups", () => {
		const container = document.createElement("div");
		document.body.append(container);
		const api = createDockview(container, {
			createComponent: () => ({
				element: document.createElement("div"),
				init() {},
				dispose() {},
			}),
		});
		const dispose = installDockviewSinglePaneActivation(api);
		const first = api.addPanel({ id: "first", component: "test" });
		const second = api.addPanel({
			id: "second",
			component: "test",
			position: { referencePanel: first, direction: "within" },
		});
		const tab = first.group.element.querySelector<HTMLElement>(".dv-tab");
		if (!tab) throw new Error("Dockview did not create the pane tab");
		const widthRead = vi.fn(() => 100);
		Object.defineProperty(tab, "clientWidth", {
			configurable: true,
			get: widthRead,
		});

		setHeaderActivePanel(first.group, second);
		expect(widthRead).toHaveBeenCalled();

		dispose();
		api.dispose();
		container.remove();
	});
});
