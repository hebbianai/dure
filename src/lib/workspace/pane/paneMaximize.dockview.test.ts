// @vitest-environment jsdom
import { createDockview, type DockviewApi } from "dockview-react";
import { afterEach, describe, expect, it } from "vitest";
import {
	autoSplitPosition,
	rightRailPosition,
} from "@/lib/workspace/dock/gridPanePlacement";
import {
	restoreMaximizedPane,
	toggleMaximizedPane,
} from "@/lib/workspace/pane/paneMaximize";
import {
	addPanePreservingSizes,
	removePanePreservingSizes,
} from "@/lib/workspace/pane/paneMutationSizing";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

/** a | (b over c): a 400 wide, b 800×500, c 800×300. */
function fixture(): DockviewApi {
	const container = document.createElement("div");
	document.body.append(container);
	const api = createDockview(container, {
		createComponent: () => ({
			element: document.createElement("div"),
			init() {},
		}),
	});
	cleanups.push(() => {
		api.dispose();
		container.remove();
	});
	api.layout(1200, 800);
	api.addPanel({ id: "a", component: "terminal" });
	api.addPanel({
		id: "b",
		component: "terminal",
		position: { referencePanel: "a", direction: "right" },
	});
	api.addPanel({
		id: "c",
		component: "terminal",
		position: { referencePanel: "b", direction: "below" },
	});
	api.getPanel("a")!.group.api.setSize({ width: 400 });
	api.getPanel("b")!.group.api.setSize({ height: 500 });
	return api;
}

function sizes(api: DockviewApi) {
	return api.panels.map(({ id, group }) => ({
		id,
		width: group.api.width,
		height: group.api.height,
	}));
}

function visiblePanes(api: DockviewApi): string[] {
	return api.panels
		.filter((panel) => panel.group.api.isVisible)
		.map((panel) => panel.id)
		.sort();
}

describe("maximize a pane", () => {
	it("covers the whole layout and restores the rest unchanged", () => {
		const api = fixture();
		const before = sizes(api);
		const b = api.getPanel("b")!;

		expect(toggleMaximizedPane(api, b)).toBe(true);
		expect(b.api.isMaximized()).toBe(true);
		expect(api.activePanel?.id).toBe("b");
		expect(visiblePanes(api)).toEqual(["b"]);
		expect([b.group.api.width, b.group.api.height]).toEqual([1200, 800]);

		expect(toggleMaximizedPane(api, b)).toBe(true);
		expect(api.hasMaximizedGroup()).toBe(false);
		expect(visiblePanes(api)).toEqual(["a", "b", "c"]);
		expect(sizes(api)).toEqual(before);
	});

	it("toggles the active pane and restores whichever pane is maximized", () => {
		const api = fixture();
		api.getPanel("a")!.api.setActive();
		expect(restoreMaximizedPane(api)).toBe(false);

		expect(toggleMaximizedPane(api)).toBe(true);
		expect(api.getPanel("a")!.api.isMaximized()).toBe(true);
		expect(toggleMaximizedPane(api, api.getPanel("c"))).toBe(true);
		expect(api.hasMaximizedGroup()).toBe(false);

		toggleMaximizedPane(api);
		expect(restoreMaximizedPane(api)).toBe(true);
		expect(api.hasMaximizedGroup()).toBe(false);
	});

	it("keeps a pane the user hid hidden after restore", () => {
		const api = fixture();
		api.getPanel("c")!.group.api.setVisible(false);

		toggleMaximizedPane(api, api.getPanel("a"));
		restoreMaximizedPane(api);

		expect(visiblePanes(api)).toEqual(["a", "b"]);
	});

	it("does not maximize a floating pane", () => {
		const api = fixture();
		const floating = api.addPanel({
			id: "f",
			component: "terminal",
			floating: { width: 300, height: 200 },
		});

		expect(toggleMaximizedPane(api, floating)).toBe(false);
		expect(api.hasMaximizedGroup()).toBe(false);
	});
});

describe("pane changes while a pane is maximized", () => {
	it("restores before placement measures where a new pane goes", () => {
		const api = fixture();
		api.getPanel("a")!.api.setActive();
		const split = autoSplitPosition(api);
		const rail = rightRailPosition(api);

		toggleMaximizedPane(api, api.getPanel("a"));
		expect(autoSplitPosition(api)).toEqual(split);
		expect(api.hasMaximizedGroup()).toBe(false);

		toggleMaximizedPane(api, api.getPanel("a"));
		expect(rightRailPosition(api)).toEqual(rail);
		expect(api.hasMaximizedGroup()).toBe(false);
	});

	it.each([
		[
			"a background tab",
			{
				position: { referencePanel: "c", direction: "within" },
				inactive: true,
			},
		],
		["a floating pane", { floating: { width: 300, height: 200 } }],
	])(
		"restores before opening %s so nothing lands behind it",
		(_, placement) => {
			const api = fixture();
			toggleMaximizedPane(api, api.getPanel("a"));

			const opened = addPanePreservingSizes(api, {
				id: "d",
				component: "terminal",
				...placement,
			});

			expect(api.hasMaximizedGroup()).toBe(false);
			expect(opened.group.api.isVisible).toBe(true);
			expect(visiblePanes(api)).toContain("a");
		},
	);

	it("restores before closing a pane", () => {
		const api = fixture();
		const floating = api.addPanel({
			id: "f",
			component: "terminal",
			floating: { width: 300, height: 200 },
		});
		toggleMaximizedPane(api, api.getPanel("a"));

		removePanePreservingSizes(api, floating);

		expect(api.hasMaximizedGroup()).toBe(false);
		expect(visiblePanes(api)).toEqual(["a", "b", "c"]);
	});

	it("keeps the maximized slot when its content is replaced in place", () => {
		const api = fixture();
		const a = api.getPanel("a")!;
		toggleMaximizedPane(api, a);

		const replaced = addPanePreservingSizes(api, {
			id: a.id,
			component: "agent",
			replacement: a.api,
		});

		expect(replaced.api.component).toBe("agent");
		expect(replaced.api.isMaximized()).toBe(true);
		expect(visiblePanes(api)).toEqual(["a"]);
	});
});
