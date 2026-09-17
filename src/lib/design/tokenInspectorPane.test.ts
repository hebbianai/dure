// @vitest-environment jsdom
import { createDockview } from "dockview-react";
import { afterEach, describe, expect, it } from "vitest";
import {
	registerDockview,
	unregisterDockview,
} from "@/lib/workspace/dock/dockRegistry";
import { openTokenInspectorPanel } from "./tokenInspectorPane";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function mounted(spaceId = "inspector-space") {
	const element = document.createElement("div");
	document.body.append(element);
	const api = createDockview(element, {
		createComponent: () => ({
			element: document.createElement("div"),
			init() {},
		}),
	});
	api.layout(1000, 700);
	registerDockview(spaceId, api);
	api.addPanel({
		id: "sibling",
		component: "terminal",
		params: { sessionId: "retained" },
	});
	cleanups.push(() => {
		unregisterDockview(spaceId, api);
		api.dispose();
		element.remove();
	});
	return api;
}

describe("Token Inspector pane identity", () => {
	it("allocates independent neutral panes in separate Spaces and reuses a restored one", () => {
		const first = mounted("first");
		const second = mounted("second");
		openTokenInspectorPanel("first");
		const id = first.activePanel!.id;
		expect(id).toMatch(/^pane-/);
		expect(first.activePanel?.api.component).toBe("tokeninspector");
		expect(first.activePanel?.group).not.toBe(first.getPanel("sibling")?.group);
		openTokenInspectorPanel("second");
		expect(second.activePanel?.id).toMatch(/^pane-/);
		expect(second.activePanel?.id).not.toBe(id);
		const savedSecond = second.toJSON();
		first.fromJSON(first.toJSON());
		openTokenInspectorPanel("first");
		expect(first.activePanel?.id).toBe(id);
		expect(first.panels).toHaveLength(2);
		expect(first.getPanel("sibling")?.params).toEqual({
			sessionId: "retained",
		});
		expect(second.toJSON()).toEqual(savedSecond);
	});
	it.each(["tokeninspector", "pane-existing", "launcher:former"])(
		"reuses current content at %s without replacing its parameters",
		(id) => {
			const api = mounted();
			api.addPanel({
				id,
				component: "tokeninspector",
				params: { draft: "retained" },
			});
			api.fromJSON(api.toJSON());
			const pane = api.getPanel(id)!;
			api.getPanel("sibling")!.api.setActive();
			openTokenInspectorPanel("inspector-space");
			expect(api.activePanel).toBe(pane);
			expect(pane.params).toEqual({ draft: "retained" });
			expect(api.panels).toHaveLength(2);
		},
	);
	it("keeps a repurposed inspector slot and its runtime reference untouched", () => {
		const api = mounted();
		const pane = api.addPanel({
			id: "tokeninspector",
			component: "tokeninspector",
		});
		const terminal = api.replacePanel(pane.api, {
			component: "terminal",
			params: { sessionId: "other-runtime" },
		})!;
		const group = terminal.group;
		openTokenInspectorPanel("inspector-space");
		expect(api.activePanel).not.toBe(terminal);
		expect(api.activePanel?.id).toMatch(/^pane-/);
		expect(terminal.params).toEqual({ sessionId: "other-runtime" });
		expect(terminal.group).toBe(group);
		expect(api.panels).toHaveLength(3);
	});
});
