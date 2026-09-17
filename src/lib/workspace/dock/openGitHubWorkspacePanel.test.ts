// @vitest-environment jsdom
import { createDockview, type DockviewApi } from "dockview-react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openGitHubWorkspacePanel } from "@/lib/workspace/dock/openGitHubWorkspacePanel";
import {
	registerDockview,
	unregisterDockview,
} from "@/lib/workspace/dock/dockRegistry";
import { useStore } from "@/store";

const cleanups: (() => void)[] = [];
let api: DockviewApi;
function mounted(spaceId = "desktop-1") {
	const element = document.createElement("div");
	document.body.append(element);
	const dock = createDockview(element, {
		createComponent: () => ({
			element: document.createElement("div"),
			init() {},
		}),
	});
	dock.layout(1000, 700);
	registerDockview(spaceId, dock);
	dock.addPanel({
		id: "sibling",
		component: "terminal",
		params: { sessionId: "retained" },
	});
	cleanups.push(() => {
		unregisterDockview(spaceId, dock);
		dock.dispose();
		element.remove();
	});
	return dock;
}
beforeEach(() => {
	useStore.setState({
		spaces: [{ id: "desktop-1", name: "Main" }],
		activeSpaceId: "desktop-1",
	});
	api = mounted();
});
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe("openGitHubWorkspacePanel", () => {
	it("opens one neutral GitHub panel scoped to the requested project", () => {
		openGitHubWorkspacePanel("desktop-1", "project-1", "Dure");
		const pane = api.activePanel!;
		expect(pane.id).toMatch(/^pane-/);
		expect(pane.api.component).toBe("github");
		expect(pane.api.title).toBe("GitHub · Dure");
		expect(pane.params).toEqual({ projectId: "project-1" });
		const id = pane.id;
		api.fromJSON(api.toJSON());
		openGitHubWorkspacePanel("desktop-1", "project-1", "Dure");
		expect(api.activePanel?.id).toBe(id);
		expect(api.panels).toHaveLength(2);
		expect(api.getPanel("sibling")?.params).toEqual({ sessionId: "retained" });
	});
	it.each(["pane-existing", "github-workspace", "launcher:former"])(
		"retargets and focuses current GitHub content at %s",
		(id) => {
			const pane = api.addPanel({
				id,
				component: "github",
				params: { projectId: "project-old", preserved: true },
			});
			api.getPanel("sibling")!.api.setActive();
			openGitHubWorkspacePanel("desktop-1", "project-2", "Docs");
			expect(api.activePanel).toBe(pane);
			expect(pane.params).toEqual({ projectId: "project-2", preserved: true });
			expect(pane.api.title).toBe("GitHub · Docs");
			expect(api.panels).toHaveLength(2);
		},
	);
	it("clears a stale repository scope when reopened without a local project", () => {
		const pane = api.addPanel({
			id: "pane-existing",
			component: "github",
			params: { projectId: "project-old", preserved: true },
		});
		openGitHubWorkspacePanel("desktop-1", null);
		expect(api.activePanel).toBe(pane);
		expect(pane.params).toEqual({ projectId: undefined, preserved: true });
		expect(pane.api.title).toBe("GitHub");
	});
	it("does not retarget a repurposed workspace pane", () => {
		const pane = api.addPanel({
			id: "github-workspace",
			component: "github",
			params: { projectId: "before" },
		});
		const terminal = api.replacePanel(pane.api, {
			component: "terminal",
			params: { projectId: "before", sessionId: "retained" },
		})!;
		openGitHubWorkspacePanel("desktop-1", "project-1", "Dure");
		expect(api.activePanel).not.toBe(terminal);
		expect(api.activePanel?.id).toMatch(/^pane-/);
		expect(terminal.params).toEqual({
			projectId: "before",
			sessionId: "retained",
		});
	});
	it("keeps another Space's GitHub selection and identity unchanged", () => {
		const other = mounted("other");
		other.addPanel({
			id: "github-workspace",
			component: "github",
			params: { projectId: "before" },
		});
		const saved = other.toJSON();
		openGitHubWorkspacePanel("desktop-1", "project-1", "Dure");
		expect(api.activePanel?.id).toMatch(/^pane-/);
		expect(other.toJSON()).toEqual(saved);
	});
});
