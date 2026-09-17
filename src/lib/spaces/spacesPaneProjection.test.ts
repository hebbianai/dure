import { describe, expect, it } from "vitest";
import { createSpacesPaneProjection } from "./spacesPaneProjection";

const order = ["one", "two"];
const binding = (workspaceId: string) => ({
	runtime: "hmux_standalone_v1",
	workspaceId,
	sessionId: "host-session",
});
const params = (workspaceId: string) => ({
	sessionId: "adapter-session",
	cwd: "/repo",
	binding: binding(workspaceId),
});

describe("Spaces pane projection", () => {
	it("retains pane and nested identity references across geometry snapshots while preserving rebinding", () => {
		const project = createSpacesPaneProjection();
		const layout = (width: number, workspaceId = "workspace") => ({
			one: {
				grid: { width },
				panels: {
					"term:one": {
						contentComponent: "terminal",
						params: params(workspaceId),
					},
				},
			},
		});
		const first = project(layout(1000), "one", order, undefined);
		expect(first[0]?.hmuxIdentity).toEqual(binding("workspace"));
		expect(project(layout(1200), "one", order, undefined)).toBe(first);
		const next = project(layout(1200, "replacement"), "one", order, undefined);
		expect(next).not.toBe(first);
		expect(next[0]?.hmuxIdentity?.workspaceId).toBe("replacement");
		expect(project({}, "one", order, undefined)).toEqual([]);
	});

	it("reads live parameter replacements and visibility before persistence, then falls back on unmount", () => {
		const project = createSpacesPaneProjection();
		const layouts = {
			one: {
				panels: {
					"term:saved": {
						contentComponent: "terminal",
						params: { sessionId: "saved" },
					},
				},
			},
		};
		const live = [
			{ id: "agent:a", component: "agent", params: { agentRef: { agentId: "a" } }, isVisible: true },
			{
				id: "term:live",
				component: "terminal",
				params: params("one"),
				isVisible: true,
			},
		];
		const first = project(layouts, "one", order, live);
		expect(first.map((pane) => pane.key)).toEqual(["agent:a", "term:live"]);
		expect(
			project(
				layouts,
				"one",
				order,
				live.map((pane) => ({ ...pane })),
			),
		).toBe(first);
		const changed = project(layouts, "one", order, [
			{ ...live[0], isVisible: false },
			{ ...live[1], params: params("two") },
		]);
		expect(changed[0]?.hidden).toBe(true);
		expect(changed[1]?.hmuxIdentity?.workspaceId).toBe("two");
		expect(project(layouts, "one", order, []).length).toBe(0);
		expect(
			project(layouts, "one", order, undefined).map((pane) => pane.key),
		).toEqual(["term:saved"]);
	});

	it("keeps desktop and pane order and suppresses duplicate pane identities", () => {
		const project = createSpacesPaneProjection();
		const layouts = {
			one: {
				panels: {
					"term:a": {
						contentComponent: "terminal",
						params: { sessionId: "a" },
					},
					"term:b": {
						contentComponent: "terminal",
						params: { sessionId: "b" },
					},
				},
			},
			two: {
				panels: {
					"term:a": {
						contentComponent: "terminal",
						params: { sessionId: "a" },
					},
					"term:c": {
						contentComponent: "terminal",
						params: { sessionId: "c" },
					},
				},
			},
		};
		const first = project(layouts, "one", order, undefined);
		expect(first.map((pane) => [pane.key, pane.desktopId])).toEqual([
			["term:a", "one"],
			["term:b", "one"],
			["term:c", "two"],
		]);
		const reordered = project(layouts, "two", ["two", "one"], undefined);
		expect(reordered.map((pane) => [pane.key, pane.desktopId])).toEqual([
			["term:a", "two"],
			["term:c", "two"],
			["term:b", "one"],
		]);
	});
});
