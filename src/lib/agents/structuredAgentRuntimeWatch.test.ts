// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentAttention } from "@/lib/agents/agentAttentionStore";
import { installAgentAttentionWatch } from "@/lib/agents/agentAttentionWatch";
import {
	installStructuredAgentRuntimeWatch,
	type SubscribeDureAgentActivity,
	structuredAgentRuntimeRetryDelayMs,
} from "@/lib/agents/structuredAgentRuntimeWatch";
import type {
	DureAgentActivityEventV1,
	DureAgentActivityV1,
} from "@/lib/ipc/dureAgentActivity";
import { DureBackendRequestError } from "@/lib/ipc/dureBackend";
import { useStore } from "@/store";
import { agentFixture } from "@/test/agentFixtures";
import type { Agent } from "@/types";

const chatAgent = (id: string, backendProfileId = "local"): Agent =>
	agentFixture({
		id,
		name: id,
		sessionId: `session-${id}`,
		interactionProfile: {
			schemaVersion: 1,
			kind: "structured_protocol",
			backendProfileId,
			interactionSessionId: `interaction-${id}`,
		},
	});

const reading = (
	agentId: string,
	patch: Partial<DureAgentActivityV1> = {},
): DureAgentActivityV1 => ({
	agentId,
	interactionSessionId: `interaction-${agentId}`,
	lifecycle: "running",
	activity: "working",
	attention: "none",
	timelineEpoch: "timeline-1",
	turnCompletedSequence: "0",
	...patch,
});

interface FakeSubscription {
	profileId: string;
	closed: boolean;
	emit(event: DureAgentActivityEventV1): void;
}

function fakeBackends(options?: { refuse?: Set<string> }) {
	const subscriptions: FakeSubscription[] = [];
	const snapshots = new Map<string, DureAgentActivityV1[]>();
	const subscribe: SubscribeDureAgentActivity = vi.fn(
		async (profileId, onEvent) => {
			if (options?.refuse?.has(profileId)) return null;
			const subscription: FakeSubscription = {
				profileId,
				closed: false,
				emit: (event) => {
					if (!subscription.closed) onEvent(event);
				},
			};
			subscriptions.push(subscription);
			onEvent({ kind: "snapshot", agents: snapshots.get(profileId) ?? [] });
			return {
				backend: { id: `backend-${profileId}`, generation: "generation-1" },
				close: vi.fn(async () => {
					subscription.closed = true;
				}),
			};
		},
	);
	return { subscribe, subscriptions, snapshots };
}

