// @vitest-environment jsdom
import { createDockview, type DockviewApi } from "dockview-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openBrowserPanelOn } from "@/lib/workspace/dock/openBrowserPanel";
import { normalizePersistedPaneLayout } from "@/lib/workspace/layout/persistedPaneLayout";

const cleanups: (() => void)[] = [];
let api: DockviewApi;
function mounted() {
	const element = document.createElement("div");
	document.body.append(element);
	const dock = createDockview(element, {
		createComponent: () => ({
			element: document.createElement("div"),
			init() {},
		}),
	});
	dock.layout(1000, 700);
	dock.addPanel({
		id: "sibling",
		component: "terminal",
		params: { sessionId: "retained" },
	});
	cleanups.push(() => {
		dock.dispose();
		element.remove();
	});
	return dock;
}
function navigation(id: string) {
	const event = `browser-navigate:${id}`;
	const received = vi.fn();
	window.addEventListener(event, received);
	cleanups.push(() => window.removeEventListener(event, received));
	return received;
}
beforeEach(() => {
	api = mounted();
});
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe("workspace Browser pane identity", () => {
	it.each(["pane-resource", "browser:resource", "browser:main"])(
		"does not guess workspace purpose for an unmarked resource view at %s",
		(id) => {
			const pane = api.addPanel({
				id,
				component: "browser",
				params: { url: "https://example.com/retained" },
			});
			const received = navigation(id);
			openBrowserPanelOn(api, "https://example.com/new");
			expect(api.activePanel).not.toBe(pane);
			expect(api.activePanel?.params?.browserPurpose).toBe("workspace");
			expect(pane.params).toEqual({ url: "https://example.com/retained" });
			expect(received).not.toHaveBeenCalled();
		},
	);
	it("allocates a neutral workspace view and reuses its identity after restore", () => {
		openBrowserPanelOn(api, "https://example.com/first");
		const pane = api.activePanel!;
		expect(pane.id).toMatch(/^pane-/);
		expect(pane.params).toEqual({
			url: "https://example.com/first",
			browserPurpose: "workspace",
		});
		const received = navigation(pane.id);
		api.fromJSON(api.toJSON());
		openBrowserPanelOn(api, "https://example.com/next");
		expect(api.activePanel?.id).toBe(pane.id);
		expect(api.panels).toHaveLength(2);
		expect(received).toHaveBeenCalledOnce();
		expect(received.mock.calls[0][0].detail).toBe("https://example.com/next");
		expect(api.getPanel("sibling")?.params).toEqual({ sessionId: "retained" });
	});
	it.each([
		{ id: "pane-existing", params: { browserPurpose: "workspace" } },
		{ id: "browser:main", params: { browserPurpose: "workspace" } },
		{ id: "launcher:former", params: { browserPurpose: "workspace" } },
	])(
		"reuses current workspace content at $id and sends navigation only to it",
		({ id, params }) => {
			const resource = api.addPanel({
				id: "pane-resource",
				component: "browser",
				params: { browserPurpose: "resource" },
			});
			const peerNavigation = navigation(resource.id);
			const pane = api.addPanel({
				id,
				component: "browser",
				params: {
					...params,
					url: "https://example.com/before",
					preserved: true,
				},
			});
			const received = navigation(id);
			const before = { ...pane.params };
			openBrowserPanelOn(api, "https://example.com/next");
			expect(api.activePanel).toBe(pane);
			expect(pane.params).toEqual(before);
			expect(api.panels).toHaveLength(3);
			expect(received).toHaveBeenCalledOnce();
			expect(peerNavigation).not.toHaveBeenCalled();
		},
	);
	it.each(["resource", null, "unknown", 12])(
		"does not override an explicit purpose %j with historical spelling",
		(browserPurpose) => {
			const pane = api.addPanel({
				id: "browser:main",
				component: "browser",
				params: { browserPurpose, url: "https://example.com/retained" },
			});
			const received = navigation(pane.id);
			const before = { ...pane.params };
			openBrowserPanelOn(api, "https://example.com/new");
			expect(api.activePanel).not.toBe(pane);
			expect(api.activePanel?.id).toMatch(/^pane-/);
			expect(pane.params).toEqual(before);
			expect(received).not.toHaveBeenCalled();
		},
	);
	it("does not treat a repurposed Browser slot as a navigation target", () => {
		const pane = api.addPanel({
			id: "browser:main",
			component: "browser",
			params: { browserPurpose: "workspace" },
		});
		const terminal = api.replacePanel(pane.api, {
			component: "terminal",
			params: { browserPurpose: "workspace", sessionId: "retained" },
		})!;
		const received = navigation(terminal.id);
		openBrowserPanelOn(api, "https://example.com/new");
		expect(api.activePanel).not.toBe(terminal);
		expect(api.activePanel?.id).toMatch(/^pane-/);
		expect(terminal.params).toEqual({
			browserPurpose: "workspace",
			sessionId: "retained",
		});
		expect(received).not.toHaveBeenCalled();
	});
	it("normalizes the legacy role without renaming the view or changing bindings", () => {
		const params = {
			url: "https://example.com/old",
			browserBinding: { retained: true },
		};
		api.addPanel({ id: "browser:main", component: "browser", params });
		const saved = api.toJSON();
		const normalized = normalizePersistedPaneLayout(saved) as typeof saved;
		expect(normalized.panels["browser:main"].params).toEqual({
			...params,
			browserPurpose: "workspace",
		});
		expect(saved.panels["browser:main"].params).toEqual(params);
		expect(normalized.grid).toEqual(saved.grid);
		expect(normalizePersistedPaneLayout(normalized)).toBe(normalized);
		api.fromJSON(normalized);
		openBrowserPanelOn(api, "https://example.com/next");
		expect(api.activePanel?.id).toBe("browser:main");
		expect(api.panels).toHaveLength(2);
	});
	it("does not reuse or change another Space's Browser view", () => {
		const other = mounted();
		other.addPanel({
			id: "browser:main",
			component: "browser",
			params: { url: "https://example.com/other" },
		});
		const before = other.toJSON();
		openBrowserPanelOn(api, "https://example.com/here");
		expect(api.activePanel?.id).toMatch(/^pane-/);
		expect(other.toJSON()).toEqual(before);
	});
});
