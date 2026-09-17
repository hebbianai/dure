// @vitest-environment jsdom
import { createDockview } from "dockview-react";
import { afterEach, describe, expect, it } from "vitest";
import {
	addPanePreservingSizes,
	removePanePreservingSizes,
} from "./paneMutationSizing";
import { openSplitLauncherOn } from "./paneSplit";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function fixture(direction: "right" | "below") {
	const container = document.createElement("div");
	document.body.append(container);
	const api = createDockview(container, {
		createComponent: () => ({
			element: document.createElement("input"),
			init() {},
		}),
	});
	cleanups.push(() => {
		api.dispose();
		container.remove();
	});
	api.layout(1200, 800);
	const source = addPanePreservingSizes(api, {
		id: "source",
		component: "terminal",
	});
	const sibling = addPanePreservingSizes(api, {
		id: "sibling",
		component: "terminal",
		position: { referencePanel: "source", direction: "right" },
	});
	const launcher = addPanePreservingSizes(api, {
		id: "launcher:chosen",
		component: "launcher",
		params: { cwd: "/repo" },
		position: { referencePanel: "source", direction },
	});
	return { api, source, sibling, launcher };
}

describe("launching inside a split selector", () => {
	it("issues a content-neutral identity once for each new split", () => {
		const { api, source, sibling } = fixture("right");
		const before = api.panels.map((panel) => panel.id);
		for (let split = 0; split < 2; split += 1) {
			openSplitLauncherOn(
				api,
				{ kind: "local", cwd: "/repo" },
				{ referencePanel: source.id, direction: "below" },
			);
		}
		const created = api.panels.filter((panel) => !before.includes(panel.id));
		expect(created).toHaveLength(2);
		expect(created[0].id).not.toBe(created[1].id);
		for (const pane of created) {
			expect(pane.id).not.toMatch(/^(agent|term|terminal|launcher):/);
			expect(pane.api.component).toBe("launcher");
			expect(pane.params).toEqual({ cwd: "/repo" });
		}
		expect(api.getPanel(source.id)).toBe(source);
		expect(api.getPanel(sibling.id)).toBe(sibling);
	});

	it.each(["right", "below"] as const)(
		"replaces only the selector after a %s split, including after restore",
		(direction) => {
			const { api } = fixture(direction);
			api.fromJSON(api.toJSON());
			const source = api.getPanel("source")!;
			const sibling = api.getPanel("sibling")!;
			const launcher = api.getPanel("launcher:chosen")!;
			const slot = launcher.group;
			const widths = api.groups.map((group) => [
				group.id,
				group.api.width,
				group.api.height,
			]);
			source.api.setActive(); // Completion must not target the currently focused pane.
			addPanePreservingSizes(api, {
				id: "created",
				component: "terminal",
				replacement: launcher.api,
			});
			expect(api.getPanel(launcher.id)?.api.component).toBe("terminal");
			expect(api.getPanel(launcher.id)?.group).toBe(slot);
			expect(api.getPanel("created")).toBeUndefined();
			expect(slot.panels.map((panel) => panel.id)).toEqual([launcher.id]);
			expect(api.getPanel("source")).toBe(source);
			expect(api.getPanel("sibling")).toBe(sibling);
			expect(
				api.groups.map((group) => [
					group.id,
					group.api.width,
					group.api.height,
				]),
			).toEqual(widths);
		},
	);
	it("retains the selector when adding the new pane is rejected", () => {
		const { api, launcher } = fixture("right");
		expect(() =>
			addPanePreservingSizes(api, {
				id: "source",
				component: "terminal",
				position: { referencePanel: launcher.id, direction: "within" },
			}),
		).toThrow();
		expect(api.getPanel(launcher.id)).toBe(launcher);
	});
	it("never repurposes an ordinary existing pane", () => {
		const { api, source, launcher } = fixture("right");
		addPanePreservingSizes(api, {
			id: "tab",
			component: "terminal",
			position: { referencePanel: source.id, direction: "within" },
		});
		expect(api.getPanel(source.id)).toBe(source);
		expect(api.getPanel(launcher.id)).toBe(launcher);
	});
	it("refuses late completion after the selector closes instead of retargeting the active pane", () => {
		const { api, source, launcher } = fixture("right");
		removePanePreservingSizes(api, launcher);
		source.api.setActive();
		expect(() =>
			addPanePreservingSizes(api, {
				id: "late",
				component: "terminal",
				position: { referencePanel: launcher.id, direction: "within" },
			}),
		).toThrow();
		expect(api.getPanel("late")).toBeUndefined();
		expect(api.getPanel(source.id)).toBe(source);
	});
});
