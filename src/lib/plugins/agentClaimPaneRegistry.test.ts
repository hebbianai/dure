import { describe, expect, it, vi } from "vitest";
import {
	AgentClaimPaneRegistry,
	agentClaimPanesFromLayouts,
} from "@/lib/plugins/agentClaimPaneRegistry";

describe("agentClaimPanesFromLayouts", () => {
	it("projects only agent panes from cold desktop layouts", () => {
		expect(
			agentClaimPanesFromLayouts({
				"desktop-one": {
					panels: {
						"agent:one": {
							contentComponent: "agent",
							params: { agentId: "stale-one" },
						},
						"term:one": {
							contentComponent: "terminal",
							params: { sessionId: "session-one" },
						},
					},
				},
				"desktop-two": {
					panels: {
						"agent:two": {
							contentComponent: "agent",
							params: { agentId: "stale-two" },
						},
						"file:readme": {
							contentComponent: "file",
							params: { agentId: "not-an-agent-pane" },
						},
					},
				},
				malformed: { panels: null },
			}),
		).toEqual([
			{ id: "agent:one", agentId: "one" },
			{ id: "agent:two", agentId: "two" },
		]);
	});

	it("excludes orphan layouts that no longer belong to a desktop", () => {
		expect(
			agentClaimPanesFromLayouts(
				{
					current: {
						panels: {
							"agent:one": {
								contentComponent: "agent",
								params: { agentId: "stale-one" },
							},
						},
					},
					deleted: {
						panels: {
							"agent:ghost": {
								contentComponent: "agent",
								params: { agentId: "stale-ghost" },
							},
						},
					},
				},
				new Set(["current"]),
			),
		).toEqual([{ id: "agent:one", agentId: "one" }]);
	});

	describe("AgentClaimPaneRegistry", () => {
		it("preserves mounted precedence and only publishes changed identities", () => {
			const panes = new AgentClaimPaneRegistry();
			const changed = vi.fn();
			panes.subscribe(changed);
			panes.replaceSources({
				layouts: {
					desktop: { panels: { "agent:one": { contentComponent: "agent" } } },
				},
				spaces: [{ id: "desktop" }],
				agents: [{ id: "one" }],
				hidden: { one: { desktopId: "desktop", paneId: "agent:one" } },
			});
			expect(panes.getSnapshot()).toEqual([
				{ id: "agent:one", agentId: "one" },
			]);
			changed.mockClear();
			const release = panes.mount("one", "agent:one");
			expect(changed).not.toHaveBeenCalled();
			release();
			expect(changed).not.toHaveBeenCalled();
			const stale = panes.mount("two", "agent:two");
			const current = panes.mount("two", "agent:two");
			stale();
			expect(panes.getSnapshot()).toEqual([
				{ id: "agent:one", agentId: "one" },
				{ id: "agent:two", agentId: "two" },
			]);
			current();
			expect(panes.getSnapshot()).toEqual([
				{ id: "agent:one", agentId: "one" },
			]);
		});
	});
});
