// @vitest-environment jsdom
import { createDockview } from "dockview-react";
import { afterEach, expect, it, vi } from "vitest";
import { addPanePreservingSizes } from "@/lib/workspace/pane/paneMutationSizing";
import { assertPaneContentReplacement } from "@/qa/paneContentReplacement";

it("conforms to the same public contract exercised by fresh installs and Vite", () => {
	expect(() =>
		assertPaneContentReplacement(document, createDockview),
	).not.toThrow();
});

it("reuses a matching default tab renderer when the serialized definition omits its name", () => {
	const element = document.createElement("div");
	document.body.append(element);
	const api = createDockview(element, {
		defaultTabComponent: "header",
		createComponent: () => ({
			element: document.createElement("div"),
			init() {},
		}),
		createTabComponent: () => ({
			element: document.createElement("div"),
			init() {},
		}),
	});
	try {
		const current = api.addPanel({ id: "slot", component: "terminal" });
		const snapshot = api.toJSON();
		delete snapshot.panels[current.id].tabComponent;
		api.fromJSON(snapshot, { reuseExistingPanels: true });
		expect(api.getPanel(current.id)).toBe(current);
	} finally {
		api.dispose();
		element.remove();
	}
});

const dispose: Array<() => void> = [];
afterEach(() => {
	for (const stop of dispose.splice(0).reverse()) stop();
	vi.restoreAllMocks();
});

function fixture(id: string, floating = false, renderer?: "always") {
	const element = document.createElement("div");
	document.body.append(element);
	const contents = new Map<string, HTMLElement>();
	const disposed = vi.fn();
	const api = createDockview(element, {
		createComponent: ({ name, id }) => {
			const content = document.createElement("div");
			contents.set(id, content);
			return {
				element: content,
				init() {
					if (name === "broken")
						throw new Error("injected renderer init failure");
					content.textContent = name;
				},
				dispose() {
					disposed(name);
				},
			};
		},
	});
	dispose.push(() => {
		api.dispose();
		element.remove();
	});
	api.layout(1000, 700);
	const sibling = api.addPanel({
		id: "sibling",
		component: "terminal",
		params: { sessionId: "keep-runtime" },
	});
	const slot = api.addPanel({
		id,
		component: "launcher",
		renderer,
		params: { cwd: "/repo" },
		...(floating
			? { floating: { x: 30, y: 40, width: 500, height: 400 } }
			: {
					position: { referencePanel: sibling.id, direction: "right" as const },
				}),
	});
	const complete = (target = slot, sessionId = "new-runtime") =>
		addPanePreservingSizes(api, {
			id: `term:${sessionId}`,
			component: "terminal",
			renderer,
			params: { sessionId },
			replacement: target.api,
			position: { referencePanel: target.id, direction: "within" },
		});
	return { api, slot, sibling, complete, element, contents, disposed };
}

it.each(["slot", "launcher:historical", "agent:historical"])(
	"replaces content without changing pane %s or its siblings",
	(id) => {
		const { api, slot, sibling, complete } = fixture(id);
		const group = slot.group;
		const grid = api.toJSON().grid;
		const current = complete();
		expect(current.id).toBe(id);
		expect(current).not.toBe(slot);
		expect(api.getPanel(id)).toBe(current);
		expect(current.api.component).toBe("terminal");
		expect(current.params).toEqual({ sessionId: "new-runtime" });
		expect(current.group).toBe(group);
		expect(api.getPanel(sibling.id)).toBe(sibling);
		expect(api.panels).toHaveLength(2);
		expect(api.toJSON().grid).toEqual(grid);
		expect(api.activePanel).toBe(current);
	},
);

it("preserves the same floating group across content replacement", () => {
	const { api, slot, sibling, complete } = fixture("slot", true);
	const group = slot.group;
	const floating = api.toJSON().floatingGroups;
	const current = complete();
	expect(current.id).toBe(slot.id);
	expect(current.group).toBe(group);
	expect(current.group.api.location.type).toBe("floating");
	expect(api.toJSON().floatingGroups).toEqual(floating);
	expect(api.getPanel(sibling.id)).toBe(sibling);
});

it("rejects a late completion targeting the old content handle", () => {
	const { api, slot, complete } = fixture("slot");
	const current = complete();
	const before = api.toJSON();
	expect(() => complete(slot, "late-runtime")).toThrow();
	expect(api.getPanel(current.id)).toBe(current);
	expect(api.toJSON()).toEqual(before);
});

