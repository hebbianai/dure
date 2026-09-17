import { describe, expect, it } from "vitest";
import {
	applyClientViewLayout,
	projectClientViewLayout,
	selectedPaneFromLayout,
	sessionIdForClientViewPane,
	validClientViewToken,
} from "@/lib/workspace/clientViewLayout";
import { agentFixture } from "@/test/agentFixtures";

function layout() {
	return {
		grid: {
			root: {
				type: "branch",
				data: [
					{
						type: "leaf",
						size: 300,
						data: { id: "left", views: ["term:a"], activeView: "term:a" },
					},
					{
						type: "leaf",
						size: 700,
						data: { id: "right", views: ["term:b"], activeView: "term:b" },
					},
				],
			},
			width: 1000,
			height: 800,
			orientation: "HORIZONTAL",
		},
		activeGroup: "right",
		panels: {
			"term:a": {
				contentComponent: "terminal",
				params: { sessionId: "session-a", secret: "never-project" },
			},
			"term:b": {
				contentComponent: "terminal",
				params: { binding: { sessionId: "session-b", credentialId: "secret" } },
			},
		},
	};
}

describe("client view layout projection", () => {
	it("follows the explicit Agent target through native and Chat snapshots without copying a session", () => {
		const value = {
			panels: {
				"pane:opaque": {
					contentComponent: "agent",
					params: {
						agentRef: { agentId: "current" },
						sessionId: "copied-session",
					},
				},
			},
		};
		const agent = agentFixture({ id: "current", sessionId: "current-session" });
		expect(sessionIdForClientViewPane(value, "pane:opaque", [agent])).toBe(
			"current-session",
		);
		expect(
			sessionIdForClientViewPane(value, "pane:opaque", [
				{
					...agent,
					interactionProfile: {
						schemaVersion: 1,
						kind: "structured_protocol",
						backendProfileId: "local",
						interactionSessionId: "current-chat",
					},
				},
			]),
		).toBe("current-chat");
		expect(sessionIdForClientViewPane(value, "pane:opaque", [])).toBeNull();
	});

	it("does not let a historical prefix or copied session override the current content", () => {
		const value = {
			panels: {
				"agent:old": {
					contentComponent: "terminal",
					params: { sessionId: "terminal-session" },
				},
				"term:old": {
					contentComponent: "launcher",
					params: { sessionId: "stale-session" },
				},
				"agent:unresolved": {
					contentComponent: "agent",
					params: { agentRef: null, sessionId: "stale-session" },
				},
			},
		};
		expect(
			sessionIdForClientViewPane(value, "agent:old", [
				agentFixture({ id: "old" }),
			]),
		).toBe("terminal-session");
		expect(sessionIdForClientViewPane(value, "term:old")).toBeNull();
		expect(
			sessionIdForClientViewPane(value, "agent:unresolved", [
				agentFixture({ id: "unresolved" }),
			]),
		).toBeNull();
	});
	it("projects bounded pane geometry and selection without pane parameters", () => {
		const value = layout();
		expect(projectClientViewLayout(value)).toEqual([
			{ paneId: "term:a", groupId: "left", order: 0, sizeBasisPoints: 3000 },
			{ paneId: "term:b", groupId: "right", order: 0, sizeBasisPoints: 7000 },
		]);
		expect(selectedPaneFromLayout(value)).toBe("term:b");
		expect(sessionIdForClientViewPane(value, "term:a")).toBe("session-a");
		expect(sessionIdForClientViewPane(value, "term:b")).toBe("session-b");
		expect(JSON.stringify(projectClientViewLayout(value))).not.toContain(
			"secret",
		);
	});

	it("resolves an Agent session from the canonical panel id with empty params", () => {
		const value = layout();
		value.grid.root.data[1].data.views = ["agent:agent-b"];
		value.grid.root.data[1].data.activeView = "agent:agent-b";
		(
			value.panels as Record<
				string,
				{ contentComponent: string; params: Record<string, unknown> }
			>
		)["agent:agent-b"] = { contentComponent: "agent", params: {} };
		const agent = agentFixture({ id: "agent-b", sessionId: "session-agent-b" });

		expect(sessionIdForClientViewPane(value, "agent:agent-b", [agent])).toBe(
			"session-agent-b",
		);
		expect(
			sessionIdForClientViewPane(value, "agent:agent-b", [
				{
					...agent,
					sessionId: "stale",
					interactionProfile: {
						schemaVersion: 1,
						kind: "structured_protocol",
						backendProfileId: "local",
						interactionSessionId: "interaction-agent-b",
					},
				},
			]),
		).toBe("interaction-agent-b");
	});

	it("applies size changes only when the exact topology is unchanged", () => {
		const value = layout();
		const result = applyClientViewLayout(value, [
			{ paneId: "term:a", groupId: "left", order: 0, sizeBasisPoints: 6000 },
			{ paneId: "term:b", groupId: "right", order: 0, sizeBasisPoints: 4000 },
		]);
		expect(result.status).toBe("applied");
		expect(
			(
				result.layout as { grid: { root: { data: { size: number }[] } } }
			).grid.root.data.map((node) => node.size),
		).toEqual([600, 400]);
		expect(value.grid.root.data.map((node) => node.size)).toEqual([300, 700]);
	});

	it("refuses missing, moved, duplicate, and empty remote topology", () => {
		const value = layout();
		for (const slots of [
			[],
			[
				{
					paneId: "term:a",
					groupId: "left",
					order: 0,
					sizeBasisPoints: 10_000,
				},
			],
			[
				{ paneId: "term:a", groupId: "right", order: 0, sizeBasisPoints: 5000 },
				{ paneId: "term:b", groupId: "left", order: 0, sizeBasisPoints: 5000 },
			],
			[
				{ paneId: "term:a", groupId: "left", order: 0, sizeBasisPoints: 5000 },
				{ paneId: "term:a", groupId: "right", order: 0, sizeBasisPoints: 5000 },
			],
		]) {
			expect(applyClientViewLayout(value, slots).status).toBe(
				"topology_mismatch",
			);
		}
	});

	it("bounds UTF-8 tokens and refuses duplicate local identities", () => {
		expect(validClientViewToken("가".repeat(170))).toBe(true);
		expect(validClientViewToken("가".repeat(171))).toBe(false);
		const duplicateGroup = layout();
		duplicateGroup.grid.root.data[1].data.id = "left";
		expect(projectClientViewLayout(duplicateGroup)).toEqual([]);
		const duplicatePane = layout();
		duplicatePane.grid.root.data[1].data.views = ["term:a"];
		expect(projectClientViewLayout(duplicatePane)).toEqual([]);
	});
});
