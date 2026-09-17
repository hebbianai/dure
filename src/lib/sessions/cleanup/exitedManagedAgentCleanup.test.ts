import { describe, expect, it } from "vitest";
import type { HmuxSessionSummary } from "@/lib/ipc";
import {
	absentManagedAgentCleanupEligibleIds,
	planExitedManagedAgentCleanup,
	sameExitedManagedAgentCleanupCandidate,
} from "@/lib/sessions/cleanup/exitedManagedAgentCleanup";
import {
	agentFixture,
	hmuxSessionSummaryFixture,
	managedBindingFixture,
} from "@/test/agentFixtures";
import type { Agent, Project } from "@/types";

const project: Project = {
	id: "project-1",
	name: "Dure",
	path: "/repo",
	kind: "local",
	isRepo: true,
};

function managedAgent(id: string, sessionId: string): Agent {
	return agentFixture({
		id,
		name: id,
		projectId: project.id,
		worktreePath: `/repo/.worktrees/${id}`,
		branch: `agent/${id}`,
		sessionId,
		runtimeBinding: managedBindingFixture({
			sessionId,
			createIdempotencyKey: `create-${id}`,
		}),
	});
}

function summary(
	sessionId: string,
	patch: Partial<HmuxSessionSummary> = {},
): HmuxSessionSummary {
	return hmuxSessionSummaryFixture({
		sessionId,
		sessionName: sessionId,
		manifestLifecycle: "ready",
		inputAllowed: true,
		runtimeHost: "localhost",
		hostBuildVersion: "build-1",
		terminalEpoch: `terminal-${sessionId}`,
		...patch,
	});
}