it("retains tab membership and publishes the new active handle without add/remove events", () => {
	const { api, slot, complete } = fixture("slot");
	const tab = api.createTabGroup({
		groupId: slot.group.id,
		label: "keep",
		color: "blue",
	});
	api.addPanelToTabGroup({
		groupId: slot.group.id,
		tabGroupId: tab.id,
		panelId: slot.id,
	});
	const membership = api.getTabGroups({ groupId: slot.group.id });
	const added = vi.fn();
	const removed = vi.fn();
	const active = vi.fn();
	api.onDidAddPanel(added);
	api.onDidRemovePanel(removed);
	api.onDidActivePanelChange(active);
	active.mockClear();
	const current = complete();
	expect(api.getTabGroups({ groupId: current.group.id })).toEqual(membership);
	expect(added).not.toHaveBeenCalled();
	expect(removed).not.toHaveBeenCalled();
	expect(active).toHaveBeenCalledExactlyOnceWith({
		panel: current,
		origin: "api",
	});
});

it("restores the previous content from a complete layout without replacing siblings", () => {
	const { api, slot, sibling, complete } = fixture("slot");
	const before = api.toJSON();
	complete();
	api.fromJSON(before, { reuseExistingPanels: true });
	expect(api.getPanel(slot.id)?.api.component).toBe("launcher");
	expect(api.getPanel(slot.id)?.params).toEqual({ cwd: "/repo" });
	expect(api.toJSON()).toEqual(before);
	expect(api.getPanel(sibling.id)).toBe(sibling);
});

it("does not let a queued previous-content frame starve the new overlay", async () => {
	const frames: Array<FrameRequestCallback> = [];
	vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
		frames.push(callback);
		return frames.length;
	});
	vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
	const { api, complete, element } = fixture("slot", false, "always");
	await Promise.resolve();
	const old = element.querySelector<HTMLElement>(".dv-render-overlay")!;
	expect(old).not.toBeNull();
	const current = complete();
	await Promise.resolve();
	const next = element.querySelector<HTMLElement>(".dv-render-overlay")!;
	expect(next).not.toBe(old);
	for (const frame of frames.splice(0)) frame(100);
	expect(api.activePanel).toBe(current);
	expect(current.api.isVisible).toBe(true);
	expect(next.style.visibility).not.toBe("hidden");
	expect(next.textContent).toBe("terminal");
	expect(old.isConnected).toBe(false);
	expect(old.style.visibility).toBe("hidden");
});

it("disposes failed new content without removing the previous content or changing its layout", () => {
	const { api, slot, disposed } = fixture("slot");
	const before = api.toJSON();
	expect(() =>
		addPanePreservingSizes(api, {
			id: "ignored-new-id",
			component: "broken",
			replacement: slot.api,
		}),
	).toThrow("injected renderer init failure");
	expect(disposed).toHaveBeenCalledExactlyOnceWith("broken");
	expect(api.getPanel(slot.id)).toBe(slot);
	expect(api.activePanel).toBe(slot);
	expect(api.toJSON()).toEqual(before);
});

it("replaces inactive always-rendered content without detaching the visible sibling", () => {
	const { api, slot, complete, contents } = fixture("slot", false, "always");
	const selected = api.addPanel({
		id: "visible",
		component: "editor",
		renderer: "onlyWhenVisible",
		position: { referencePanel: slot.id, direction: "within" },
	});
	const visible = contents.get(selected.id)!;
	expect(visible.isConnected).toBe(true);
	const current = complete();
	expect(current.group.activePanel).toBe(selected);
	expect(api.activePanel).toBe(selected);
	expect(visible.isConnected).toBe(true);
	expect(current.api.isVisible).toBe(false);
});

it("does not retain newer content parameters when a complete snapshot restores the same component", () => {
	const { api, complete, sibling } = fixture("slot");
	const current = complete();
	const before = api.toJSON();
	addPanePreservingSizes(api, {
		id: "ignored",
		component: "terminal",
		params: { sessionId: "next-runtime", transient: true },
		replacement: current.api,
	});
	api.fromJSON(before, { reuseExistingPanels: true });
	expect(api.getPanel(current.id)?.params).toEqual({
		sessionId: "new-runtime",
	});
	expect(api.getPanel(sibling.id)).toBe(sibling);
	expect(api.toJSON()).toEqual(before);
});
