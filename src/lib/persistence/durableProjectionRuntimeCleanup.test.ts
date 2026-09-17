import { describe, expect, it, vi } from "vitest";
import {
	durableProjectionReferences,
	rehydrateDurableProjectionRuntime,
	removedDurableProjectionReferences,
} from "@/lib/persistence/durableProjectionRuntimeCleanup";
import { agentFixture } from "@/test/agentFixtures";

describe("durable projection references", () => {
	it("reports replaced Agent registrations and references that disappeared", () => {
		const source = agentFixture({
			id: "agent-1",
			projectId: "project-1",
			sessionId: "session-old",
		});
		const successor = { ...source, sessionId: "session-new" };
		const project = {
			id: "project-1",
			name: "Project",
			path: "/repo",
			kind: "local" as const,
			isRepo: true,
		};
		const removedProject = {
			...project,
			id: "project-removed",
			name: "Removed",
		};
		const previous = durableProjectionReferences({
			agents: [source],
			projects: [project, removedProject],
			sshHosts: [],
			layouts: {},
		});
		const current = durableProjectionReferences({
			agents: [successor],
			projects: [project],
			sshHosts: [],
			layouts: {},
		});

		const removed = removedDurableProjectionReferences(previous, current);
		expect([...removed.agentIds]).toEqual([source.id]);
		expect([...removed.projectIds]).toEqual(["project-removed"]);
		expect([...removed.sessionIds]).toEqual(["session-old"]);
	});

	it("captures the old realm before rehydrate and reports departed identities", async () => {
		const source = agentFixture({
			id: "agent-removed",
			projectId: "project-removed",
			sessionId: "session-removed",
		});
		const project = {
			id: source.projectId,
			name: "Project",
			path: "/repo",
			kind: "local" as const,
			isRepo: true,
		};
		let state = {
			agents: [source],
			projects: [project],
			sshHosts: [],
			layouts: {},
		};
		const remove = vi.fn();

		await rehydrateDurableProjectionRuntime({
			current: () => state,
			rehydrate: async () => {
				state = { agents: [], projects: [], sshHosts: [], layouts: {} };
			},
			remove,
		});

		expect(remove).toHaveBeenCalledOnce();
		const [removed] = remove.mock.calls[0] ?? [];
		expect([...removed.agentIds]).toEqual([source.id]);
		expect([...removed.projectIds]).toEqual([source.projectId]);
		expect([...removed.sessionIds]).toEqual([source.sessionId]);
	});

	it("cleans transaction-reported references absent from both local projections", async () => {
		const state = { agents: [], projects: [], sshHosts: [], layouts: {} };
		const remove = vi.fn();

		await rehydrateDurableProjectionRuntime({
			current: () => state,
			rehydrate: async () => {},
			additionalDepartures: {
				agentIds: new Set(["agent-removed"]),
				projectIds: new Set(["project-removed"]),
				sessionIds: new Set(["session-removed"]),
			},
			remove,
		});

		expect(remove).toHaveBeenCalledOnce();
		expect(remove.mock.calls[0]?.[0]).toMatchObject({
			agentIds: new Set(["agent-removed"]),
			projectIds: new Set(["project-removed"]),
			sessionIds: new Set(["session-removed"]),
		});
	});

	it("requires projection when a removed host retargets a pane in place", () => {
		const host = {
			id: "host-1",
			name: "Host",
			host: "host.example.test",
			port: 22,
			user: "dure",
			auth: "auto" as const,
		};
		const previous = durableProjectionReferences({
			agents: [],
			projects: [],
			sshHosts: [host],
			layouts: {
				"space-1": {
					panels: {
						"ssh:shared": {
							id: "ssh:shared",
							params: { hostId: host.id, sessionId: "session-1" },
						},
					},
				},
			},
		});
		const current = durableProjectionReferences({
			agents: [],
			projects: [],
			sshHosts: [],
			layouts: {
				"space-1": {
					panels: {
						"ssh:shared": {
							id: "ssh:shared",
							params: { sessionId: "session-local" },
						},
					},
				},
			},
		});

		const departed = removedDurableProjectionReferences(previous, current);
		expect(departed.paneOccurrences.size).toBe(0);
		expect([...departed.projectionSpaceIds]).toEqual(["space-1"]);
	});

	it("requires projection when rehydrate adds an Agent and its pane", () => {
		const added = agentFixture({
			id: "agent-added",
			projectId: "project-1",
			sessionId: "session-added",
		});
		const previous = durableProjectionReferences({
			agents: [],
			projects: [],
			sshHosts: [],
			layouts: { "space-1": { panels: {} } },
		});
		const current = durableProjectionReferences({
			agents: [added],
			projects: [],
			sshHosts: [],
			layouts: {
				"space-1": {
					panels: {
						[`agent:${added.id}`]: {
							id: `agent:${added.id}`,
							params: {},
						},
					},
				},
			},
		});

		const changed = removedDurableProjectionReferences(previous, current);

		expect(changed.agentIds.size).toBe(0);
		expect([...changed.projectionSpaceIds]).toEqual(["space-1"]);
	});

	it("requires projection when only the durable layout revision changes", () => {
		const previous = durableProjectionReferences({
			agents: [],
			projects: [],
			sshHosts: [],
			layouts: { "space-1": { panels: {} } },
		});
		const current = durableProjectionReferences({
			agents: [],
			projects: [],
			sshHosts: [],
			layouts: {
				"space-1": {
					panels: {
						"file:added": { id: "file:added", params: {} },
					},
				},
			},
		});

		const changed = removedDurableProjectionReferences(previous, current);

		expect(changed.paneOccurrences.size).toBe(0);
		expect([...changed.projectionSpaceIds]).toEqual(["space-1"]);
	});
});
