import { describe, expect, it } from "vitest";
import type { DockviewApi } from "dockview-react";
import {
	agentPaneLocations,
	selectUnopenedAgents,
} from "@/lib/workspace/layout/agentPaneLocations";
import { agentIdFromPane } from "@/lib/workspace/layout/agentPaneParameters";

describe("agent panel visibility", () => {
	it.each(["slot", "launcher:old", "term:old", "agent:old"])(
		"locates the saved current Agent reference in %s",
		(panelId) => {
			expect(
				agentPaneLocations({
					desktop: {
						panels: {
							[panelId]: {
								contentComponent: "agent",
								params: { agentRef: { agentId: "current" } },
							},
						},
					},
				}),
			).toEqual([{ desktopId: "desktop", panelId, agentId: "current" }]);
		},
	);

	it("retains legacy pre-reference panes without accepting invalid explicit references or wrong content", () => {
		expect(
			agentPaneLocations({
				desktop: {
					panels: {
						"agent:legacy": {
							contentComponent: "agent",
							params: { agentId: "stale" },
						},
						"agent:invalid": {
							contentComponent: "agent",
							params: { agentRef: null },
						},
						"agent:terminal": {
							contentComponent: "terminal",
							params: { agentRef: { agentId: "wrong" } },
						},
						"agent:unknown": { params: {} },
					},
				},
			}),
		).toEqual([
			{ desktopId: "desktop", panelId: "agent:legacy", agentId: "legacy" },
		]);
	});

	it("replaces each mounted Space's saved content, including absence, without rewriting pane IDs", () => {
		const params = { agentRef: { agentId: "current" } };
		const api = {
			panels: [
				{
					id: "slot",
					params,
					api: {
						component: "agent",
						getParameters: () => ({
							agentRef: { agentId: "outdated-api-param" },
						}),
					},
				},
			],
		} as unknown as Pick<DockviewApi, "panels">;
		const layout = {
			panels: { "agent:stale": { contentComponent: "agent", params: {} } },
		};
		const layouts = { changed: layout, closed: layout, unmounted: layout };
		expect(
			agentPaneLocations(layouts, [
				["changed", api],
				["closed", { panels: [] }],
			]),
		).toEqual([
			{ desktopId: "changed", panelId: "slot", agentId: "current" },
			{ desktopId: "unmounted", panelId: "agent:stale", agentId: "stale" },
		]);
		expect(layouts.changed).toBe(layout);
	});

	it("does not let copied parameters retarget the explicit Agent reference", () => {
		expect(
			agentIdFromPane({
				id: "agent:canonical-id",
				component: "agent",
				params: { agentRef: { agentId: "canonical-id" }, agentId: "stale" },
			}),
		).toBe("canonical-id");
	});

	it("does not interpret a missing mounted reference as a historical locator", () => {
		expect(
			agentIdFromPane({ id: "agent:agent-id", component: "agent" }),
		).toBeUndefined();
	});

	it("ignores non-agent panels", () => {
		expect(
			agentIdFromPane({ id: "agent:agent-id", component: "terminal" }),
		).toBeUndefined();
	});

	it("returns only registered agents without an open panel", () => {
		const agents = [{ id: "open" }, { id: "closed" }, { id: "also-open" }];
		const openAgentIds = new Set(["open", "also-open"]);

		expect(selectUnopenedAgents(agents, openAgentIds)).toEqual([
			{ id: "closed" },
		]);
	});
});