describe("exited managed Agent cleanup planning", () => {
	it("partitions canonical Agents out of ambient cleanup", () => {
		const canonical = {
			...managedAgent("canonical", "session-canonical"),
			canonicalSpawn: {
				schemaVersion: 1 as const,
				backendProfileId: "local",
				operationId: "spawn-canonical",
			},
		};

		expect(
			absentManagedAgentCleanupEligibleIds({
				agents: [canonical],
				agentActivity: {},
				sessionAgentRuntimeState: {},
			}),
		).toEqual(new Set());
		expect(
			planExitedManagedAgentCleanup({
				agents: [canonical],
				projects: [project],
				sessions: [summary("session-canonical", { lifecycle: "exited" })],
				absentEligibleAgentIds: new Set([canonical.id]),
			}),
		).toEqual({ candidates: [], protectedManagedCount: 0 });
	});

	it("allows a missing registration after restart when no positive runtime evidence remains", () => {
		const absent = managedAgent("absent", "session-absent");

		expect(
			absentManagedAgentCleanupEligibleIds({
				agents: [absent],
				agentActivity: {},
				sessionAgentRuntimeState: {},
			}),
		).toEqual(new Set(["absent"]));
	});

	it("protects missing registrations while activity or runtime evidence is positive", () => {
		const connecting = managedAgent("connecting", "session-connecting");
		const waiting = managedAgent("waiting", "session-waiting");
		const runtimeReady = managedAgent("runtime-ready", "session-runtime-ready");

		expect(
			absentManagedAgentCleanupEligibleIds({
				agents: [connecting, waiting, runtimeReady],
				agentActivity: {
					connecting: "connecting",
					waiting: "waiting",
				},
				sessionAgentRuntimeState: {
					[runtimeReady.sessionId]: {
						terminalEpoch: "terminal-ready",
						revision: "1",
						observedThroughOutputSeq: "1",
						lifecycle: "running",
						activity: "waiting",
						attention: "none",
						source: "process_lifecycle",
					},
				},
			}),
		).toEqual(new Set());
	});

	it("allows absent cleanup when the latest activity or runtime evidence is exited", () => {
		const activityExited = managedAgent(
			"activity-exited",
			"session-activity-exited",
		);
		const runtimeExited = managedAgent(
			"runtime-exited",
			"session-runtime-exited",
		);

		expect(
			absentManagedAgentCleanupEligibleIds({
				agents: [activityExited, runtimeExited],
				agentActivity: {
					"activity-exited": "exited",
				},
				sessionAgentRuntimeState: {
					[runtimeExited.sessionId]: {
						terminalEpoch: "terminal-exited",
						revision: "1",
						observedThroughOutputSeq: "1",
						lifecycle: "exited",
						activity: "waiting",
						attention: "none",
						source: "process_lifecycle",
					},
				},
			}),
		).toEqual(new Set(["activity-exited", "runtime-exited"]));
	});

	it("selects absent and conclusively exited local managed bindings", () => {
		const absent = managedAgent("absent", "session-absent");
		const exited = managedAgent("exited", "session-exited");
		const live = managedAgent("live", "session-live");

		const plan = planExitedManagedAgentCleanup({
			agents: [absent, exited, live],
			projects: [project],
			absentEligibleAgentIds: new Set(["absent"]),
			sessions: [
				summary("session-exited", {
					lifecycle: "exited",
					manifestLifecycle: "exited",
					health: "exited",
					inputAllowed: false,
				}),
				summary("session-live"),
			],
		});

		expect(plan.candidates).toMatchObject([
			{
				agentId: "absent",
				sourceState: "absent",
			},
			{
				agentId: "exited",
				sourceState: "exited",
				terminalEpoch: "terminal-session-exited",
			},
		]);
		expect(plan.protectedManagedCount).toBe(1);
	});

	it("selects an exact stale projection for cleanup while protecting a live generation", () => {
		const stale = managedAgent("stale", "session-stale");
		const live = managedAgent("live", "session-live");
		const legacy: Agent = {
			...managedAgent("legacy", "session-legacy"),
			runtimeBinding: {
				schemaVersion: 1,
				runtime: "legacy_session_v1",
				source: "local",
				hostId: "local",
				sessionId: "session-legacy",
			} as unknown as Agent["runtimeBinding"],
		};
		const plan = planExitedManagedAgentCleanup({
			agents: [stale, live, legacy],
			projects: [project],
			absentEligibleAgentIds: new Set(),
			sessions: [
				summary("session-stale", {
					lifecycle: "unavailable",
					health: "stale_transport",
					inputAllowed: false,
				}),
				summary("session-live"),
			],
		});

		expect(plan.candidates).toMatchObject([
			{
				agentId: "stale",
				sourceState: "stale",
				terminalEpoch: "terminal-session-stale",
			},
		]);
		expect(plan.protectedManagedCount).toBe(1);
	});

	it("protects a replacement generation even when its projection is also stale", () => {
		const stale = managedAgent("stale", "session-stale");
		stale.runtimeBinding = {
			...stale.runtimeBinding,
			stopFence: {
				runnerPrincipal: "runner",
				runnerInstance: "runner-1",
				channelEpoch: "1",
				hostInstanceId: "host-old",
				terminalEpoch: "terminal-old",
			},
		} as Agent["runtimeBinding"];

		const plan = planExitedManagedAgentCleanup({
			agents: [stale],
			projects: [project],
			absentEligibleAgentIds: new Set(),
			sessions: [
				summary("session-stale", {
					lifecycle: "unavailable",
					health: "stale_transport",
					inputAllowed: false,
					terminalEpoch: "terminal-new",
					stopFence: {
						runnerPrincipal: "runner",
						runnerInstance: "runner-2",
						channelEpoch: "2",
						hostInstanceId: "host-new",
						terminalEpoch: "terminal-new",
					},
				}),
			],
		});

		expect(plan.candidates).toEqual([]);
		expect(plan.protectedManagedCount).toBe(1);
	});

	it("fences the persisted Agent binding, not only its display name", () => {
		const [candidate] = planExitedManagedAgentCleanup({
			agents: [managedAgent("absent", "session-absent")],
			projects: [project],
			sessions: [],
			absentEligibleAgentIds: new Set(["absent"]),
		}).candidates;
		if (!candidate) throw new Error("fixture candidate missing");

		expect(sameExitedManagedAgentCleanupCandidate(candidate, candidate)).toBe(
			true,
		);
		expect(
			sameExitedManagedAgentCleanupCandidate(candidate, {
				...candidate,
				binding: { ...candidate.binding, sessionId: "replacement" },
			}),
		).toBe(false);
		expect(
			sameExitedManagedAgentCleanupCandidate(candidate, {
				...candidate,
				binding: {
					...candidate.binding,
					stopFence: {
						runnerPrincipal: "principal-1",
						runnerInstance: "runner-1",
						channelEpoch: "7",
						hostInstanceId: "host-1",
						terminalEpoch: "terminal-new",
					},
				},
			}),
		).toBe(false);
	});

	it("protects a managed registration that is absent while the Agent is still starting", () => {
		const plan = planExitedManagedAgentCleanup({
			agents: [managedAgent("starting", "session-starting")],
			projects: [project],
			sessions: [],
			absentEligibleAgentIds: new Set(),
		});

		expect(plan.candidates).toEqual([]);
		expect(plan.protectedManagedCount).toBe(1);
	});
});
