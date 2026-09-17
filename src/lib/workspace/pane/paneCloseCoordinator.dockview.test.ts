// @vitest-environment jsdom

import { createDockview, Orientation } from "dockview-react";
import { afterEach, describe, expect, it } from "vitest";
import {
	isDockviewProjectionOnly,
	registerDockview,
	unregisterDockview,
} from "@/lib/workspace/dock/dockRegistry";
import { installWorkspaceLayoutPersistence } from "@/lib/workspace/layout/workspaceLayoutPersistence";
import {
	removeMountedPanelsWithoutSessionTeardown,
	removePanelsWithoutSessionTeardown,
} from "@/lib/workspace/pane/paneCloseCoordinator";
import { useStore } from "@/store";

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
	api.layout(1_800, 1_000);
	api.addPanel({ id: "removed", component: "test" });
	api.addPanel({
		id: "marketing",
		component: "test",
		position: { referencePanel: "removed", direction: "right" },
	});
	api.addPanel({
		id: "patric",
		component: "test",
		position: { referencePanel: "marketing", direction: "right" },
	});
	api.addPanel({
		id: "hmux",
		component: "test",
		position: { referencePanel: "patric", direction: "below" },
	});
	api.groups.forEach((group) => {
		group.api.locked = true;
	});
	return { api, container };
}

afterEach(() => {
	useStore.setState({ layouts: {} });
});

describe("pane removal Dockview projection", () => {
	it("does not persist an already-durable mounted-only cleanup twice", async () => {
		const { api, container } = createTestDockview();
		registerDockview("desktop-mounted-only", api);
		const durableLayout = { panels: { marketing: { id: "marketing" } } };
		useStore.setState({
			layouts: { "desktop-mounted-only": durableLayout },
		});
		let persistentWrites = 0;
		const stopPersistence = installWorkspaceLayoutPersistence({
			document,
			onLayoutChange: (listener) => api.onDidLayoutChange(listener),
			onWillMutateLayout: (listener) => api.onWillMutateLayout(listener),
			onDidMutateLayout: (listener) => api.onDidMutateLayout(listener),
			commitOrdinary: () => {
				if (isDockviewProjectionOnly(api)) return;
				persistentWrites += 1;
				useStore
					.getState()
					.saveLayout("desktop-mounted-only", api.toJSON());
			},
			captureResizeCommit: () => undefined,
		});

		removeMountedPanelsWithoutSessionTeardown(["removed"]);
		await Promise.resolve();

		expect(api.getPanel("removed")).toBeUndefined();
		expect(persistentWrites).toBe(0);
		expect(isDockviewProjectionOnly(api)).toBe(false);
		expect(useStore.getState().layouts["desktop-mounted-only"]).toBe(
			durableLayout,
		);

		stopPersistence();
		unregisterDockview("desktop-mounted-only", api);
		api.dispose();
		container.remove();
	});

	it("collapses the removed Agent group in live and persisted layouts", () => {
		const { api, container } = createTestDockview();
		registerDockview("desktop-test", api);
		useStore.setState({
			layouts: { "desktop-test": api.toJSON() },
		});
		const stopPersistence = installWorkspaceLayoutPersistence({
			document,
			onLayoutChange: (listener) => api.onDidLayoutChange(listener),
			onWillMutateLayout: (listener) => api.onWillMutateLayout(listener),
			onDidMutateLayout: (listener) => api.onDidMutateLayout(listener),
			commitOrdinary: () =>
				useStore.getState().saveLayout("desktop-test", api.toJSON()),
			captureResizeCommit: () => undefined,
		});

		api.getPanel("removed")!.api.close();

		expect(api.panels.map((panel) => panel.id).sort()).toEqual([
			"hmux",
			"marketing",
			"patric",
		]);
		expect(api.groups).toHaveLength(3);
		expect(api.groups.every((group) => group.panels.length === 1)).toBe(true);

		const persisted = useStore.getState().layouts["desktop-test"];
		api.fromJSON(persisted as Parameters<typeof api.fromJSON>[0], {
			reuseExistingPanels: true,
		});
		expect(api.groups).toHaveLength(3);
		expect(api.groups.every((group) => group.panels.length === 1)).toBe(true);

		stopPersistence();
		unregisterDockview("desktop-test", api);
		api.dispose();
		container.remove();
	});

	it("removes the empty nested split that owned the deleted Agent", () => {
		const { api, container } = createTestDockview();
		api.clear();
		const panel = (id: string) => ({
			id,
			contentComponent: "test",
			title: id,
		});
		api.fromJSON({
			grid: {
				root: {
					type: "branch",
					data: [
						{
							type: "branch",
							data: [
								{
									type: "leaf",
									data: {
										id: "removed-group",
										views: ["removed"],
										activeView: "removed",
										locked: true,
									},
									size: 1_000,
								},
							],
							size: 600,
						},
						{
							type: "leaf",
							data: {
								id: "marketing-group",
								views: ["marketing"],
								activeView: "marketing",
								locked: true,
							},
							size: 600,
						},
					],
					size: 1_000,
				},
				width: 1_200,
				height: 1_000,
				orientation: Orientation.HORIZONTAL,
			},
			panels: {
				removed: panel("removed"),
				marketing: panel("marketing"),
			},
			activeGroup: "removed-group",
		});
		registerDockview("desktop-nested", api);
		useStore.setState({ layouts: { "desktop-nested": api.toJSON() } });
		const stopPersistence = installWorkspaceLayoutPersistence({
			document,
			onLayoutChange: (listener) => api.onDidLayoutChange(listener),
			onWillMutateLayout: (listener) => api.onWillMutateLayout(listener),
			onDidMutateLayout: (listener) => api.onDidMutateLayout(listener),
			commitOrdinary: () =>
				useStore.getState().saveLayout("desktop-nested", api.toJSON()),
			captureResizeCommit: () => undefined,
		});

		removePanelsWithoutSessionTeardown(["removed"]);

		const persisted = useStore.getState().layouts["desktop-nested"];
		expect(persisted).not.toMatchObject({
			grid: {
				root: {
					data: [
						{
							type: "branch",
							data: [],
						},
					],
				},
			},
		});
		api.fromJSON(persisted as Parameters<typeof api.fromJSON>[0], {
			reuseExistingPanels: true,
		});
		expect(api.groups.map((group) => group.id)).toEqual(["marketing-group"]);

		stopPersistence();
		unregisterDockview("desktop-nested", api);
		api.dispose();
		container.remove();
	});
});
