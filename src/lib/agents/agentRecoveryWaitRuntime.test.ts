import { afterEach, describe, expect, it, vi } from "vitest";
import type { RecoveryWait } from "@/lib/agents/accountRecoveryContract";
import {
	type AgentRecoveryWaitRuntimeDependencies,
	installAgentRecoveryWaitRuntime,
	mergeRecoveryWaits,
	RECOVERY_WAIT_REFRESH_MS,
	recoveryWaitProfiles,
} from "@/lib/agents/agentRecoveryWaitRuntime";
import {
	managedAgentFixture,
	managedBindingFixture,
} from "@/test/agentFixtures";
import type { Agent, Project } from "@/types";

const project: Project = {
	id: "project-1",
	name: "Project",
	path: "/workspace",
	kind: "local",
	isRepo: true,
};

function terminal(id: string, backendProfileId?: string): Agent {
	return managedAgentFixture({
		id,
		provider: "claude",
		projectId: project.id,
		sessionId: `session-${id}`,
		runtimeBinding: managedBindingFixture({
			sessionId: `session-${id}`,
			...(backendProfileId ? { backendProfileId } : {}),
		}),
	});
}

function chat(id: string, backendProfileId: string): Agent {
	return {
		...terminal(id),
		runtimeBinding: undefined,
		interactionProfile: {
			schemaVersion: 1,
			kind: "structured_protocol",
			backendProfileId,
			interactionSessionId: `interaction-${id}`,
		},
	};
}

function wait(agentId: string, resumeAtMs: number): RecoveryWait {
	return { agentId, attemptId: `recovery-${agentId}`, resumeAtMs };
}

function last<T>(values: readonly T[]): T | undefined {
	return values[values.length - 1];
}

async function settle(): Promise<void> {
	for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

afterEach(() => {
	vi.useRealTimers();
});

describe("recovery waits", () => {
	it("reads each backend that owns an Agent recovery can continue, once", () => {
		const state = {
			agents: [
				terminal("a"),
				terminal("b"),
				chat("c", "team"),
				// A provider without backend runtimes has no route to read.
				{ ...terminal("d"), provider: "gemini" as const },
			],
			projects: [project],
		};
		expect(recoveryWaitProfiles(state)).toEqual(["local", "team"]);
	});

	it("takes a wait only from the backend that owns its Agent", () => {
		const state = {
			agents: [terminal("a"), chat("c", "team")],
			projects: [project],
		};
		expect(
			mergeRecoveryWaits(
				state,
				new Map([
					["local", [wait("a", 10), wait("c", 20)]],
					["team", [wait("c", 30), wait("unknown", 40)]],
				]),
			),
		).toEqual({ a: 10, c: 30 });
	});
});

describe("installAgentRecoveryWaitRuntime", () => {
	function harness(initial: { agents: Agent[]; projects: Project[] }) {
		let state = initial;
		const listeners = new Set<() => void>();
		const published: Record<string, number>[] = [];
		const readWaits = vi.fn<(profileId: string) => Promise<RecoveryWait[]>>();
		const deps: AgentRecoveryWaitRuntimeDependencies = {
			readState: () => state,
			subscribe: (listener) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			readWaits,
			publish: (waits) => published.push(waits),
			setInterval: (listener, ms) => setInterval(listener, ms),
			clearInterval: (timer) => clearInterval(timer),
		};
		return {
			deps,
			readWaits,
			published,
			change(next: typeof initial) {
				state = next;
				for (const listener of listeners) listener();
			},
		};
	}

	it("publishes every backend's waits and follows them as they end", async () => {
		vi.useFakeTimers();
		const run = harness({
			agents: [terminal("a"), chat("c", "team")],
			projects: [project],
		});
		run.readWaits.mockImplementation(async (profileId) =>
			profileId === "local" ? [wait("a", 10)] : [wait("c", 30)],
		);
		const stop = installAgentRecoveryWaitRuntime(run.deps);
		await settle();
		expect(last(run.published)).toEqual({ a: 10, c: 30 });
		// The local wait ended (continued, or a person answered first).
		run.readWaits.mockImplementation(async (profileId) =>
			profileId === "local" ? [] : [wait("c", 30)],
		);
		await vi.advanceTimersByTimeAsync(RECOVERY_WAIT_REFRESH_MS);
		expect(last(run.published)).toEqual({ c: 30 });
		stop();
		expect(last(run.published)).toEqual({});
		run.readWaits.mockClear();
		await vi.advanceTimersByTimeAsync(RECOVERY_WAIT_REFRESH_MS);
		expect(run.readWaits).not.toHaveBeenCalled();
	});

	it("shows no wait from a backend it cannot read", async () => {
		const run = harness({ agents: [terminal("a")], projects: [project] });
		run.readWaits.mockResolvedValueOnce([wait("a", 10)]);
		const stop = installAgentRecoveryWaitRuntime(run.deps);
		await settle();
		expect(last(run.published)).toEqual({ a: 10 });
		// The local backend becomes unreachable; a second backend predates
		// the list and fails with its capability.
		run.readWaits.mockImplementation(async (profileId) => {
			throw new Error(
				profileId === "team" ? "capability_missing" : "unreachable",
			);
		});
		run.change({
			agents: [terminal("a"), chat("c", "team")],
			projects: [project],
		});
		await settle();
		expect(last(run.published)).toEqual({});
		expect(run.readWaits).toHaveBeenCalledTimes(3);
		stop();
	});

	it("reads again only when an Agent brings a backend it has not read", async () => {
		const run = harness({ agents: [terminal("a")], projects: [project] });
		run.readWaits.mockResolvedValue([wait("a", 10), wait("b", 20)]);
		const stop = installAgentRecoveryWaitRuntime(run.deps);
		await settle();
		expect(run.readWaits).toHaveBeenCalledTimes(1);
		// Another Agent on the same backend merges the list in hand.
		run.change({ agents: [terminal("a"), terminal("b")], projects: [project] });
		await settle();
		expect(run.readWaits).toHaveBeenCalledTimes(1);
		expect(last(run.published)).toEqual({ a: 10, b: 20 });
		run.change({
			agents: [terminal("a"), terminal("b"), chat("c", "team")],
			projects: [project],
		});
		await settle();
		expect(run.readWaits.mock.calls.map(([profileId]) => profileId)).toEqual([
			"local",
			"local",
			"team",
		]);
		stop();
	});
});
