// @vitest-environment jsdom
import { createDockview } from "dockview-react";
import { describe, expect, it, vi } from "vitest";
import {
	TerminalPresentationRoleStore,
	terminalPresentationSetReady,
} from "./terminalPresentationRoleStore";

describe("TerminalPresentationRoleStore", () => {
	it("notifies only the old and new foreground panes", () => {
		const store = new TerminalPresentationRoleStore();
		store.configure({ active: true, foregroundPanelId: "term:one" });
		const one = vi.fn();
		const two = vi.fn();
		const background = vi.fn();
		store.subscribeRole("term:one", one);
		store.subscribeRole("term:two", two);
		store.subscribeRole("term:background", background);

		store.configure({ active: true, foregroundPanelId: "term:two" });

		expect(one).toHaveBeenCalledOnce();
		expect(two).toHaveBeenCalledOnce();
		expect(background).not.toHaveBeenCalled();
	});

	it("promotes only the hovered background pane without changing foreground", () => {
		const store = new TerminalPresentationRoleStore();
		store.configure({ active: true, foregroundPanelId: "term:focused" });
		const focused = vi.fn();
		const first = vi.fn();
		const second = vi.fn();
		store.subscribeRole("term:focused", focused);
		store.subscribeRole("term:first", first);
		store.subscribeRole("term:second", second);

		store.setHovered("term:first", true);
		expect(store.role("term:focused")).toBe("foreground");
		expect(store.role("term:first")).toBe("hovered");
		expect(focused).not.toHaveBeenCalled();
		expect(first).toHaveBeenCalledOnce();

		store.setHovered("term:second", true);
		expect(store.role("term:first")).toBe("background");
		expect(store.role("term:second")).toBe("hovered");
		expect(first).toHaveBeenCalledTimes(2);
		expect(second).toHaveBeenCalledOnce();
	});

	it("projects detached and inactive panes without a second state path", () => {
		const store = new TerminalPresentationRoleStore();
		expect(store.role(undefined)).toBe("ungated");
		store.configure({ active: false, foregroundPanelId: "term:one" });
		expect(store.role("term:one")).toBe("background");
		store.configure({ active: true, foregroundPanelId: "term:one" });
		expect(store.role("term:one")).toBe("foreground");
		expect(store.role("term:two")).toBe("background");
	});
});

describe("terminalPresentationSetReady", () => {
	it("waits only for visible terminal presentations", () => {
		const hasExpected = vi.fn(
			(panelIds: readonly string[]) =>
				panelIds.length === 1 && panelIds[0] === "term:visible",
		);
		expect(
			terminalPresentationSetReady(
				[
					{
						id: "term:visible",
						api: { component: "terminal", isVisible: true },
					},
					{ id: "agent:hidden", api: { component: "agent", isVisible: false } },
					{
						id: "file:visible",
						api: { component: "fileviewer", isVisible: true },
					},
				],
				hasExpected,
				false,
			),
		).toBe(true);
		expect(hasExpected).toHaveBeenCalledWith(["term:visible"]);
	});

	it("lets the existing workspace deadline complete an empty set", () => {
		expect(terminalPresentationSetReady([], () => false, true)).toBe(true);
	});
});

describe.each(["slot", "agent:previous", "launcher:previous", "term:previous"])(
	"presentation readiness for %s",
	(id) => {
		it.each(["agent", "terminal", "ssh", "browser"])(
			"collects the actual %s component, not the initial spelling",
			(component) => {
				const element = document.createElement("div");
				document.body.append(element);
				const api = createDockview(element, {
					createComponent: () => ({
						element: document.createElement("div"),
						init() {},
					}),
				});
				try {
					api.layout(900, 600);
					api.addPanel({ id, component });
					const has = vi.fn(() => false);
					expect(terminalPresentationSetReady(api.panels, has, false)).toBe(
						false,
					);
					expect(has).toHaveBeenCalledWith(component === "browser" ? [] : [id]);
				} finally {
					api.dispose();
					element.remove();
				}
			},
		);
	},
);
