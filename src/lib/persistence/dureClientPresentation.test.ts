import { describe, expect, it } from "vitest";
import {
	buildDureClientPresentation,
	DURE_CLIENT_PRESENTATION_MAX_PANES_PER_SPACE,
	DURE_CLIENT_PRESENTATION_MAX_SPACES,
} from "@/lib/persistence/dureClientPresentation";

describe("Dure client presentation projection", () => {
	it("uses an explicit Agent reference and the current registry binding, not either ID's old runtime", () => {
		const runtimeBinding = {
			runtime: "hmux_managed_v1",
			source: "local",
			hostId: "local",
			workspaceId: "workspace-current",
			sessionId: "session-current",
		};
		const presentation = buildDureClientPresentation({
			spaces: [{ id: "space", name: "Work" }],
			layouts: {
				space: {
					panels: Object.fromEntries(
						["agent:previous", "pane:opaque"].map((id) => [
							id,
							{
								contentComponent: "agent",
								params: {
									agentRef: { agentId: "current" },
									agentId: "previous",
									binding: { ...runtimeBinding, sessionId: "copied-session" },
								},
							},
						]),
					),
				},
			},
			agents: [
				{ id: "current", runtimeBinding },
				{
					id: "previous",
					runtimeBinding: { ...runtimeBinding, sessionId: "previous-session" },
				},
			],
		});
		for (const pane of presentation.spaces[0].panes) {
			expect(pane).toMatchObject({
				type: "agent",
				agentId: "current",
				binding: runtimeBinding,
			});
		}
	});

	it("projects current content without retargeting from a stale ID prefix", () => {
		const binding = {
			runtime: "hmux_standalone_v1",
			source: "local",
			hostId: "local",
			workspaceId: "workspace-current",
			sessionId: "session-current",
		};
		const presentation = buildDureClientPresentation({
			spaces: [{ id: "space-1", name: "Work" }],
			layouts: {
				"space-1": {
					panels: {
						"agent:old": { contentComponent: "terminal", params: { binding } },
						"term:old": { contentComponent: "launcher", params: { binding } },
						"ssh:old": { contentComponent: "browser", params: { binding } },
						"pane:opaque": { contentComponent: "ssh", params: { binding } },
						"agent:unresolved": {
							contentComponent: "extension-view",
							params: { binding },
						},
					},
				},
			},
			agents: [
				{
					id: "old",
					runtimeBinding: { ...binding, sessionId: "previous-agent-session" },
				},
			],
		});
		expect(
			presentation.spaces[0].panes.map(
				({ id, type, agentId, binding: target }) => ({
					id,
					type,
					agentId,
					sessionId: target?.sessionId ?? null,
				}),
			),
		).toEqual([
			{
				id: "agent:old",
				type: "terminal",
				agentId: null,
				sessionId: "session-current",
			},
			{ id: "term:old", type: "other", agentId: null, sessionId: null },
			{ id: "ssh:old", type: "browser", agentId: null, sessionId: null },
			{
				id: "pane:opaque",
				type: "remote_terminal",
				agentId: null,
				sessionId: "session-current",
			},
			{ id: "agent:unresolved", type: "other", agentId: null, sessionId: null },
		]);
	});

	it("projects real client spaces and multiple pane views without focus or secrets", () => {
		const binding = {
			runtime: "hmux_managed_v1",
			source: "ssh",
			hostId: "remote-build",
			workspaceId: "workspace-1",
			sessionId: "session-1",
			credentialId: "must-not-project",
		};
		const presentation = buildDureClientPresentation({
			spaces: [
				{ id: "desktop-a", name: "A" },
				{ id: "desktop-b", name: "B", kind: "popout" },
			],
			layouts: {
				"desktop-a": {
					focusedPane: "agent:agent-1",
					panels: {
						"agent:agent-1": {
							contentComponent: "agent",
							params: { agentId: "agent-1", prompt: "secret prompt" },
						},
						"browser:docs": {
							contentComponent: "browser",
							params: { url: "https://private.example.test" },
						},
					},
				},
				"desktop-b": {
					panels: {
						"term:second-view": {
							contentComponent: "terminal",
							params: { binding },
						},
					},
				},
			},
			agents: [{ id: "agent-1", runtimeBinding: binding }],
		});

		expect(presentation).toMatchObject({
			schemaVersion: 3,
			complete: true,
			spaces: [
				{
					id: "desktop-a",
					kind: "desktop",
					windowLabel: "main",
					panes: [
						{
							id: "agent:agent-1",
							type: "agent",
							agentId: "agent-1",
							binding: {
								source: "ssh",
								workspaceId: "workspace-1",
								sessionId: "session-1",
							},
						},
						{ id: "browser:docs", type: "browser", binding: null },
					],
				},
				{
					id: "desktop-b",
					kind: "popout",
					windowLabel: "win-popout-desktop-b",
					panes: [
						{
							id: "term:second-view",
							type: "terminal",
							binding: { sessionId: "session-1" },
						},
					],
				},
			],
		});
		const encoded = JSON.stringify(presentation);
		expect(encoded).not.toContain("focusedPane");
		expect(encoded).not.toContain("secret prompt");
		expect(encoded).not.toContain("private.example.test");
		expect(encoded).not.toContain("must-not-project");
	});

	it("never reconstructs an Agent runtime from stale pane parameters", () => {
		const presentation = buildDureClientPresentation({
			spaces: [{ id: "desktop-a", name: "A" }],
			layouts: {
				"desktop-a": {
					panels: {
						"agent:missing": {
							contentComponent: "agent",
							params: {
								agentId: "missing",
								binding: {
									runtime: "hmux_managed_v1",
									source: "local",
									hostId: "local",
									workspaceId: "stale-workspace",
									sessionId: "stale-session",
								},
							},
						},
					},
				},
			},
			agents: [],
		});

		expect(presentation.spaces[0]?.panes[0]).toMatchObject({
			type: "agent",
			agentId: "missing",
			binding: null,
		});
	});

	it("uses the canonical Agent panel id when stale parameters name another Agent", () => {
		const presentation = buildDureClientPresentation({
			spaces: [{ id: "desktop-a", name: "A" }],
			layouts: {
				"desktop-a": {
					panels: {
						"agent:canonical": {
							contentComponent: "agent",
							params: { agentId: "stale" },
						},
					},
				},
			},
			agents: [
				{
					id: "canonical",
					runtimeBinding: {
						runtime: "hmux_managed_v1",
						source: "local",
						hostId: "local",
						workspaceId: "canonical-workspace",
						sessionId: "canonical-session",
					},
				},
				{
					id: "stale",
					runtimeBinding: {
						runtime: "hmux_managed_v1",
						source: "local",
						hostId: "local",
						workspaceId: "stale-workspace",
						sessionId: "stale-session",
					},
				},
			],
		});

		expect(presentation.spaces[0]?.panes[0]).toMatchObject({
			type: "agent",
			agentId: "canonical",
			binding: {
				workspaceId: "canonical-workspace",
				sessionId: "canonical-session",
			},
		});
	});

	it("publishes deterministic truncation instead of unbounded layout state", () => {
		const desktopCount = DURE_CLIENT_PRESENTATION_MAX_SPACES + 1;
		const paneCount = DURE_CLIENT_PRESENTATION_MAX_PANES_PER_SPACE + 1;
		const presentation = buildDureClientPresentation({
			spaces: Array.from({ length: desktopCount }, (_, index) => ({
				id: `desktop-${index}`,
				name: `Desktop ${index}`,
			})),
			layouts: Object.fromEntries(
				Array.from({ length: desktopCount }, (_, desktopIndex) => [
					`desktop-${desktopIndex}`,
					{
						panels: Object.fromEntries(
							Array.from({ length: paneCount }, (_, paneIndex) => [
								`term:${desktopIndex}-${paneIndex}`,
								{ contentComponent: "terminal", params: {} },
							]),
						),
					},
				]),
			),
			agents: [],
		});

		expect(presentation.complete).toBe(false);
		expect(presentation.spaces).toHaveLength(
			DURE_CLIENT_PRESENTATION_MAX_SPACES,
		);
		expect(presentation.spaces[0].panes).toHaveLength(
			DURE_CLIENT_PRESENTATION_MAX_PANES_PER_SPACE,
		);
		expect(presentation.truncation).toMatchObject({
			spaces: true,
			panes: true,
		});
	});
});

describe("saved pane titles", () => {
	it("publishes only bounded saved titles in durable pane order", () => {
		const projection = buildDureClientPresentation({
			spaces: [{ id: "desk-a", name: "Review" }],
			agents: [],
			layouts: {
				"desk-a": {
					panels: {
						"term:z": {
							contentComponent: "terminal",
							title: "Build logs",
							params: { title: "private parameter", token: "private token" },
						},
						"term:a": {
							contentComponent: "terminal",
							title: "Review terminal",
						},
						"term:none": { contentComponent: "terminal" },
						"term:invalid": {
							contentComponent: "terminal",
							title: "unsafe\nlabel",
						},
						"term:large": {
							contentComponent: "terminal",
							title: "x".repeat(257),
						},
					},
				},
			},
		});
		expect(
			projection.spaces[0]?.panes.map(({ id, title }) => ({ id, title })),
		).toEqual([
			{ id: "term:z", title: "Build logs" },
			{ id: "term:a", title: "Review terminal" },
			{ id: "term:none", title: null },
			{ id: "term:invalid", title: null },
			{ id: "term:large", title: null },
		]);
		expect(JSON.stringify(projection)).not.toContain("private");
	});
});
