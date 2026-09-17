// @vitest-environment jsdom

import { createDockview } from "dockview-react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	hidePanePreservingLayout,
	restorePanePreservingLayout,
} from "@/lib/workspace/pane/paneVisibility";
import {
	applyAutomaticPaneTitle,
	renamePaneTitle,
	usePaneTitleOverrides,
} from "@/lib/workspace/pane/paneTitleOverrideStore";

function createTestDockview() {
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
	api.layout(600, 1_000);
	api.addPanel({ id: "left", component: "test" });
	api.addPanel({
		id: "right-top",
		component: "test",
		position: { referencePanel: "left", direction: "right" },
	});
	api.addPanel({
		id: "right-bottom",
		component: "test",
		position: { referencePanel: "right-top", direction: "below" },
	});
	return { api, container };
}

describe("hidden pane visibility", () => {
	beforeEach(() => usePaneTitleOverrides.setState({ overrides: {} }));

	it("restores a nested pane to the exact serialized grid slot", () => {
		const { api, container } = createTestDockview();
		const before = api.toJSON().grid;
		const panel = api.getPanel("right-bottom");
		expect(panel).toBeDefined();

		expect(hidePanePreservingLayout(api, panel!.id)).toBe(true);
		expect(api.getPanel("right-bottom")).toBe(panel);
		expect(api.toJSON().grid.root).toMatchObject({
			data: [
				{},
				{
					data: [{}, { visible: false }],
				},
			],
		});
		expect(restorePanePreservingLayout(api, panel!.id)).toBe(true);

		expect(api.toJSON().grid).toEqual(before);
		api.dispose();
		container.remove();
	});

	it("reflows the restored group through its current model size", () => {
		const { api, container } = createTestDockview();
		const panel = api.getPanel("right-bottom");
		expect(panel).toBeDefined();

		expect(hidePanePreservingLayout(api, panel!.id)).toBe(true);
		const setSize = vi.spyOn(panel!.group.api, "setSize");
		expect(restorePanePreservingLayout(api, panel!.id)).toBe(true);

		expect(setSize).toHaveBeenCalledWith(
			expect.objectContaining({
				width: expect.any(Number),
				height: expect.any(Number),
			}),
		);

		api.dispose();
		container.remove();
	});

	it("does not reflow an already visible pane while focusing it repeatedly", () => {
		const { api, container } = createTestDockview();
		const panel = api.getPanel("right-bottom");
		expect(panel).toBeDefined();
		const setVisible = vi.spyOn(panel!.group.api, "setVisible");
		const setSize = vi.spyOn(panel!.group.api, "setSize");
		const setActive = vi.spyOn(panel!.api, "setActive");
		const before = {
			height: panel!.group.api.height,
			width: panel!.group.api.width,
		};

		for (let click = 0; click < 4; click += 1) {
			expect(restorePanePreservingLayout(api, panel!.id)).toBe(true);
		}

		expect(setVisible).not.toHaveBeenCalled();
		expect(setSize).not.toHaveBeenCalled();
		expect(setActive).toHaveBeenCalledTimes(4);
		expect({
			height: panel!.group.api.height,
			width: panel!.group.api.width,
		}).toEqual(before);

		api.dispose();
		container.remove();
	});

	it("keeps a renamed title through hide, restore, and automatic cwd updates", () => {
		const { api, container } = createTestDockview();
		const panel = api.getPanel("right-bottom");
		expect(panel).toBeDefined();

		applyAutomaticPaneTitle(panel!.api, "repo");
		renamePaneTitle(panel!.api, "Release QA");
		expect(hidePanePreservingLayout(api, panel!.id)).toBe(true);
		applyAutomaticPaneTitle(panel!.api, "renamed-cwd");
		expect(restorePanePreservingLayout(api, panel!.id)).toBe(true);

		expect(panel!.api.title).toBe("Release QA");
		expect(api.toJSON().panels[panel!.id]?.title).toBe("Release QA");

		api.dispose();
		container.remove();
	});

	it("does not hide every tab in a legacy stacked group", () => {
		const { api, container } = createTestDockview();
		api.addPanel({
			id: "stacked",
			component: "test",
			position: { referencePanel: "left", direction: "within" },
		});

		expect(hidePanePreservingLayout(api, "left")).toBe(false);
		expect(api.getPanel("left")?.group.api.isVisible).toBe(true);
		expect(api.getPanel("stacked")?.group.api.isVisible).toBe(true);

		api.dispose();
		container.remove();
	});
});
