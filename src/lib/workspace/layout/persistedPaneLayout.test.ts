import { describe, expect, it } from "vitest";
import {
	normalizePersistedPaneLayout,
	normalizePersistedPaneLayouts,
} from "@/lib/workspace/layout/persistedPaneLayout";

function layoutWith(panels: Record<string, unknown>) {
	return { grid: { root: { type: "branch", data: [] } }, panels };
}

function panelsOf(layout: unknown): Record<string, Record<string, unknown>> {
	return (layout as { panels: Record<string, Record<string, unknown>> }).panels;
}

describe("normalizePersistedPaneLayout", () => {
	it.each([
		{ contentComponent: "terminal", params: {} },
		{ contentComponent: "browser", params: { browserPurpose: "resource" } },
		{ contentComponent: "browser", params: { browserPurpose: null } },
		{ contentComponent: "browser", params: { browserPurpose: "unknown" } },
	])(
		"does not infer a Browser role over current content or explicit purpose: %j",
		(panel) => {
			const layout = layoutWith({ "browser:main": panel });
			expect(normalizePersistedPaneLayout(layout)).toBe(layout);
		},
	);
	it("preserves only the explicit Agent reference independently of pane identity", () => {
		const layout = layoutWith({
			"agent:previous": {
				contentComponent: "agent",
				params: {
					agentRef: { agentId: "current", sessionId: "copied-session" },
					agentId: "stale",
					binding: { sessionId: "stale-session" },
				},
			},
			"pane:opaque": {
				contentComponent: "agent",
				params: { agentRef: { agentId: "current" } },
			},
		});
		const normalized = normalizePersistedPaneLayout(layout);
		for (const pane of Object.values(panelsOf(normalized))) {
			expect(pane.params).toEqual({ agentRef: { agentId: "current" } });
		}
		expect(Object.keys(panelsOf(normalized))).toEqual(
			Object.keys(panelsOf(layout)),
		);
		expect(normalizePersistedPaneLayout(normalized)).toBe(normalized);
	});

	it("keeps explicit unresolved references unresolved after repeated restores", () => {
		for (const agentRef of [null, {}, { agentId: "" }, { agentId: 123 }]) {
			const layout = layoutWith({
				"agent:previous": { contentComponent: "agent", params: { agentRef } },
			});
			const normalized = normalizePersistedPaneLayout(layout);
			expect(panelsOf(normalized)["agent:previous"].params).toEqual({
				agentRef: null,
			});
			expect(normalizePersistedPaneLayout(normalized)).toBe(normalized);
		}
	});

	it("preserves current non-Agent content even when the stable ID looks like an Agent", () => {
		const params = {
			sessionId: "current-session",
			binding: { sessionId: "current-session" },
		};
		const layout = layoutWith({
			"agent:previous": { contentComponent: "terminal", params },
			"agent:unknown": { contentComponent: "extension-view", params },
			"agent:selector": { component: "launcher", params: { cwd: "/chosen" } },
		});
		const panels = panelsOf(normalizePersistedPaneLayout(layout));
		expect(panels["agent:previous"].params).toBe(params);
		expect(panels["agent:unknown"].params).toBe(params);
		expect(panels["agent:selector"]).toEqual({
			contentComponent: "launcher",
			params: { cwd: "/chosen" },
		});
		expect(Object.keys(panels)).toEqual(Object.keys(panelsOf(layout)));
	});

	it("renames addPanel's `component` key to `contentComponent` in place", () => {
		const layout = layoutWith({
			"term:remote": {
				id: "term:remote",
				component: "terminal",
				title: "remote",
				params: { sessionId: "standalone_x" },
			},
		});

		const panel = panelsOf(normalizePersistedPaneLayout(layout))["term:remote"];

		expect(panel).toEqual({
			id: "term:remote",
			contentComponent: "terminal",
			title: "remote",
			params: { sessionId: "standalone_x" },
		});
		expect(Object.keys(panel)).toEqual([
			"id",
			"contentComponent",
			"title",
			"params",
		]);
	});

	it("drops a stray `component` key beside an existing `contentComponent`", () => {
		const layout = layoutWith({
			"term:both": {
				id: "term:both",
				contentComponent: "terminal",
				component: "terminal",
				params: {},
			},
		});

		expect(panelsOf(normalizePersistedPaneLayout(layout))["term:both"]).toEqual(
			{
				id: "term:both",
				contentComponent: "terminal",
				params: {},
			},
		);
	});

	it("does not invent a view name from a non-string `component`", () => {
		const layout = layoutWith({
			"term:junk": { id: "term:junk", component: 42, params: {} },
		});

		expect(panelsOf(normalizePersistedPaneLayout(layout))["term:junk"]).toEqual(
			{
				id: "term:junk",
				params: {},
			},
		);
	});

	it("migrates legacy Agent locators without retaining copied runtime parameters", () => {
		const layout = layoutWith({
			"agent:by-id": {
				id: "agent:by-id",
				contentComponent: "agent",
				params: { agentId: "x" },
			},
			"pane:by-view": { id: "pane:by-view", contentComponent: "agent" },
			"pane:legacy-key": {
				id: "pane:legacy-key",
				component: "agent",
				params: { agentId: "y" },
			},
			"term:keep": {
				id: "term:keep",
				contentComponent: "terminal",
				params: { sessionId: "s" },
			},
		});

		const panels = panelsOf(normalizePersistedPaneLayout(layout));

		expect(panels["agent:by-id"]?.params).toEqual({
			agentRef: { agentId: "by-id" },
		});
		expect(panels["pane:by-view"]?.params).toEqual({ agentRef: null });
		expect(panels["pane:legacy-key"]).toEqual({
			id: "pane:legacy-key",
			contentComponent: "agent",
			params: { agentRef: null },
		});
		expect(panels["term:keep"]?.params).toEqual({ sessionId: "s" });
	});

	it("returns the same references when nothing needs repair", () => {
		const layout = layoutWith({
			"agent:clean": {
				id: "agent:clean",
				contentComponent: "agent",
				params: { agentRef: { agentId: "clean" } },
			},
			"term:clean": {
				id: "term:clean",
				contentComponent: "terminal",
				params: { sessionId: "s" },
			},
		});
		const layouts = { main: layout, other: "not a layout" };

		expect(normalizePersistedPaneLayout(layout)).toBe(layout);
		expect(normalizePersistedPaneLayouts(layouts)).toBe(layouts);
	});
});