async function flush(): Promise<void> {
	for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

const display = (agentId: string) =>
	useAgentAttention.getState().displayStates[agentId];
const episodeKind = (agentId: string) =>
	useAgentAttention.getState().episodeKinds[agentId];
const episodes = (agentId: string) =>
	useAgentAttention.getState().episodes[agentId] ?? 0;

const cleanups: Array<() => void> = [];
const install = (stop: () => void) => {
	cleanups.push(stop);
	return stop;
};

beforeEach(() => {
	vi.useFakeTimers();
	useStore.setState({
		agents: [],
		agentActivity: {},
		sessionAgentRuntimeState: {},
		sessionAgentRuntimeObservers: {},
		structuredAgentRuntimeTiers: {},
		hmuxSessionMetadata: {},
	});
	useAgentAttention.setState({
		episodes: {},
		acks: {},
		episodeKinds: {},
		episodeIds: {},
		episodeAt: {},
		waitingSince: {},
		displayStates: {},
		armedCompletions: {},
	});
});

afterEach(() => {
	for (const stop of cleanups.splice(0).reverse()) stop();
	vi.useRealTimers();
	useStore.setState({ agents: [], structuredAgentRuntimeTiers: {} });
});

describe("installStructuredAgentRuntimeWatch", () => {
	it("shows a paneless chat Agent's approval, input, error and finished turns from its backend", async () => {
		const backends = fakeBackends();
		backends.snapshots.set("local", [reading("worker")]);
		useStore.setState({ agents: [chatAgent("worker")] });
		install(installAgentAttentionWatch());
		install(installStructuredAgentRuntimeWatch(backends.subscribe));
		await flush();
		expect(display("worker")).toBe("working");

		const [backend] = backends.subscriptions;
		backend.emit({
			kind: "changes",
			changes: [
				reading("worker", {
					activity: "waiting",
					attention: "approval_required",
					attentionId: "permission-1",
				}),
			],
			removed: [],
		});
		expect(display("worker")).toBe("blocked");
		expect(episodeKind("worker")).toBe("approval");
		expect(useAgentAttention.getState().episodeIds.worker).toBe(
			"hmux:session-worker:interaction-worker:timeline-1:attention:permission-1",
		);

		// Answered, the turn works on, then asks a question.
		backend.emit({
			kind: "changes",
			changes: [reading("worker")],
			removed: [],
		});
		expect(display("worker")).toBe("working");

		backend.emit({
			kind: "changes",
			changes: [
				reading("worker", {
					activity: "waiting",
					attention: "input_required",
					attentionId: "question-2",
				}),
			],
			removed: [],
		});
		expect(display("worker")).toBe("input");
		expect(episodeKind("worker")).toBe("input");

		const before = episodes("worker");
		backend.emit({
			kind: "changes",
			changes: [
				reading("worker", { activity: "waiting", turnCompletedSequence: "9" }),
			],
			removed: [],
		});
		expect(display("worker")).toBe("waiting");
		expect(episodes("worker")).toBe(before + 1);
		expect(episodeKind("worker")).toBe("done");

		backend.emit({
			kind: "changes",
			changes: [
				reading("worker", {
					activity: "waiting",
					attention: "error",
					attentionId: "failed-3",
					turnCompletedSequence: "9",
				}),
			],
			removed: [],
		});
		expect(display("worker")).toBe("error");

		backend.emit({
			kind: "changes",
			changes: [
				reading("worker", {
					lifecycle: "exited",
					activity: "waiting",
					turnCompletedSequence: "9",
				}),
			],
			removed: [],
		});
		expect(display("worker")).toBe("exited");
	});

	it("reads unknown when the subscription ends, and resubscribes without a second episode", async () => {
		const backends = fakeBackends();
		backends.snapshots.set("local", [
			reading("worker", { activity: "waiting", turnCompletedSequence: "4" }),
		]);
		useStore.setState({ agents: [chatAgent("worker")] });
		install(installAgentAttentionWatch());
		install(installStructuredAgentRuntimeWatch(backends.subscribe));
		await flush();
		expect(display("worker")).toBe("waiting");

		backends.subscriptions[0].emit({
			kind: "error",
			error: new DureBackendRequestError("backend_unreachable", "gone", {
				kind: "transport",
			}),
		});
		expect(backends.subscriptions[0].closed).toBe(true);
		expect(useStore.getState().structuredAgentRuntimeTiers).toEqual({});
		expect(display("worker")).toBe("unknown");

		await vi.advanceTimersByTimeAsync(structuredAgentRuntimeRetryDelayMs(0));
		await flush();
		expect(backends.subscriptions).toHaveLength(2);
		expect(display("worker")).toBe("waiting");
		// The same finished turn, read again after the gap, is not a new one.
		expect(episodes("worker")).toBe(0);
	});

	it("keeps an older backend's chat Agents unknown without a pane, as today with one, and asks again later", async () => {
		const backends = fakeBackends({ refuse: new Set(["local"]) });
		useStore.setState({
			agents: [chatAgent("paneless"), chatAgent("paned")],
			agentActivity: { paned: "working" },
		});
		install(installAgentAttentionWatch());
		install(installStructuredAgentRuntimeWatch(backends.subscribe));
		await flush();
		expect(display("paneless")).toBe("unknown");
		expect(display("paned")).toBe("working");
		expect(backends.subscribe).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(structuredAgentRuntimeRetryDelayMs(0));
		await flush();
		expect(backends.subscribe).toHaveBeenCalledTimes(2);
		// Backing off: the next ask waits twice as long.
		await vi.advanceTimersByTimeAsync(structuredAgentRuntimeRetryDelayMs(0));
		await flush();
		expect(backends.subscribe).toHaveBeenCalledTimes(2);
	});

	it("holds one subscription per backend that hosts chat Agents, and ends it when none is left", async () => {
		const backends = fakeBackends();
		backends.snapshots.set("ssh-build", [reading("remote")]);
		useStore.setState({
			agents: [
				chatAgent("first"),
				chatAgent("second"),
				chatAgent("remote", "ssh-build"),
				agentFixture({ id: "terminal", sessionId: "session-terminal" }),
			],
		});
		const stopTier = install(installStructuredAgentRuntimeWatch(backends.subscribe));
		await flush();
		expect(backends.subscriptions.map((entry) => entry.profileId).sort()).toEqual(
			["local", "ssh-build"],
		);
		expect(
			Object.keys(useStore.getState().structuredAgentRuntimeTiers).sort(),
		).toEqual(["local", "ssh-build"]);

		useStore.setState((state) => ({
			agents: state.agents.filter((agent) => agent.id !== "remote"),
		}));
		const remote = backends.subscriptions.find(
			(entry) => entry.profileId === "ssh-build",
		);
		expect(remote?.closed).toBe(true);
		expect(
			Object.keys(useStore.getState().structuredAgentRuntimeTiers),
		).toEqual(["local"]);

		stopTier();
		expect(backends.subscriptions.every((entry) => entry.closed)).toBe(true);
		expect(useStore.getState().structuredAgentRuntimeTiers).toEqual({});
	});
});
