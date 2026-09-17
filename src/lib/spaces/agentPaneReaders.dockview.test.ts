// @vitest-environment jsdom
import { createDockview, type DockviewApi } from "dockview-react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentClaimPanesFromLayouts } from "@/lib/plugins/agentClaimPaneRegistry";
import { isAgentPaneMounted } from "@/lib/workspace/layout/agentPaneLocations";
import { createSpacesPaneProjection } from "@/lib/spaces/spacesPaneProjection";
import { dockPanelReference } from "@/lib/workspace/dock/dockPanelParameters";

let api: DockviewApi;
let container: HTMLDivElement;
beforeEach(() => {
	container = document.createElement("div");
	document.body.append(container);
	api = createDockview(container, {
		createComponent: () => ({
			element: document.createElement("div"),
			init() {},
		}),
	});
	api.layout(900, 600);
});
afterEach(() => {
	api.dispose();
	container.remove();
});

describe.each(["opaque-slot", "agent:previous", "launcher:previous"])(
	"Agent pane readers for %s",
	(id) => {
		it("publishes plugin claims for the explicit current target", () => {
			api.addPanel({
				id,
				component: "agent",
				params: { agentRef: { agentId: "current" } },
			});
			expect(agentClaimPanesFromLayouts({ one: api.toJSON() })).toEqual([
				{ id, agentId: "current" },
			]);
		});
		it("excludes a mounted current Agent from unopened cleanup", () => {
			api.addPanel({
				id,
				component: "agent",
				params: { agentRef: { agentId: "current" } },
			});
			expect(isAgentPaneMounted("current", [["one", api]])).toBe(true);
			expect(isAgentPaneMounted("previous", [["one", api]])).toBe(false);
		});
		it.each(["mounted", "saved", "restored"])(
			"projects the actual Agent reference in %s content",
			(mode) => {
				api.addPanel({
					id,
					component: "agent",
					params: { agentRef: { agentId: "current" }, agentId: "copied" },
				});
				const saved = api.toJSON();
				if (mode === "restored") api.fromJSON(saved);
				const live =
					mode === "saved"
						? undefined
						: api.panels.map((panel) => ({
								...dockPanelReference(panel),
								isVisible: panel.api.isVisible,
							}));
				const rows = createSpacesPaneProjection()(
					{ one: saved },
					"one",
					["one"],
					live,
				);
				expect(rows.map((row) => [row.key, row.kind, row.agentId])).toEqual([
					[id, "agent", "current"],
				]);
				expect(agentClaimPanesFromLayouts({ one: saved })).toEqual([
					{ id, agentId: "current" },
				]);
				expect(isAgentPaneMounted("current", [["one", api]])).toBe(true);
				expect(isAgentPaneMounted("previous", [["one", api]])).toBe(false);
			},
		);
		it("does not treat a terminal's old spelling or copied Agent fields as an Agent", () => {
			api.addPanel({
				id,
				component: "terminal",
				params: {
					sessionId: "shell",
					agentRef: { agentId: "current" },
					agentId: "copied",
				},
			});
			const saved = api.toJSON();
			expect(
				createSpacesPaneProjection()(
					{ one: saved },
					"one",
					["one"],
					undefined,
				).map((row) => [row.key, row.kind, row.sessionId, row.agentId]),
			).toEqual([[id, "term", "shell", undefined]]);
			expect(agentClaimPanesFromLayouts({ one: saved })).toEqual([]);
			expect(isAgentPaneMounted("previous", [["one", api]])).toBe(false);
		});
		it.each([null, {}, { agentId: "" }])(
			"does not infer a target from an invalid explicit reference %j",
			(agentRef) => {
				api.addPanel({ id, component: "agent", params: { agentRef } });
				const saved = api.toJSON();
				expect(
					createSpacesPaneProjection()(
						{ one: saved },
						"one",
						["one"],
						undefined,
					),
				).toEqual([]);
				expect(agentClaimPanesFromLayouts({ one: saved })).toEqual([]);
				expect(isAgentPaneMounted("previous", [["one", api]])).toBe(false);
			},
		);
		it("reflects target changes without replacing the mounted pane or its ID", () => {
			const pane = api.addPanel({
				id,
				component: "agent",
				params: { agentRef: { agentId: "previous" } },
			});
			const project = createSpacesPaneProjection();
			const rows = () =>
				project(
					{},
					"one",
					["one"],
					api.panels.map((panel) => ({
						...dockPanelReference(panel),
						isVisible: panel.api.isVisible,
					})),
				);
			const before = rows();
			pane.api.updateParameters({ agentRef: { agentId: "current" } });
			const after = rows();
			expect(before[0]?.agentId).toBe("previous");
			expect(after[0]?.agentId).toBe("current");
			expect(api.getPanel(id)).toBe(pane);
			expect(isAgentPaneMounted("previous", [["one", api]])).toBe(false);
		});
	},
);

it("keeps hidden actual Agent panes represented and mounted even with a neutral identity", () => {
	const panel = api.addPanel({
		id: "opaque-hidden",
		component: "agent",
		params: { agentRef: { agentId: "current" } },
	});
	panel.group.api.setVisible(false);
	const rows = createSpacesPaneProjection()(
		{},
		"one",
		["one"],
		api.panels.map((pane) => ({
			...dockPanelReference(pane),
			isVisible: pane.api.isVisible,
		})),
	);
	expect(rows).toMatchObject([
		{ key: "opaque-hidden", agentId: "current", hidden: true },
	]);
	expect(isAgentPaneMounted("current", [["one", api]])).toBe(true);
});

it("finds a mounted Agent in another Space, but not an absent Agent or an empty registry", () => {
	api.addPanel({
		id: "same-slot",
		component: "agent",
		params: { agentRef: { agentId: "current" } },
	});
	const empty: Pick<DockviewApi, "panels"> = { panels: [] };
	const entries = [
		["one", empty],
		["two", api],
	] as const;
	expect(isAgentPaneMounted("current", entries)).toBe(true);
	expect(isAgentPaneMounted("previous", entries)).toBe(false);
	expect(isAgentPaneMounted("current", [])).toBe(false);
});
